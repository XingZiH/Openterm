// 多行命令串行执行器：通过可视终端（sendData / pty.write）顺序发送命令，
// 借助 sentinel 行检测每条命令完成时机与退出状态，失败时暂停并允许继续/停止。
//
// 设计要点：
// - 不引入新 IPC：通过外部注入 send + subscribe，让执行器与传输层解耦
// - heredoc 命令：先发送整体（含终结符），再单独发送 sentinel
// - 单条超时默认 120s，与 SSHManager 的 30s exec 超时解耦（PTY 不走 exec mutex）
// - sentinel 标记使用 8 位随机 hex 避免与历史输出冲突
// - 反订阅在 abort / completed 时必发生，避免事件监听器泄漏

import type { ParsedCommand } from './multi-line-parser'

export type ShellKind = 'bash' | 'powershell' | 'cmd'

export interface ExecutionHandlers {
  // 向可视终端注入字节，调用方通常包装 window.electronAPI.ssh.sendData 或 pty.write
  send: (data: string) => void
  // 订阅终端回流数据；返回反订阅函数
  subscribe: (cb: (chunk: string) => void) => () => void
}

export interface ExecutionCallbacks {
  onItemStart?: (index: number) => void
  onItemSettled?: (index: number, exitCode: number) => void
  onPaused?: (index: number, reason: 'failed' | 'timeout') => void
  onCompleted?: (lastIndex: number) => void
  onAborted?: (index: number) => void
}

export interface ExecutorOptions {
  perCommandTimeoutMs?: number
  // 用于注入 setTimeout/clearTimeout，便于测试使用 fake timers
  scheduler?: {
    setTimeout: (fn: () => void, ms: number) => any
    clearTimeout: (handle: any) => void
  }
  // 注入随机 id 生成器，便于测试断言
  generateMarkerId?: () => string
}

const DEFAULT_TIMEOUT_MS = 120_000
const BUFFER_MAX = 8192

export type ExecutorState = 'idle' | 'running' | 'paused' | 'done' | 'aborted'

