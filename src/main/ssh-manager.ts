import { EventEmitter } from 'events'
import { Client, type ConnectConfig, type ClientChannel } from 'ssh2'
import { v4 as uuidv4 } from 'uuid'

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

  async sftpLs(sessionId: string, path: string): Promise<any[]> {
    const sftp = await this.getSftp(sessionId)
    return new Promise((resolve, reject) => {
      sftp.readdir(path, (err: Error | undefined, list: any[]) => {
        if (err) return reject(err)
        // Transform the raw sftp attributes into our SFTPFile interface
        const files = list.map(item => ({
          name: item.filename,
          type: item.longname.startsWith('d') ? 'd' : item.longname.startsWith('l') ? 'l' : '-',
          size: item.attrs.size,
          modifyTime: item.attrs.mtime,
          accessTime: item.attrs.atime,
          permissions: item.longname.split(' ')[0]
        }))
        // Sort: directories first, then alphabetical
        files.sort((a, b) => {
          if (a.name === '..') return -1
          if (b.name === '..') return 1
          if (a.type === 'd' && b.type !== 'd') return -1
          if (a.type !== 'd' && b.type === 'd') return 1
          return a.name.localeCompare(b.name)
        })
        resolve(files)
      })
    })
  }

  async sftpDownload(sessionId: string, remotePath: string, localPath: string): Promise<void> {
    const sftp = await this.getSftp(sessionId)
    return new Promise((resolve, reject) => {
      sftp.fastGet(remotePath, localPath, { concurrency: 64, chunkSize: 32768 }, (err: Error | undefined) => {
        if (err) return reject(err)
        resolve()
      })
    })
  }

  async sftpUpload(sessionId: string, localPath: string, remotePath: string): Promise<void> {
    const sftp = await this.getSftp(sessionId)
    return new Promise((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, { concurrency: 64, chunkSize: 32768 }, (err: Error | undefined) => {
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
    return new Promise((resolve, reject) => {
      const readStream = sftp.createReadStream(srcPath)
      const writeStream = sftp.createWriteStream(destPath)

      readStream.on('error', (err: Error) => reject(err))
      writeStream.on('error', (err: Error) => reject(err))
      writeStream.on('close', () => resolve())

      readStream.pipe(writeStream)
    })
  }

  getActiveSessions(): string[] {
    return Array.from(this.sessions.keys())
  }
}
