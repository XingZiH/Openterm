import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle, useCallback } from 'react'
import { SFTPFile } from '../types'

export interface FileManagerPanelHandle {
  startRename: (fileName: string) => void
}

interface FileManagerPanelProps {
  sessionId: string
  settings: any
  onClose?: () => void
  onToast: (msg: string, type: 'success' | 'error' | 'info') => void
  reloadToken?: number
  onStateChange?: (state: { currentPath?: string; selectedFile?: SFTPFile | null; selectedFiles?: SFTPFile[] }) => void
  onContextMenuRequest?: (event: React.MouseEvent, ctx: { currentPath: string; file?: SFTPFile }) => void
  cutFilePath?: string | null
  onEditFile?: (filePath: string, fileName: string) => void
}

const MARQUEE_THRESHOLD = 4

export const FileManagerPanel = forwardRef<FileManagerPanelHandle, FileManagerPanelProps>(function FileManagerPanelInner({ sessionId, settings, onClose, onToast, reloadToken = 0, onStateChange, onContextMenuRequest, cutFilePath, onEditFile }, ref) {
  const [currentPath, setCurrentPath] = useState<string>('/')
  const [files, setFiles] = useState<SFTPFile[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [isDragging, setIsDragging] = useState<boolean>(false)
  const [isEditingPath, setIsEditingPath] = useState<boolean>(false)
  const [editPath, setEditPath] = useState<string>('/')
  const pathInputRef = useRef<HTMLInputElement>(null)
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set())
  const [renamingFile, setRenamingFile] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)

  // Marquee (lasso) selection state
  const contentRef = useRef<HTMLDivElement>(null)
  const marqueeElRef = useRef<HTMLDivElement>(null)
  const [marqueeActive, setMarqueeActive] = useState(false)
  const marqueeRef = useRef<{
    active: boolean
    started: boolean
    originClientX: number
    originClientY: number
    baseSelection: Set<string>
  }>({
    active: false,
    started: false,
    originClientX: 0,
    originClientY: 0,
    baseSelection: new Set<string>()
  })
  const lastMarqueeSelectionRef = useRef<Set<string>>(new Set())

  // Stable refs for accessing latest values inside event listeners
  const onStateChangeRef = useRef(onStateChange)
  onStateChangeRef.current = onStateChange
  const filesRef = useRef(files)
  filesRef.current = files

  const notifySelection = useCallback((names: Set<string>) => {
    if (names.size === 0) {
      onStateChangeRef.current?.({ selectedFile: null, selectedFiles: [] })
    } else {
      const selected = filesRef.current.filter(f => names.has(f.name))
      onStateChangeRef.current?.({ selectedFile: selected[0] || null, selectedFiles: selected })
    }
  }, [])

  const fetchDirectory = async (path: string) => {
    setLoading(true)
    try {
      const res = await window.electronAPI.sftp.ls(sessionId, path)
      if (res.success && res.data) {
        setFiles(res.data)
        const normalized = path.replace(/\/+/g, '/')
        setCurrentPath(normalized)
        setSelectedNames(new Set())
        onStateChange?.({ currentPath: normalized, selectedFile: null })
      } else {
        onToast(`读取目录失败: ${res.error}`, 'error')
      }
    } catch (err: any) {
      onToast(`读取异常: ${err.message}`, 'error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (sessionId) {
      fetchDirectory(currentPath)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, reloadToken])

  useEffect(() => {
    setSelectedNames(new Set())
    onStateChangeRef.current?.({ selectedFile: null })
  }, [sessionId])

  const handleDoubleClick = async (file: SFTPFile) => {
    if (file.name === '..') {
      const parentPath = currentPath === '/' ? '/' : currentPath.split('/').slice(0, -1).join('/') || '/'
      fetchDirectory(parentPath)
      return
    }

    const targetPath = currentPath.endsWith('/') ? `${currentPath}${file.name}` : `${currentPath}/${file.name}`

    if (file.type === 'd') {
      fetchDirectory(targetPath)
    } else {
      // 双击文件：优先打开编辑器
      if (onEditFile) {
        onEditFile(targetPath, file.name)
      } else {
        // 回退：下载文件
        let localPath = ''
        if (settings?.defaultDownloadPath) {
          // 使用正确的路径分隔符：本地路径使用平台分隔符
          const sep = settings.defaultDownloadPath.includes('\\') ? '\\' : '/'
          localPath = `${settings.defaultDownloadPath}${sep}${file.name}`
        } else {
          const res = await window.electronAPI.dialog.selectDirectory()
          if (res.canceled || !res.filePaths.length) return
          // selectDirectory 返回的路径使用平台原生分隔符
          const basePath = res.filePaths[0]
          const sep = basePath.includes('\\') ? '\\' : '/'
          localPath = `${basePath}${sep}${file.name}`
        }

        try {
          const downloadRes = await window.electronAPI.sftp.download(sessionId, targetPath, localPath)
          if (!downloadRes.success) {
            onToast(`下载失败: ${downloadRes.error}`, 'error')
          }
        } catch (err: any) {
          onToast(`下载异常: ${err.message}`, 'error')
        }
      }
    }
  }

  const handleBreadcrumbClick = (index: number) => {
    const parts = currentPath.split('/').filter(Boolean)
    const target = '/' + parts.slice(0, index + 1).join('/')
    fetchDirectory(target)
  }

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!isDragging) setIsDragging(true)
  }

  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    const items = Array.from(e.dataTransfer.files)
    if (items.length === 0) return

    for (const file of items) {
      let localPath = file.path
      if (!localPath) {
        localPath = window.electronAPI.file.getPathForFile(file) || ''
      }
      if (!localPath) {
        onToast(`上传失败: 无法读取本地路径 (${file.name})`, 'error')
        continue
      }
      const remotePath = currentPath.endsWith('/') ? `${currentPath}${file.name}` : `${currentPath}/${file.name}`

      // Check if the dropped item is a directory
      const dirCheck = await window.electronAPI.sftp.isLocalDirectory(localPath)
      const isDirectory = dirCheck.success && dirCheck.isDirectory

      try {
        let uploadRes: { success: boolean; error?: string }
        if (isDirectory) {
          uploadRes = await window.electronAPI.sftp.uploadDir(sessionId, localPath, remotePath)
        } else {
          uploadRes = await window.electronAPI.sftp.upload(sessionId, localPath, remotePath)
        }
        if (!uploadRes.success) {
          onToast(`上传失败: ${uploadRes.error}`, 'error')
        }
      } catch (err: any) {
        onToast(`上传异常: ${err.message}`, 'error')
      }
    }

    // Refresh directory after uploads
    fetchDirectory(currentPath)
  }

  const formatSize = (file: SFTPFile) => {
    if (file.type === 'd') return '-'
    if (file.size === 0) return '-'
    const units = ['B', 'KB', 'MB', 'GB']
    let s = file.size
    let i = 0
    while (s >= 1024 && i < units.length - 1) {
      s /= 1024
      i++
    }
    return `${s.toFixed(i > 0 ? 1 : 0)} ${units[i]}`
  }

  const formatDate = (ts: number) => {
    if (!ts) return '-'
    const d = new Date(ts * 1000)
    return d.toLocaleString()
  }

  const getFileIcon = (file: SFTPFile) => {
    if (file.name === '..') return '🔙'
    if (file.type === 'd') return '📁'
    if (file.type === 'l') return '🔗'
    return '📄'
  }

  const startRename = React.useCallback((fileName: string) => {
    setRenamingFile(fileName)
    setRenameValue(fileName)
    setTimeout(() => renameInputRef.current?.select(), 0)
  }, [])

  const submitRename = async () => {
    if (!renamingFile || !renameValue.trim() || renameValue === renamingFile) {
      setRenamingFile(null)
      return
    }
    const oldPath = currentPath.endsWith('/') ? `${currentPath}${renamingFile}` : `${currentPath}/${renamingFile}`
    const newPath = currentPath.endsWith('/') ? `${currentPath}${renameValue.trim()}` : `${currentPath}/${renameValue.trim()}`
    try {
      const res = await window.electronAPI.sftp.rename(sessionId, oldPath, newPath)
      if (res.success) {
        onToast(`重命名成功: ${renameValue.trim()}`, 'success')
        fetchDirectory(currentPath)
      } else {
        onToast(`重命名失败: ${res.error}`, 'error')
      }
    } catch (err: any) {
      onToast(`重命名异常: ${err.message}`, 'error')
    }
    setRenamingFile(null)
  }

  useImperativeHandle(ref, () => ({
    startRename
  }), [startRename])

  // --- Marquee selection: mousedown on content blank area ---
  const handleContentMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    // Only start marquee from blank area, not from file rows or interactive elements
    if (target.closest('.fm-file-row') || target.closest('th') || target.closest('input') || target.closest('button')) return

    const holdCtrl = e.ctrlKey || e.metaKey
    // Store origin in pure viewport coordinates
    marqueeRef.current = {
      active: true,
      started: false,
      originClientX: e.clientX,
      originClientY: e.clientY,
      baseSelection: holdCtrl ? new Set(selectedNames) : new Set()
    }
    lastMarqueeSelectionRef.current = new Set()

    if (!holdCtrl) {
      setSelectedNames(new Set())
      notifySelection(new Set())
    }

    e.preventDefault()
  }, [selectedNames, notifySelection])

  // --- Marquee selection: document-level mousemove & mouseup ---
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const ms = marqueeRef.current
      if (!ms.active) return

      const contentEl = contentRef.current
      if (!contentEl) return
      const rect = contentEl.getBoundingClientRect()

      // Clamp mouse position to content area bounds (viewport coords)
      const cx = Math.max(rect.left, Math.min(e.clientX, rect.right))
      const cy = Math.max(rect.top, Math.min(e.clientY, rect.bottom))

      // Require minimum drag distance before showing marquee
      if (!ms.started) {
        if (Math.abs(cx - ms.originClientX) < MARQUEE_THRESHOLD && Math.abs(cy - ms.originClientY) < MARQUEE_THRESHOLD) return
        ms.started = true
        setMarqueeActive(true)  // Only one React state update to enable user-select:none
      }

      // Marquee rectangle in pure VIEWPORT coordinates
      const mLeft = Math.min(ms.originClientX, cx)
      const mTop = Math.min(ms.originClientY, cy)
      const mRight = Math.max(ms.originClientX, cx)
      const mBottom = Math.max(ms.originClientY, cy)

      // Update marquee visual directly via ref (avoids React re-render)
      const el = marqueeElRef.current
      if (el) {
        el.style.left = `${mLeft - rect.left + contentEl.scrollLeft}px`
        el.style.top = `${mTop - rect.top + contentEl.scrollTop}px`
        el.style.width = `${mRight - mLeft}px`
        el.style.height = `${mBottom - mTop}px`
        el.style.display = 'block'
      }

      // Intersection test in pure viewport coordinates — zero conversion
      // row.getBoundingClientRect() returns viewport coords natively
      const rows = contentEl.querySelectorAll('tr[data-filename]')
      const newSelection = new Set(ms.baseSelection)
      rows.forEach(row => {
        const rb = row.getBoundingClientRect()
        if (mTop < rb.bottom && mBottom > rb.top && mLeft < rb.right && mRight > rb.left) {
          const filename = row.getAttribute('data-filename')
          if (filename) newSelection.add(filename)
        }
      })

      // Skip re-render if selection hasn't changed
      const prev = lastMarqueeSelectionRef.current
      if (newSelection.size === prev.size && [...newSelection].every(n => prev.has(n))) return
      lastMarqueeSelectionRef.current = newSelection

      setSelectedNames(newSelection)
      notifySelection(newSelection)
    }

    const handleMouseUp = () => {
      if (marqueeRef.current.active) {
        marqueeRef.current.active = false
        marqueeRef.current.started = false
        setMarqueeActive(false)
        // Hide marquee div via ref (no re-render needed)
        if (marqueeElRef.current) marqueeElRef.current.style.display = 'none'
      }
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [notifySelection])

  const pathParts = currentPath.split('/').filter(Boolean)

  return (
    <div
      className={`file-manager-panel ${isDragging ? 'dragging' : ''}`}
      tabIndex={0}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setSelectedNames(new Set())
        notifySelection(new Set())
        onContextMenuRequest?.(e, { currentPath })
      }}
    >
      <div className="fm-header">
        {isEditingPath ? (
          <input
            ref={pathInputRef}
            className="fm-path-input"
            value={editPath}
            onChange={(e) => setEditPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const p = editPath.trim() || '/'
                setIsEditingPath(false)
                fetchDirectory(p)
              } else if (e.key === 'Escape') {
                setIsEditingPath(false)
              }
            }}
            onBlur={() => setIsEditingPath(false)}
            autoFocus
          />
        ) : (
          <div className="fm-breadcrumbs" onDoubleClick={() => {
            setEditPath(currentPath)
            setIsEditingPath(true)
            setTimeout(() => pathInputRef.current?.select(), 0)
          }}>
            <span
              className="fm-breadcrumb-item"
              onClick={() => fetchDirectory('/')}
            >
              🏠 根目录
            </span>
            {pathParts.map((part, i) => (
              <React.Fragment key={i}>
                <span className="fm-breadcrumb-sep">/</span>
                <span
                  className="fm-breadcrumb-item"
                  onClick={() => handleBreadcrumbClick(i)}
                >
                  {part}
                </span>
              </React.Fragment>
            ))}
            {pathParts.length <= 3 && (
              <span className="fm-path-tip">双击编辑路径</span>
            )}
          </div>
        )}
        <div className="fm-actions">
          <button className="fm-refresh-btn" onClick={() => fetchDirectory(currentPath)} disabled={loading}>
            {loading ? '↻ 读取中...' : '↻ 刷新'}
          </button>
          {onClose && (
            <button className="fm-close-btn" onClick={onClose} title="隐藏文件区">
              ×
            </button>
          )}
        </div>
      </div>

      <div
        className={`fm-content${marqueeActive ? ' fm-marqueeing' : ''}`}
        ref={contentRef}
        onMouseDown={handleContentMouseDown}
      >
        <table className="fm-table">
          <thead>
            <tr>
              <th className="th-name">名称</th>
              <th className="th-size">大小</th>
              <th className="th-perms">权限</th>
              <th className="th-time">修改时间</th>
            </tr>
          </thead>
          <tbody>
            {files.map(file => {
              const isDraggable = file.name !== '..'
              const isSelected = selectedNames.has(file.name)
              const filePath = currentPath.endsWith('/') ? `${currentPath}${file.name}` : `${currentPath}/${file.name}`
              const isCutTarget = cutFilePath === filePath
              return (
                <tr
                  key={file.name}
                  data-filename={file.name !== '..' ? file.name : undefined}
                  className={`fm-file-row${isSelected ? ' selected' : ''}${isCutTarget ? ' cut-pending' : ''}`}
                  draggable={isDraggable}
                  onClick={(e) => {
                    if (file.name === '..') {
                      setSelectedNames(new Set())
                      notifySelection(new Set())
                    } else if (e.ctrlKey || e.metaKey) {
                      // Ctrl+click: toggle individual file in multi-selection
                      const next = new Set(selectedNames)
                      if (next.has(file.name)) next.delete(file.name)
                      else next.add(file.name)
                      setSelectedNames(next)
                      notifySelection(next)
                    } else {
                      // Normal click: select only this file
                      setSelectedNames(new Set([file.name]))
                      notifySelection(new Set([file.name]))
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    if (file.name !== '..') {
                      if (!selectedNames.has(file.name)) {
                        // Right-clicking unselected file: select only this file
                        setSelectedNames(new Set([file.name]))
                        notifySelection(new Set([file.name]))
                      }
                      // Right-clicking already selected file: keep current selection
                    } else {
                      setSelectedNames(new Set())
                      notifySelection(new Set())
                    }
                    onContextMenuRequest?.(e, { currentPath, file: file.name === '..' ? undefined : file })
                  }}
                  onDragStart={(e) => {
                    if (!isDraggable) {
                      e.preventDefault()
                      return
                    }
                    const remotePath = currentPath.endsWith('/') ? `${currentPath}${file.name}` : `${currentPath}/${file.name}`
                    e.dataTransfer.setData('application/sftp-file', JSON.stringify({ name: file.name, path: remotePath, size: file.size, type: file.type }))
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                  onDoubleClick={() => handleDoubleClick(file)}
                >
                  <td className="td-name">
                    <span className="fm-icon">{getFileIcon(file)}</span>
                    {renamingFile === file.name ? (
                      <input
                        ref={renameInputRef}
                        className="fm-rename-input"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') submitRename()
                          else if (e.key === 'Escape') setRenamingFile(null)
                        }}
                        onBlur={() => submitRename()}
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <span className="fm-filename">{file.name}</span>
                    )}
                  </td>
                  <td className="td-size">{formatSize(file)}</td>
                  <td className="td-perms">{file.permissions}</td>
                  <td className="td-time">{formatDate(file.modifyTime)}</td>
                </tr>
              )
            })}
            {files.length === 0 && !loading && (
              <tr>
                <td colSpan={4} className="fm-empty-state">当前目录为空</td>
              </tr>
            )}
          </tbody>
        </table>

        <div
          ref={marqueeElRef}
          className="fm-marquee"
          style={{ display: 'none' }}
        />

        {isDragging && (
          <div className="fm-drop-overlay">
            <div className="fm-drop-message">
              <span>📥</span>
              <p>松开鼠标立即上传至当前目录</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
})