function defaultMarkerId(): string {
  // 8 位随机 hex
  const bytes = new Uint8Array(4)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

// 构造 shell 特定的 sentinel 行（不含末尾换行）
export function buildSentinel(shellKind: ShellKind, markerId: string): string {
  switch (shellKind) {
    case 'powershell':
      return `Write-Host "__OPENTERM_MARK_${markerId}__:$LASTEXITCODE"`
    case 'cmd':
      return `echo __OPENTERM_MARK_${markerId}__:%ERRORLEVEL%`
    case 'bash':
    default:
      return `printf '__OPENTERM_MARK_${markerId}__:%s\\n' "$?"`
  }
}

// 复合连接符（把 sentinel 接在用户命令尾部）
function commandJoiner(shellKind: ShellKind): string {
  // cmd.exe 用 `&`（无视退出码，与 ERRORLEVEL 配合可正确捕获状态）
  // bash/powershell 用 `;` 同理
  return shellKind === 'cmd' ? ' & ' : ' ; '
}

// heredoc 命令需要把 sentinel 放在独立行（heredoc 终结符后）
function isHeredocCommand(cmd: ParsedCommand): boolean {
  // 简单识别：raw 中是否有 << 起始
  return /<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/.test(cmd.raw)
}

export class MultiLineExecutor {
  private currentIndex = 0
  private unsubscribe: (() => void) | null = null
  private timeoutHandle: any = null
  private buffer = ''
  private state: ExecutorState = 'idle'
  private markerId: string
  private markerRegex: RegExp
  private readonly perCommandTimeoutMs: number
  private readonly scheduler: NonNullable<ExecutorOptions['scheduler']>

  constructor(
    private readonly commands: ParsedCommand[],
    private readonly shellKind: ShellKind,
    private readonly handlers: ExecutionHandlers,
    private readonly callbacks: ExecutionCallbacks = {},
    options: ExecutorOptions = {},
  ) {
    this.perCommandTimeoutMs = options.perCommandTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.scheduler = options.scheduler ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: handle => clearTimeout(handle),
    }
    this.markerId = (options.generateMarkerId ?? defaultMarkerId)()
    this.markerRegex = new RegExp(`__OPENTERM_MARK_${this.markerId}__:(-?\\d+)`)
  }

  start(): void {
    if (this.state !== 'idle') return
    if (this.commands.length === 0) {
      this.state = 'done'
      this.callbacks.onCompleted?.(-1)
      return
    }
    this.state = 'running'
    this.unsubscribe = this.handlers.subscribe(chunk => this.onChunk(chunk))
    this.runCurrent()
  }

  // 失败/超时暂停后调用，继续执行下一条
  continue(): void {
    if (this.state !== 'paused') return
    this.state = 'running'
    this.currentIndex++
    if (this.currentIndex >= this.commands.length) {
      this.finish('done', this.commands.length - 1)
      return
    }
    this.runCurrent()
  }

  abort(): void {
    if (this.state === 'done' || this.state === 'aborted') return
    const idx = this.currentIndex
    this.finish('aborted', idx)
  }

  getState(): ExecutorState {
    return this.state
  }

  private runCurrent(): void {
    const cmd = this.commands[this.currentIndex]
    this.callbacks.onItemStart?.(this.currentIndex)
    this.buffer = ''
    this.armTimeout()

    const sentinel = buildSentinel(this.shellKind, this.markerId)
    if (isHeredocCommand(cmd)) {
      // 先发送 heredoc 整体（含终结符）+ 换行推动 shell 进入下一 prompt，再发 sentinel
      this.handlers.send(cmd.command + '\n')
      this.handlers.send(sentinel + '\n')
    } else {
      this.handlers.send(cmd.command + commandJoiner(this.shellKind) + sentinel + '\n')
    }
  }

  private armTimeout(): void {
    this.clearTimeoutHandle()
    this.timeoutHandle = this.scheduler.setTimeout(() => {
      if (this.state !== 'running') return
      this.state = 'paused'
      this.callbacks.onPaused?.(this.currentIndex, 'timeout')
    }, this.perCommandTimeoutMs)
  }

  private clearTimeoutHandle(): void {
    if (this.timeoutHandle != null) {
      this.scheduler.clearTimeout(this.timeoutHandle)
      this.timeoutHandle = null
    }
  }

  private onChunk(chunk: string): void {
    if (this.state !== 'running') return
    this.buffer += chunk
    if (this.buffer.length > BUFFER_MAX) {
      this.buffer = this.buffer.slice(this.buffer.length - BUFFER_MAX)
    }
    const match = this.buffer.match(this.markerRegex)
    if (!match) return

    const exitCode = parseInt(match[1], 10)
    this.clearTimeoutHandle()
    this.callbacks.onItemSettled?.(this.currentIndex, exitCode)

    // 清理 buffer 中已匹配的部分，避免下一条复用
    this.buffer = ''

    if (exitCode === 0) {
      this.currentIndex++
      if (this.currentIndex >= this.commands.length) {
        this.finish('done', this.commands.length - 1)
        return
      }
      this.runCurrent()
    } else {
      this.state = 'paused'
      this.callbacks.onPaused?.(this.currentIndex, 'failed')
    }
  }

  private finish(state: 'done' | 'aborted', index: number): void {
    this.state = state
    this.clearTimeoutHandle()
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
    if (state === 'done') {
      this.callbacks.onCompleted?.(index)
    } else {
      this.callbacks.onAborted?.(index)
    }
  }
}

// 渲染层根据 sessionId + platform 推断 shell 类型
export function resolveShellKind(sessionId: string, platform: string): ShellKind {
  if (!sessionId.startsWith('local-')) return 'bash'
  if (platform === 'win32') return 'cmd'
  return 'bash'
}
