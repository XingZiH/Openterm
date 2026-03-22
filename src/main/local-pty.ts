import * as pty from 'node-pty'
import { EventEmitter } from 'events'
import * as os from 'os'

export class LocalPtyManager extends EventEmitter {
  private ptys = new Map<string, pty.IPty>()

  getDefaultShell(): string {
    if (process.platform === 'win32') {
      return process.env.COMSPEC || 'powershell.exe'
    }
    if (process.platform === 'darwin') {
      return process.env.SHELL || '/bin/zsh'
    }
    return process.env.SHELL || '/bin/bash'
  }

  spawn(id: string, cwd?: string): string {
    const shell = this.getDefaultShell()
    const env = { ...process.env } as Record<string, string>

    const p = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: cwd || os.homedir(),
      env
    })

    p.onData((data: string) => {
      this.emit('data', id, data)
    })

    p.onExit(({ exitCode }) => {
      this.ptys.delete(id)
      this.emit('exit', id, exitCode)
    })

    this.ptys.set(id, p)
    return id
  }

  write(id: string, data: string): void {
    this.ptys.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.ptys.get(id)?.resize(cols, rows)
    } catch {
      // ignore resize errors (e.g. process already exited)
    }
  }

  kill(id: string): void {
    const p = this.ptys.get(id)
    if (p) {
      p.kill()
      this.ptys.delete(id)
    }
  }

  killAll(): void {
    for (const [id, p] of this.ptys) {
      p.kill()
    }
    this.ptys.clear()
  }
}
