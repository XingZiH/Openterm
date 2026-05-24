import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'

interface FileEditorPanelProps {
  sessionId: string
  filePath: string
  fileName: string
  onClose: () => void
  onToast: (msg: string, type: 'success' | 'error' | 'info') => void
  onSaved?: () => void
}

// 根据文件扩展名推断语言（用于显示）
function detectLanguage(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  const langMap: Record<string, string> = {
    js: 'JavaScript', ts: 'TypeScript', tsx: 'TSX', jsx: 'JSX',
    py: 'Python', java: 'Java', go: 'Go', rs: 'Rust', rb: 'Ruby',
    cpp: 'C++', c: 'C', h: 'C/C++ Header', cs: 'C#',
    html: 'HTML', css: 'CSS', scss: 'SCSS', less: 'LESS',
    json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML',
    xml: 'XML', sql: 'SQL', sh: 'Shell', bash: 'Bash',
    md: 'Markdown', txt: 'Text', log: 'Log',
    dockerfile: 'Dockerfile', makefile: 'Makefile',
    conf: 'Config', ini: 'INI', env: 'Env',
  }
  return langMap[ext] || ext.toUpperCase() || 'Text'
}

export function FileEditorPanel({ sessionId, filePath, fileName, onClose, onToast, onSaved }: FileEditorPanelProps) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fileSize, setFileSize] = useState(0)
  const [isDirty, setIsDirty] = useState(false)
  const [lineCount, setLineCount] = useState(0)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // 用 ref 保存原始内容，避免大字符串进入 React state
  const originalContentRef = useRef<string>('')
  const statusUpdateTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 获取当前编辑器内容（从 DOM 直接读取，不经过 React state）
  const getCurrentContent = useCallback(() => {
    return textareaRef.current?.value ?? ''
  }, [])

  // 延迟更新状态栏信息（行数、dirty 状态），避免每次按键都触发 re-render
  const scheduleStatusUpdate = useCallback(() => {
    if (statusUpdateTimer.current) clearTimeout(statusUpdateTimer.current)
    statusUpdateTimer.current = setTimeout(() => {
      const val = getCurrentContent()
      setIsDirty(val !== originalContentRef.current)
      setLineCount(val.split('\n').length)
    }, 300)
  }, [getCurrentContent])

  const loadFile = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await window.electronAPI.sftp.readFile(sessionId, filePath)
      if (!res.success) {
        setError(res.error || '读取失败')
        return
      }
      const text = res.content || ''
      originalContentRef.current = text
      setFileSize(res.size || 0)
      setLineCount(text.split('\n').length)
      setIsDirty(false)
      // 非受控：直接设置 DOM value
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.value = text
        }
      })
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [sessionId, filePath])

  useEffect(() => {
    loadFile()
    return () => {
      if (statusUpdateTimer.current) clearTimeout(statusUpdateTimer.current)
    }
  }, [loadFile])

  const handleSave = useCallback(async () => {
    if (saving) return
    const content = getCurrentContent()
    if (content === originalContentRef.current) return
    setSaving(true)
    try {
      const res = await window.electronAPI.sftp.writeFile(sessionId, filePath, content)
      if (res.success) {
        originalContentRef.current = content
        setIsDirty(false)
        setFileSize(new Blob([content]).size)
        onToast('文件已保存', 'success')
        onSaved?.()
      } else {
        onToast(`保存失败: ${res.error}`, 'error')
      }
    } catch (err: any) {
      onToast(`保存异常: ${err.message}`, 'error')
    } finally {
      setSaving(false)
    }
  }, [sessionId, filePath, saving, getCurrentContent, onToast, onSaved])

  // Ctrl+S 保存快捷键（仅编辑器面板内触发）
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const mod = navigator.platform.includes('Mac') ? e.metaKey : e.ctrlKey
      if (mod && e.key === 's') {
        const panel = panelRef.current
        if (!panel || !panel.contains(document.activeElement as Node)) return
        e.preventDefault()
        handleSave()
      }
    }
    window.addEventListener('keydown', handleKey, true)
    return () => window.removeEventListener('keydown', handleKey, true)
  }, [handleSave])

  // Tab 键输入支持
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault()
      const textarea = textareaRef.current
      if (!textarea) return
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      const val = textarea.value
      textarea.value = val.substring(0, start) + '  ' + val.substring(end)
      textarea.selectionStart = textarea.selectionEnd = start + 2
      scheduleStatusUpdate()
    }
  }

  const handleClose = () => {
    const content = getCurrentContent()
    if (content !== originalContentRef.current) {
      const confirmed = window.confirm('文件有未保存的更改，确定关闭吗？')
      if (!confirmed) return
    }
    onClose()
  }

  const formatSize = (size: number) => {
    if (size === 0) return '0 B'
    const units = ['B', 'KB', 'MB']
    let s = size
    let i = 0
    while (s >= 1024 && i < units.length - 1) { s /= 1024; i++ }
    return `${s.toFixed(i > 0 ? 1 : 0)} ${units[i]}`
  }

  const language = useMemo(() => detectLanguage(fileName), [fileName])

  return (
    <div className="file-editor-panel" ref={panelRef}>
      <div className="fe-header">
        <div className="fe-title">
          <span className="fe-icon">✏️</span>
          <span className="fe-filename" title={filePath}>{fileName}</span>
          {isDirty && <span className="fe-dirty-badge">未保存</span>}
        </div>
        <div className="fe-actions">
          <button
            className="fe-save-btn"
            onClick={handleSave}
            disabled={!isDirty || saving}
            title="Ctrl+S"
          >
            {saving ? '保存中...' : '保存'}
          </button>
          <button className="fe-close-btn" onClick={handleClose} title="关闭编辑器">×</button>
        </div>
      </div>

      <div className="fe-body">
        {loading ? (
          <div className="fe-loading">读取文件中...</div>
        ) : error ? (
          <div className="fe-error">
            <span>⚠️ {error}</span>
            <button className="btn btn-secondary" onClick={onClose}>关闭</button>
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            className="fe-textarea"
            defaultValue=""
            onInput={scheduleStatusUpdate}
            onKeyDown={handleKeyDown}
            spellCheck={false}
            autoFocus
          />
        )}
      </div>

      {!loading && !error && (
        <div className="fe-statusbar">
          <span>{language}</span>
          <span>{lineCount} 行</span>
          <span>{formatSize(fileSize)}</span>
          <span>UTF-8</span>
        </div>
      )}
    </div>
  )
}
