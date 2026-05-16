import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MultiLineExecutor, buildSentinel, resolveShellKind, type ShellKind } from '../multi-line-executor'
import type { ParsedCommand } from '../multi-line-parser'

const MARKER_ID = 'abcd1234'

function makeCommand(text: string, line = 1, raw?: string): ParsedCommand {
  return { command: text, startLine: line, raw: raw ?? text }
}

// 测试用桩：把订阅到的回调暴露出来，便于手动喂数据触发 sentinel 匹配
function makeHarness() {
  let subscriber: ((chunk: string) => void) | null = null
  const sendCalls: string[] = []
  return {
    sendCalls,
    handlers: {
      send: (data: string) => { sendCalls.push(data) },
      subscribe: (cb: (chunk: string) => void) => {
        subscriber = cb
        return () => { subscriber = null }
      },
    },
    emit: (chunk: string) => {
      if (subscriber) subscriber(chunk)
    },
    hasSubscriber: () => subscriber !== null,
  }
}

function makeCallbacks() {
  return {
    onItemStart: vi.fn(),
    onItemSettled: vi.fn(),
    onPaused: vi.fn(),
    onCompleted: vi.fn(),
    onAborted: vi.fn(),
  }
}

function markerLine(shell: ShellKind, exitCode: number): string {
  // 模拟 shell 实际输出的 sentinel 行
  return `__OPENTERM_MARK_${MARKER_ID}__:${exitCode}\n`
}

describe('buildSentinel', () => {
  it('uses printf with $? for bash', () => {
    expect(buildSentinel('bash', MARKER_ID))
      .toBe(`printf '__OPENTERM_MARK_${MARKER_ID}__:%s\\n' "$?"`)
  })
  it('uses Write-Host with $LASTEXITCODE for powershell', () => {
    expect(buildSentinel('powershell', MARKER_ID))
      .toBe(`Write-Host "__OPENTERM_MARK_${MARKER_ID}__:$LASTEXITCODE"`)
  })
  it('uses echo with %ERRORLEVEL% for cmd', () => {
    expect(buildSentinel('cmd', MARKER_ID))
      .toBe(`echo __OPENTERM_MARK_${MARKER_ID}__:%ERRORLEVEL%`)
  })
})

describe('resolveShellKind', () => {
  it('returns bash for remote SSH sessions regardless of platform', () => {
    expect(resolveShellKind('uuid-123', 'win32')).toBe('bash')
    expect(resolveShellKind('uuid-123', 'darwin')).toBe('bash')
  })
  it('returns cmd for local on win32', () => {
    expect(resolveShellKind('local-1', 'win32')).toBe('cmd')
  })
  it('returns bash for local on macOS/Linux', () => {
    expect(resolveShellKind('local-1', 'darwin')).toBe('bash')
    expect(resolveShellKind('local-1', 'linux')).toBe('bash')
  })
})

