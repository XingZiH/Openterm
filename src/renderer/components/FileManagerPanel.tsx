import React, { useState, useEffect, useRef } from 'react'
import { SFTPFile } from '../types'

interface FileManagerPanelProps {
  sessionId: string
  settings: any
  onClose?: () => void
  onToast: (msg: string, type: 'success' | 'error' | 'info') => void
}

export function FileManagerPanel({ sessionId, settings, onClose, onToast }: FileManagerPanelProps) {
  const [currentPath, setCurrentPath] = useState<string>('/')
  const [files, setFiles] = useState<SFTPFile[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [isDragging, setIsDragging] = useState<boolean>(false)
  const [isEditingPath, setIsEditingPath] = useState<boolean>(false)
  const [editPath, setEditPath] = useState<string>('/')
  const pathInputRef = useRef<HTMLInputElement>(null)

  const fetchDirectory = async (path: string) => {
    setLoading(true)
    try {
      const res = await window.electronAPI.sftp.ls(sessionId, path)
      if (res.success && res.data) {
        setFiles(res.data)
        setCurrentPath(path.replace(/\/+/g, '/'))
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
      // Download file
      let localPath = ''
      if (settings?.defaultDownloadPath) {
        localPath = `${settings.defaultDownloadPath}\\${file.name}`
      } else {
        const res = await window.electronAPI.dialog.selectDirectory()
        if (res.canceled || !res.filePaths.length) return
        localPath = `${res.filePaths[0]}\\${file.name}`
      }

      onToast(`开始下载 ${file.name}...`, 'info')
      try {
        const downloadRes = await window.electronAPI.sftp.download(sessionId, targetPath, localPath)
        if (downloadRes.success) {
          onToast(`下载成功: ${localPath}`, 'success')
        } else {
          onToast(`下载失败: ${downloadRes.error}`, 'error')
        }
      } catch (err: any) {
        onToast(`下载异常: ${err.message}`, 'error')
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
      const localPath = file.path
      const remotePath = currentPath.endsWith('/') ? `${currentPath}${file.name}` : `${currentPath}/${file.name}`
      
      onToast(`开始上传 ${file.name}...`, 'info')
      try {
        const uploadRes = await window.electronAPI.sftp.upload(sessionId, localPath, remotePath)
        if (uploadRes.success) {
          onToast(`上传成功: ${file.name}`, 'success')
        } else {
          onToast(`上传失败: ${uploadRes.error}`, 'error')
        }
      } catch (err: any) {
        onToast(`上传异常: ${err.message}`, 'error')
      }
    }
    
    // Refresh directory after uploads
    fetchDirectory(currentPath)
  }

  const formatSize = (size: number) => {
    if (size === 0) return '-'
    const units = ['B', 'KB', 'MB', 'GB']
    let s = size
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

  const pathParts = currentPath.split('/').filter(Boolean)

  return (
    <div 
      className={`file-manager-panel ${isDragging ? 'dragging' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
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

      <div className="fm-content">
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
              return (
                <tr 
                  key={file.name} 
                  className="fm-file-row" 
                  draggable={isDraggable}
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
                    <span className="fm-filename">{file.name}</span>
                  </td>
                  <td className="td-size">{formatSize(file.size)}</td>
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
}
