import { EventEmitter } from 'events'
import { Client, type ConnectConfig, type ClientChannel } from 'ssh2'
import { v4 as uuidv4 } from 'uuid'
import { SFTPFile, sortSftpFiles } from '../shared/sftp-file'

// Shell-escape a string for use inside double quotes (防注入)
export function shellEscape(s: string): string {
  // 先过滤换行符/回车符防止命令注入，再转义 shell 元字符
  // 注意：$() 和 `` 命令替换需要特殊处理
  return s
    .replace(/[\r\n]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')
}

// --- 错误分类：区分可恢复错误（网络抖动）与永久性错误（认证失败） ---
const PERMANENT_ERROR_PATTERNS = [
  'All configured authentication methods failed',
  'Authentication failed',
  'Invalid private key',
  'Cannot parse privateKey',
  'Encrypted private key detected',
  'Host key verification failed',
  'Invalid username',
]

function isRecoverableError(err: Error): boolean {
  const msg = err.message || ''
  const code = (err as any).code || ''
  if (PERMANENT_ERROR_PATTERNS.some(p => msg.includes(p))) return false
  if (['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) return true
  if (/timeout|reset|closed|lost|EPIPE/i.test(msg)) return true
  return true // 未知错误默认尝试重连（重连次数有上限，不会无限重试）
}

// --- 重连与连接管理常量 ---
const MAX_RECONNECT_ATTEMPTS = 5
const MAX_RECONNECT_DELAY_MS = 30000
const MAX_SESSIONS = 20

export interface SSHConnectionConfig {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'privateKey'
  password?: string
  privateKey?: string
  passphrase?: string
  group?: string
}

interface SSHSession {
  client: Client
  stream: ClientChannel | null
  config: SSHConnectionConfig
  sftp?: any
  execMutex?: Promise<void>
  // 终端尺寸（用于重连时恢复）
  lastCols: number
  lastRows: number
  // 重连状态
  reconnectAttempts: number
  reconnectTimer: ReturnType<typeof setTimeout> | null
  isReconnecting: boolean
}

export class SSHManager extends EventEmitter {
  private sessions: Map<string, SSHSession> = new Map()

  // --- 构建 ssh2 ConnectConfig（含 keepAlive 心跳） ---
  private buildConnectConfig(config: SSHConnectionConfig): ConnectConfig {
    const connectConfig: ConnectConfig = {
      host: config.host,
      port: config.port || 22,
      username: config.username,
      readyTimeout: 15000,
      keepaliveInterval: 15000,  // 每 15 秒发送心跳，防止 NAT/防火墙超时断连
      keepaliveCountMax: 5,      // 连续 5 次心跳无响应才判定断连（75 秒容忍）
    }

    if (config.authType === 'password') {
      connectConfig.password = config.password
    } else if (config.authType === 'privateKey') {
      connectConfig.privateKey = config.privateKey
      if (config.passphrase) {
        connectConfig.passphrase = config.passphrase
      }
    }

    return connectConfig
  }

  // --- 绑定 ssh2 Client 连接后的事件（end/close/timeout/error） ---
  private bindClientEvents(sessionId: string, client: Client): void {
    const handleDisconnect = () => {
      if (!this.sessions.has(sessionId)) return
      const session = this.sessions.get(sessionId)!
      if (!session.isReconnecting) {
        this.attemptReconnect(sessionId)
      }
    }

    client.on('end', handleDisconnect)
    client.on('close', handleDisconnect)
    client.on('timeout', handleDisconnect)
    client.on('error', (err) => {
      if (!this.sessions.has(sessionId)) return
      if (isRecoverableError(err)) {
        handleDisconnect()
      } else {
        // 永久性错误：通知渲染器并清理
        this.emit('error', sessionId, err.message)
        this.cleanupSession(sessionId)
      }
    })
  }

  // --- 绑定 shell stream 的事件 ---
  private bindStreamEvents(sessionId: string, stream: ClientChannel): void {
    stream.on('data', (data: Buffer) => {
      this.emit('data', sessionId, data.toString('utf-8'))
    })

    stream.on('close', () => {
      if (!this.sessions.has(sessionId)) return // 已被 disconnect() 清理
      const session = this.sessions.get(sessionId)!
      if (!session.isReconnecting) {
        this.attemptReconnect(sessionId)
      }
    })

    stream.stderr.on('data', (data: Buffer) => {
      this.emit('data', sessionId, data.toString('utf-8'))
    })
  }

  // --- 安全清理 session（先从 Map 移除，再关闭资源，防止事件回调触发重连） ---
  private cleanupSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer)
    session.isReconnecting = false
    this.sessions.delete(sessionId)
    try { session.sftp?.end() } catch {}
    try { session.stream?.close() } catch {}
    try { session.client.end() } catch {}
  }

  // --- 指数退避自动重连引擎 ---
  private attemptReconnect(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.isReconnecting) return

    session.isReconnecting = true
    session.reconnectAttempts++

    if (session.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      this.emit('reconnectFailed', sessionId, '已达最大重连次数')
      this.cleanupSession(sessionId)
      // 不再额外 emit close，避免渲染器双重清理和双 toast
      return
    }

    // 指数退避: 1s → 2s → 4s → 8s → 16s，上限 30s
    const delay = Math.min(1000 * Math.pow(2, session.reconnectAttempts - 1), MAX_RECONNECT_DELAY_MS)
    this.emit('reconnecting', sessionId, {
      attempt: session.reconnectAttempts,
      maxAttempts: MAX_RECONNECT_ATTEMPTS,
      nextRetryIn: delay,
    })

    session.reconnectTimer = setTimeout(async () => {
      if (!this.sessions.has(sessionId)) return // 已被手动断开

      let newClient: Client | null = null
      try {
        newClient = new Client()
        const config = session.config

        // 1. 建立新连接
        await new Promise<void>((resolve, reject) => {
          newClient!.on('ready', () => resolve())
          newClient!.on('error', (err) => reject(err))
          newClient!.connect(this.buildConnectConfig(config))
        })

        // 2. 重建 shell stream（使用上次记录的终端尺寸，避免重连后尺寸回退为 80x24）
        const newStream = await new Promise<ClientChannel>((resolve, reject) => {
          newClient!.shell({
            term: 'xterm-256color',
            cols: session.lastCols,
            rows: session.lastRows,
          }, (err, s) => {
            err ? reject(err) : resolve(s)
          })
        })

        // 3. 清理旧连接资源
        try { session.client.end() } catch {}

        // 4. 更新 session，重置重连状态
        session.client = newClient
        session.stream = newStream
        session.sftp = undefined  // SFTP 通道需要重新建立
        session.isReconnecting = false
        session.reconnectAttempts = 0
        session.reconnectTimer = null
        newClient = null // 已交接给 session，防止 catch 中误清理

        // 5. 重新绑定事件
        this.bindStreamEvents(sessionId, newStream)
        session.client.removeAllListeners('error')
        session.client.removeAllListeners('ready')
        this.bindClientEvents(sessionId, session.client)

        this.emit('reconnected', sessionId)
      } catch (err: any) {
        // 清理已建立但未交接的 newClient，防止 TCP 连接泄漏
        if (newClient) {
          try { newClient.end() } catch {}
        }

        session.isReconnecting = false
        if (!this.sessions.has(sessionId)) return

        if (isRecoverableError(err)) {
          this.attemptReconnect(sessionId) // 继续重试
        } else {
          this.emit('reconnectFailed', sessionId, err.message)
          this.cleanupSession(sessionId)
        }
      }
    }, delay)
  }

  async connect(config: SSHConnectionConfig): Promise<string> {
    // 连接数上限保护，防止文件描述符耗尽
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error('已达最大连接数限制 (20)')
    }

    const sessionId = uuidv4()
    const client = new Client()

    return new Promise((resolve, reject) => {
      client.on('ready', () => {
        client.shell(
          {
            term: 'xterm-256color',
            cols: 80,
            rows: 24
          },
          (err, stream) => {
            if (err) {
              reject(err)
              return
            }

            const session: SSHSession = {
              client,
              stream,
              config,
              execMutex: Promise.resolve(),
              lastCols: 80,
              lastRows: 24,
              reconnectAttempts: 0,
              reconnectTimer: null,
              isReconnecting: false,
            }
            this.sessions.set(sessionId, session)

            this.bindStreamEvents(sessionId, stream)

            resolve(sessionId)

            // 初始 error/ready handler 只在握手阶段生效，连接成功后切换到完整事件监听
            client.removeAllListeners('error')
            client.removeAllListeners('ready')
            this.bindClientEvents(sessionId, client)
          }
        )
      })

      // 握手阶段的 error handler（连接/认证失败）
      client.on('error', (err) => {
        this.sessions.delete(sessionId)
        this.emit('error', sessionId, err.message)
        reject(err)
      })

      client.connect(this.buildConnectConfig(config))
    })
  }

  write(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId)
    if (session?.stream) {
      session.stream.write(data)
    }
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.lastCols = cols
      session.lastRows = rows
      if (session.stream) {
        session.stream.setWindow(rows, cols, 0, 0)
      }
    }
  }

  // 用户主动断开：取消重连，清理所有资源
  disconnect(sessionId: string): void {
    this.cleanupSession(sessionId)
  }

  disconnectAll(): void {
    for (const [id] of this.sessions) {
      this.disconnect(id)
    }
  }

  async exec(sessionId: string, command: string): Promise<string> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Session not found')
    if (session.isReconnecting) throw new Error('会话正在重连中，请稍候')

    let releaseMutex!: () => void
    const nextMutex = new Promise<void>(resolve => { releaseMutex = resolve })

    const previousMutex = session.execMutex || Promise.resolve()
    session.execMutex = previousMutex.then(() => nextMutex) // Ensure orderly queue

    try {
      await previousMutex // Wait for previous to finish

      return await new Promise((resolve, reject) => {
        session.client.exec(command, (err, stream) => {
          if (err) {
            reject(err)
            return
          }
          let output = ''
          stream.on('data', (data: Buffer) => {
            output += data.toString('utf-8')
          })
          stream.stderr.on('data', (data: Buffer) => {
            output += data.toString('utf-8')
          })
          stream.on('close', () => {
            resolve(output)
          })
        })
      })
    } finally {
      releaseMutex()
    }
  }

  // --- SFTP Subsystem ---
  private async getSftp(sessionId: string): Promise<any> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Session not found')
    if (session.isReconnecting) throw new Error('会话正在重连中，请稍候')

    // Store sftp instance in session so we don't spam channels
    if (session.sftp) return session.sftp

    return new Promise((resolve, reject) => {
      session.client.sftp((err, sftp) => {
        if (err) {
          reject(err)
          return
        }
        session.sftp = sftp
        resolve(sftp)
      })
    })
  }

  async sftpLs(sessionId: string, path: string): Promise<SFTPFile[]> {
    const sftp = await this.getSftp(sessionId)
    return new Promise((resolve, reject) => {
      sftp.readdir(path, (err: Error | undefined, list: any[]) => {
        if (err) return reject(err)
        const files: SFTPFile[] = list.map(item => {
          // 优先使用 attrs.mode 判断文件类型，回退到 longname 前缀解析
          let type: 'd' | '-' | 'l' = '-'
          const mode = item.attrs?.mode
          if (typeof mode === 'number') {
            const fileType = (mode >> 12) & 0o17
            if (fileType === 0o4) type = 'd'
            else if (fileType === 0o12) type = 'l'
            // else 保持 '-'
          } else {
            // 回退到 longname 前缀解析
            const lw = item.longname || ''
            if (lw.startsWith('d')) type = 'd'
            else if (lw.startsWith('l')) type = 'l'
          }
          return {
            name: item.filename,
            type,
            size: item.attrs?.size ?? 0,
            modifyTime: item.attrs?.mtime ?? 0,
            accessTime: item.attrs?.atime ?? 0,
            permissions: (item.longname || '').split(' ')[0] || '-'
          }
        })
        resolve(sortSftpFiles(files))
      })
    })
  }

  async sftpDownload(sessionId: string, remotePath: string, localPath: string, onProgress?: (transferred: number, total: number) => void): Promise<void> {
    const sftp = await this.getSftp(sessionId)
    return new Promise((resolve, reject) => {
      const options: any = { concurrency: 64, chunkSize: 32768 }
      if (onProgress) {
        options.step = (transferred: number, _chunk: number, total: number) => {
          onProgress(transferred, total)
        }
      }
      sftp.fastGet(remotePath, localPath, options, (err: Error | undefined) => {
        if (err) return reject(err)
        resolve()
      })
    })
  }

  async sftpUpload(sessionId: string, localPath: string, remotePath: string, onProgress?: (transferred: number, total: number) => void): Promise<void> {
    const sftp = await this.getSftp(sessionId)
    return new Promise((resolve, reject) => {
      const options: any = { concurrency: 64, chunkSize: 32768 }
      if (onProgress) {
        options.step = (transferred: number, _chunk: number, total: number) => {
          onProgress(transferred, total)
        }
      }
      sftp.fastPut(localPath, remotePath, options, (err: Error | undefined) => {
        if (err) return reject(err)
        resolve()
      })
    })
  }

  async sftpMove(sessionId: string, srcPath: string, destPath: string): Promise<void> {
    const sftp = await this.getSftp(sessionId)
    return new Promise((resolve, reject) => {
      sftp.rename(srcPath, destPath, (err: Error | undefined) => {
        if (err) return reject(err)
        resolve()
      })
    })
  }

  async sftpCopy(sessionId: string, srcPath: string, destPath: string): Promise<void> {
    const sftp = await this.getSftp(sessionId)

    // 使用 lstat 检查源本身（不跟随符号链接）
    const srcStat = await new Promise<any>((resolve, reject) => {
      sftp.lstat(srcPath, (err: Error | null, stats: any) => {
        if (err) reject(err)
        else resolve(stats)
      })
    })

    // 处理符号链接
    if (srcStat.isSymbolicLink()) {
      // 使用 cp -P 保持符号链接本身（不跟随）
      await this.exec(sessionId, `cp -P "${shellEscape(srcPath)}" "${shellEscape(destPath)}"`)
      return
    }

    if (srcStat.isDirectory()) {
      // 目录复制：使用 cp -r 命令递归复制（不跟随符号链接）
      await this.exec(sessionId, `cp -rP "${shellEscape(srcPath)}" "${shellEscape(destPath)}"`)
      return
    }

    // 文件复制：使用流
    return new Promise((resolve, reject) => {
      const readStream = sftp.createReadStream(srcPath)
      const writeStream = sftp.createWriteStream(destPath)

      // 清理函数：销毁两个流
      const cleanup = (err?: Error) => {
        readStream.destroy()
        writeStream.destroy()
        if (err) reject(err)
      }

      readStream.on('error', cleanup)
      writeStream.on('error', cleanup)
      writeStream.on('close', () => resolve())

      readStream.pipe(writeStream)
    })
  }

  getActiveSessions(): string[] {
    return Array.from(this.sessions.keys())
  }
}
