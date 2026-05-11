// 多行命令粘贴的解析器：把剪贴板文本切分成可顺序执行的命令列表。
//
// 解析规则（用户已确认）：
// - 处理反斜杠 `\` 续行符：行末单个 `\` 视为续行，与下一行用单空格合并
// - 保留 heredoc 块（<<EOF / <<-EOF / <<'EOF' / <<"EOF"），整个块作为一条命令
// - 过滤纯注释行：trim 后首字符为 `#` 跳过
// - 过滤空行
// - Windows CRLF 换行被归一化为 LF
// - 同一行中以 `;` / `&&` / `||` 串联的多条命令保留为同一条
// - 引号内的续行符不做特殊处理（与本期典型场景无关）

export interface ParsedCommand {
  // 已合并续行符、可直接交给 shell 执行的命令文本
  command: string
  // 原文 1-based 行号，用于失败时定位
  startLine: number
  // 原文片段（含续行符与 heredoc 内容），用于 UI 展示
  raw: string
}

export interface ParseResult {
  commands: ParsedCommand[]
  hasMultiple: boolean
}

// 检测 heredoc 起始：<<EOF / <<-EOF / <<'EOF' / <<"EOF"
// 引号包裹的终结符语义上抑制变量展开，但对我们仅做完整保留无影响
const HEREDOC_TAIL_REGEX = /^<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/

// 扫描行内字符并追踪引号/转义状态，返回行内首次出现在引号外的 heredoc 起始位置信息
// 避免把 `echo "<<EOF"` 这种字面字符串误判为 heredoc
function findHeredocStart(line: string): { allowIndent: boolean; terminator: string } | null {
  let inSingle = false
  let inDouble = false
  let escape = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (escape) {
      escape = false
      continue
    }
    if (!inSingle && c === '\\') {
      // 单引号内的 \ 不是转义；其他情况下吃掉下一个字符
      escape = true
      continue
    }
    if (!inDouble && c === "'") {
      inSingle = !inSingle
      continue
    }
    if (!inSingle && c === '"') {
      inDouble = !inDouble
      continue
    }
    if (!inSingle && !inDouble && c === '<' && line[i + 1] === '<') {
      const m = line.slice(i).match(HEREDOC_TAIL_REGEX)
      if (m) {
        return { allowIndent: m[1] === '-', terminator: m[3] }
      }
    }
  }
  return null
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart()
  return trimmed.startsWith('#')
}

// 续行符识别：行尾必须是奇数个反斜杠才算续行
// `echo a \\` -> 一个反斜杠，是续行
// `echo a \\\\` -> 两个反斜杠（字面 `\`），不是续行
function endsWithContinuation(line: string): boolean {
  let backslashes = 0
  for (let i = line.length - 1; i >= 0; i--) {
    if (line[i] === '\\') backslashes++
    else break
  }
  return backslashes % 2 === 1
}

function stripTrailingBackslash(line: string): string {
  return line.slice(0, -1).trimEnd()
}

export function parseMultiLineCommands(text: string): ParseResult {
  // 规范化换行：CRLF / CR 都转为 LF
  const normalized = text.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')

  const commands: ParsedCommand[] = []

  // 当前正在累积的普通命令缓冲
  let buffer = ''
  let bufferRaw = ''
  let bufferStartLine = 0
  let inContinuation = false

  // heredoc 状态
  let inHeredoc = false
  let heredocTerminator = ''
  let heredocAllowIndent = false

  const flushBuffer = () => {
    if (buffer.trim()) {
      commands.push({
        command: buffer.trim(),
        startLine: bufferStartLine,
        raw: bufferRaw,
      })
    }
    buffer = ''
    bufferRaw = ''
    bufferStartLine = 0
    inContinuation = false
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNumber = i + 1

    if (inHeredoc) {
      // heredoc 内：原样累积，检测终结符
      const candidate = heredocAllowIndent ? line.replace(/^\t+/, '') : line
      bufferRaw += '\n' + line
      buffer += '\n' + line
      if (candidate === heredocTerminator) {
        inHeredoc = false
        heredocTerminator = ''
        heredocAllowIndent = false
        // heredoc 块结束后立即提交（heredoc 本身就是一条独立命令）
        flushBuffer()
      }
      continue
    }

    // 正在续行的情况下，不过滤空行/注释，因为它们是上一行命令的一部分
    if (inContinuation) {
      bufferRaw += '\n' + line
      // 续行合并：用单空格连接（去掉本行起始空白避免重复缩进）
      const joined = line.replace(/^\s+/, '')
      if (endsWithContinuation(line)) {
        buffer += ' ' + stripTrailingBackslash(joined)
        // 仍在续行
      } else {
        buffer += ' ' + joined
        inContinuation = false
        // 此行可能引入 heredoc
        const h = findHeredocStart(line)
        if (h) {
          inHeredoc = true
          heredocAllowIndent = h.allowIndent
          heredocTerminator = h.terminator
          continue
        }
        flushBuffer()
      }
      continue
    }

    // 普通状态：过滤空行与纯注释
    if (line.trim() === '') continue
    if (isCommentLine(line)) continue

    // 开启新命令缓冲
    bufferStartLine = lineNumber
    bufferRaw = line

    // 先判断是否引入 heredoc：注意 heredoc 标记本身也可能后跟续行
    const heredocStart = findHeredocStart(line)
    if (heredocStart && !endsWithContinuation(line)) {
      inHeredoc = true
      heredocAllowIndent = heredocStart.allowIndent
      heredocTerminator = heredocStart.terminator
      buffer = line
      continue
    }

    if (endsWithContinuation(line)) {
      buffer = stripTrailingBackslash(line)
      inContinuation = true
      continue
    }

    buffer = line
    flushBuffer()
  }

  // EOF 时仍在续行 / heredoc：容错为单条命令
  if (buffer.trim()) {
    flushBuffer()
  }

  return {
    commands,
    hasMultiple: commands.length > 1,
  }
}
