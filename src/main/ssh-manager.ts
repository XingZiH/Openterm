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
}

export class SSHManager extends EventEmitter {
  private sessions: Map<string, SSHSession> = new Map()

  async connect(config: SSHConnectionConfig): Promise<string> {
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

            const session: SSHSession = { client, stream, config, execMutex: Promise.resolve() }
            this.sessions.set(sessionId, session)

            stream.on('data', (data: Buffer) => {
              this.emit('data', sessionId, data.toString('utf-8'))
            })

            stream.on('close', () => {
              this.sessions.delete(sessionId)
              this.emit('close', sessionId)
            })

            stream.stderr.on('data', (data: Buffer) => {
              this.emit('data', sessionId, data.toString('utf-8'))
            })

            resolve(sessionId)
          }
        )
      })

      client.on('error', (err) => {
        this.sessions.delete(sessionId)
        this.emit('error', sessionId, err.message)
        reject(err)
      })

      const connectConfig: ConnectConfig = {
        host: config.host,
        port: config.port || 22,
        username: config.username,
        readyTimeout: 10000
      }

      if (config.authType === 'password') {
        connectConfig.password = config.password
      } else if (config.authType === 'privateKey') {
        connectConfig.privateKey = config.privateKey
        if (config.passphrase) {
          connectConfig.passphrase = config.passphrase
        }
      }

      client.connect(connectConfig)
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
    if (session?.stream) {
      session.stream.setWindow(rows, cols, 0, 0)
    }
  }

  disconnect(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.stream?.close()
      session.client.end()
      this.sessions.delete(sessionId)
    }
  }

  disconnectAll(): void {
    for (const [id] of this.sessions) {
      this.disconnect(id)
    }
  }

  async exec(sessionId: string, command: string): Promise<string> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Session not found')

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
