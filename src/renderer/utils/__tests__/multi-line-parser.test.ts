import { describe, it, expect } from 'vitest'
import { parseMultiLineCommands } from '../multi-line-parser'

describe('parseMultiLineCommands', () => {
  it('returns single command for one-line input', () => {
    const r = parseMultiLineCommands('ls -la')
    expect(r.hasMultiple).toBe(false)
    expect(r.commands).toHaveLength(1)
    expect(r.commands[0].command).toBe('ls -la')
    expect(r.commands[0].startLine).toBe(1)
  })

  it('filters out blank lines and pure comment lines', () => {
    const text = `
# just a comment
   # indented comment

`
    const r = parseMultiLineCommands(text)
    expect(r.commands).toHaveLength(0)
    expect(r.hasMultiple).toBe(false)
  })

  it('splits two independent docker commands', () => {
    const text = `docker pull alpine
docker run alpine echo hi`
    const r = parseMultiLineCommands(text)
    expect(r.commands).toHaveLength(2)
    expect(r.hasMultiple).toBe(true)
    expect(r.commands[0].command).toBe('docker pull alpine')
    expect(r.commands[1].command).toBe('docker run alpine echo hi')
    expect(r.commands[1].startLine).toBe(2)
  })

  it('merges backslash continuation lines', () => {
    const text = `docker run -d \\
  --name foo \\
  alpine sleep 60`
    const r = parseMultiLineCommands(text)
    expect(r.commands).toHaveLength(1)
    expect(r.commands[0].command).toBe('docker run -d --name foo alpine sleep 60')
  })

  it('preserves heredoc block as a single command', () => {
    const text = `cat <<EOF
foo
bar
EOF`
    const r = parseMultiLineCommands(text)
    expect(r.commands).toHaveLength(1)
    expect(r.commands[0].raw).toContain('foo')
    expect(r.commands[0].raw).toContain('bar')
    expect(r.commands[0].raw).toContain('EOF')
  })

  it('separates heredoc block from following command', () => {
    const text = `cat <<EOF
hello
EOF
ls /tmp`
    const r = parseMultiLineCommands(text)
    expect(r.commands).toHaveLength(2)
    expect(r.commands[0].raw).toContain('hello')
    expect(r.commands[1].command).toBe('ls /tmp')
  })

  it('supports <<- heredoc with tab-indented terminator', () => {
    // 注意：实际 tab 必须用 \t；测试用模板字符串显式写入
    const text = 'cat <<-EOF\n\tline1\n\tEOF\nls /tmp'
    const r = parseMultiLineCommands(text)
    expect(r.commands).toHaveLength(2)
    expect(r.commands[1].command).toBe('ls /tmp')
  })

  it('supports <<\'EOF\' quoted terminator', () => {
    const text = `cat <<'EOF'
$not_expanded
EOF
echo done`
    const r = parseMultiLineCommands(text)
    expect(r.commands).toHaveLength(2)
    expect(r.commands[1].command).toBe('echo done')
  })

  it('does not treat backslash inside heredoc body as continuation', () => {
    const text = `cat <<EOF
line ending with \\
still in heredoc
EOF
echo after`
    const r = parseMultiLineCommands(text)
    expect(r.commands).toHaveLength(2)
    expect(r.commands[0].raw).toContain('still in heredoc')
    expect(r.commands[1].command).toBe('echo after')
  })

  it('normalizes CRLF line endings', () => {
    const text = 'echo a\r\necho b'
    const r = parseMultiLineCommands(text)
    expect(r.commands).toHaveLength(2)
    expect(r.commands[0].command).toBe('echo a')
    expect(r.commands[1].command).toBe('echo b')
  })

  it('handles trailing backslash without following line gracefully', () => {
    const text = 'echo hello \\'
    const r = parseMultiLineCommands(text)
    // 容错：尾部续行无下一行 → 单条命令（已去掉续行符）
    expect(r.commands).toHaveLength(1)
    expect(r.commands[0].command).toBe('echo hello')
  })

  it('keeps semicolon-joined commands on the same line', () => {
    const r = parseMultiLineCommands('echo a; echo b')
    expect(r.commands).toHaveLength(1)
    expect(r.commands[0].command).toBe('echo a; echo b')
  })

  it('keeps multiple backslashes as literal (not continuation)', () => {
    // 两个反斜杠 = 字面 `\`，行尾两个反斜杠不应被识别为续行
    const text = 'echo path\\\\\necho next'
    const r = parseMultiLineCommands(text)
    expect(r.commands).toHaveLength(2)
    expect(r.commands[0].command).toBe('echo path\\\\')
    expect(r.commands[1].command).toBe('echo next')
  })

  it('does not treat << inside double-quoted string as heredoc start', () => {
    const text = 'echo "<<EOF"\necho hello'
    const r = parseMultiLineCommands(text)
    expect(r.commands).toHaveLength(2)
    expect(r.commands[0].command).toBe('echo "<<EOF"')
    expect(r.commands[1].command).toBe('echo hello')
  })

  it('does not treat << inside single-quoted string as heredoc start', () => {
    const text = "echo '<<EOF'\necho hello"
    const r = parseMultiLineCommands(text)
    expect(r.commands).toHaveLength(2)
    expect(r.commands[0].command).toBe("echo '<<EOF'")
    expect(r.commands[1].command).toBe('echo hello')
  })

  it('recognizes heredoc when << is outside quotes on the same line', () => {
    // 引号字符串与后续 heredoc 共存：cat "header" <<EOF ... EOF
    const text = 'cat "header" <<EOF\nbody\nEOF\necho done'
    const r = parseMultiLineCommands(text)
    expect(r.commands).toHaveLength(2)
    expect(r.commands[0].raw).toContain('body')
    expect(r.commands[1].command).toBe('echo done')
  })
})