describe('MultiLineExecutor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs two successful commands sequentially', () => {
    const commands = [makeCommand('echo a'), makeCommand('echo b', 2)]
    const h = makeHarness()
    const cb = makeCallbacks()
    const exec = new MultiLineExecutor(commands, 'bash', h.handlers, cb, {
      generateMarkerId: () => MARKER_ID,
    })
    exec.start()

    expect(cb.onItemStart).toHaveBeenCalledWith(0)
    expect(h.sendCalls).toHaveLength(1)
    // 第一条 exit=0
    h.emit(markerLine('bash', 0))
    expect(cb.onItemSettled).toHaveBeenCalledWith(0, 0)
    expect(cb.onItemStart).toHaveBeenCalledWith(1)
    expect(h.sendCalls).toHaveLength(2)
    // 第二条 exit=0
    h.emit(markerLine('bash', 0))
    expect(cb.onItemSettled).toHaveBeenCalledWith(1, 0)
    expect(cb.onCompleted).toHaveBeenCalledWith(1)
    expect(exec.getState()).toBe('done')
    // 订阅必须已反订阅
    expect(h.hasSubscriber()).toBe(false)
  })

  it('pauses on non-zero exit and resumes via continue()', () => {
    const commands = [makeCommand('false'), makeCommand('echo ok', 2)]
    const h = makeHarness()
    const cb = makeCallbacks()
    const exec = new MultiLineExecutor(commands, 'bash', h.handlers, cb, {
      generateMarkerId: () => MARKER_ID,
    })
    exec.start()
    h.emit(markerLine('bash', 1))
    expect(cb.onItemSettled).toHaveBeenCalledWith(0, 1)
    expect(cb.onPaused).toHaveBeenCalledWith(0, 'failed')
    expect(exec.getState()).toBe('paused')
    expect(h.sendCalls).toHaveLength(1)

    exec.continue()
    expect(cb.onItemStart).toHaveBeenCalledWith(1)
    expect(h.sendCalls).toHaveLength(2)
    h.emit(markerLine('bash', 0))
    expect(cb.onCompleted).toHaveBeenCalledWith(1)
    expect(exec.getState()).toBe('done')
  })

  it('abort prevents sending subsequent commands', () => {
    const commands = [makeCommand('echo a'), makeCommand('echo b', 2)]
    const h = makeHarness()
    const cb = makeCallbacks()
    const exec = new MultiLineExecutor(commands, 'bash', h.handlers, cb, {
      generateMarkerId: () => MARKER_ID,
    })
    exec.start()
    exec.abort()
    expect(cb.onAborted).toHaveBeenCalledWith(0)
    expect(exec.getState()).toBe('aborted')
    // 即使 shell 仍输出 sentinel，也不应再产生 onItemSettled / 推进
    h.emit(markerLine('bash', 0))
    expect(cb.onItemSettled).not.toHaveBeenCalled()
    expect(cb.onCompleted).not.toHaveBeenCalled()
    expect(h.sendCalls).toHaveLength(1)
    expect(h.hasSubscriber()).toBe(false)
  })

  it('pauses with timeout when sentinel never arrives', () => {
    const commands = [makeCommand('sleep 999')]
    const h = makeHarness()
    const cb = makeCallbacks()
    const exec = new MultiLineExecutor(commands, 'bash', h.handlers, cb, {
      generateMarkerId: () => MARKER_ID,
      perCommandTimeoutMs: 5_000,
    })
    exec.start()
    expect(cb.onPaused).not.toHaveBeenCalled()
    vi.advanceTimersByTime(5_000)
    expect(cb.onPaused).toHaveBeenCalledWith(0, 'timeout')
    expect(exec.getState()).toBe('paused')
  })

  it('uses per-command timeout resolver when provided', () => {
    const commands = [makeCommand('wget https://example.test/file')]
    const h = makeHarness()
    const cb = makeCallbacks()
    const exec = new MultiLineExecutor(commands, 'bash', h.handlers, cb, {
      generateMarkerId: () => MARKER_ID,
      perCommandTimeoutMs: 5_000,
      resolveCommandTimeoutMs: () => 30_000,
    })
    exec.start()
    vi.advanceTimersByTime(5_000)
    expect(cb.onPaused).not.toHaveBeenCalled()
    vi.advanceTimersByTime(25_000)
    expect(cb.onPaused).toHaveBeenCalledWith(0, 'timeout')
    expect(exec.getState()).toBe('paused')
  })

  it('parses sentinel even when surrounded by ANSI/extra output', () => {
    const commands = [makeCommand('ls')]
    const h = makeHarness()
    const cb = makeCallbacks()
    const exec = new MultiLineExecutor(commands, 'bash', h.handlers, cb, {
      generateMarkerId: () => MARKER_ID,
    })
    exec.start()
    // 分块到达 + ANSI 颜色码 + 其他无关行
    h.emit('\x1b[32mfile-a\x1b[0m\nfile-b\n')
    h.emit('user@host:~$ __OPENTERM_MARK_')
    h.emit(`${MARKER_ID}__:0\n`)
    expect(cb.onItemSettled).toHaveBeenCalledWith(0, 0)
    expect(cb.onCompleted).toHaveBeenCalledWith(0)
  })

  it('sends heredoc command and sentinel separately', () => {
    const heredoc = makeCommand(
      'cat <<EOF\nhello\nEOF',
      1,
      'cat <<EOF\nhello\nEOF',
    )
    const h = makeHarness()
    const cb = makeCallbacks()
    const exec = new MultiLineExecutor([heredoc], 'bash', h.handlers, cb, {
      generateMarkerId: () => MARKER_ID,
    })
    exec.start()
    // heredoc 模式：先 send 命令体，再 send sentinel 行
    expect(h.sendCalls).toHaveLength(2)
    expect(h.sendCalls[0]).toContain('<<EOF')
    expect(h.sendCalls[0]).toContain('EOF\n')
    expect(h.sendCalls[1]).toContain('printf')
    expect(h.sendCalls[1].endsWith('\n')).toBe(true)
  })

  it('handles empty command list as immediate completion', () => {
    const h = makeHarness()
    const cb = makeCallbacks()
    const exec = new MultiLineExecutor([], 'bash', h.handlers, cb, {
      generateMarkerId: () => MARKER_ID,
    })
    exec.start()
    expect(cb.onCompleted).toHaveBeenCalledWith(-1)
    expect(exec.getState()).toBe('done')
    expect(h.sendCalls).toHaveLength(0)
  })
})
