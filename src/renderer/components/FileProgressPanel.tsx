import React, { useState, useEffect, useRef, useCallback } from 'react'
import type { FileProgressEvent } from '../types'

interface FileTask {
  taskId: string
  type: FileProgressEvent['type']
  fileName: string
  status: FileProgressEvent['status']
  progress: number
  error?: string
  totalBytes?: number
  transferredBytes?: number
  startTime: number
}

const TYPE_LABELS: Record<FileTask['type'], string> = {
  upload: '上传',
  download: '下载',
  downloadDir: '下载文件夹',
  copy: '复制',
  move: '移动',
  delete: '删除',
  uploadDir: '上传文件夹'
}

const TYPE_ICONS: Record<FileTask['type'], string> = {
  upload: '\u2B06',
  download: '\u2B07',
  downloadDir: '\uD83D\uDCC2',
  copy: '\u2398',
  move: '\u21C4',
  delete: '\u2716',
  uploadDir: '\uD83D\uDCC1'
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let s = bytes
  let i = 0
  while (s >= 1024 && i < units.length - 1) {
    s /= 1024
    i++
  }
  return `${s.toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

export function FileProgressPanel() {
  const [tasks, setTasks] = useState<Map<string, FileTask>>(new Map())
  const [collapsed, setCollapsed] = useState(false)
  const autoRemoveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const handleProgress = useCallback((event: FileProgressEvent) => {
    setTasks(prev => {
      const next = new Map(prev)
      const existing = next.get(event.taskId)

      if (event.status === 'started') {
        next.set(event.taskId, {
          ...event,
          startTime: Date.now()
        })
      } else if (existing) {
        next.set(event.taskId, {
          ...existing,
          status: event.status,
          progress: event.progress,
          error: event.error,
          totalBytes: event.totalBytes ?? existing.totalBytes,
          transferredBytes: event.transferredBytes ?? existing.transferredBytes
        })
      }
      return next
    })

    if (event.status === 'completed' || event.status === 'error') {
      const timerId = setTimeout(() => {
        setTasks(prev => {
          const next = new Map(prev)
          next.delete(event.taskId)
          return next
        })
        autoRemoveTimers.current.delete(event.taskId)
      }, event.status === 'completed' ? 3000 : 8000)
      autoRemoveTimers.current.set(event.taskId, timerId)
    }
  }, [])

  useEffect(() => {
    const off = window.electronAPI.fileProgress.onProgress(handleProgress)
    return () => {
      off()
      for (const timer of autoRemoveTimers.current.values()) clearTimeout(timer)
    }
  }, [handleProgress])

  const dismissTask = useCallback((taskId: string) => {
    setTasks(prev => {
      const next = new Map(prev)
      next.delete(taskId)
      return next
    })
    const timer = autoRemoveTimers.current.get(taskId)
    if (timer) {
      clearTimeout(timer)
      autoRemoveTimers.current.delete(taskId)
    }
  }, [])

  const clearCompleted = useCallback(() => {
    setTasks(prev => {
      const next = new Map(prev)
      for (const [id, task] of next) {
        if (task.status === 'completed' || task.status === 'error') {
          next.delete(id)
          const timer = autoRemoveTimers.current.get(id)
          if (timer) { clearTimeout(timer); autoRemoveTimers.current.delete(id) }
        }
      }
      return next
    })
  }, [])

  if (tasks.size === 0) return null

  const taskList = Array.from(tasks.values())
  const activeCount = taskList.filter(t => t.status === 'started' || t.status === 'progress').length
  const completedCount = taskList.filter(t => t.status === 'completed').length
  const errorCount = taskList.filter(t => t.status === 'error').length

  return (
    <div className="fp-panel">
      <div className="fp-header" onClick={() => setCollapsed(!collapsed)}>
        <div className="fp-header-left">
          <span className={`fp-collapse-icon ${collapsed ? 'collapsed' : ''}`}>{'\u25BC'}</span>
          <span className="fp-header-title">
            {activeCount > 0
              ? `${activeCount} 个任务进行中`
              : completedCount > 0 && errorCount === 0
                ? '全部完成'
                : errorCount > 0
                  ? `${errorCount} 个任务失败`
                  : '文件操作'}
          </span>
        </div>
        <div className="fp-header-right">
          {(completedCount > 0 || errorCount > 0) && (
            <button className="fp-clear-btn" onClick={(e) => { e.stopPropagation(); clearCompleted() }}>
              清除
            </button>
          )}
        </div>
      </div>

      {!collapsed && (
        <div className="fp-task-list">
          {taskList.map(task => (
            <div key={task.taskId} className={`fp-task ${task.status === 'completed' ? 'fp-task-completed' : task.status === 'error' ? 'fp-task-error-state' : ''}`}>
              <div className="fp-task-row">
                <span className="fp-task-icon">{TYPE_ICONS[task.type]}</span>
                <div className="fp-task-info">
                  <span className="fp-task-name" title={task.fileName}>{task.fileName}</span>
                  <span className="fp-task-label">
                    {task.status === 'completed'
                      ? `${TYPE_LABELS[task.type]}完成`
                      : task.status === 'error'
                        ? `${TYPE_LABELS[task.type]}失败`
                        : `${TYPE_LABELS[task.type]}中...`}
                    {task.status === 'progress' && task.transferredBytes != null && task.totalBytes != null && task.totalBytes > 0 && task.type !== 'uploadDir' && (
                      <> - {formatBytes(task.transferredBytes)} / {formatBytes(task.totalBytes)}</>
                    )}
                    {task.status === 'progress' && task.type === 'uploadDir' && task.transferredBytes != null && task.totalBytes != null && (
                      <> - {task.transferredBytes} / {task.totalBytes} 个文件</>
                    )}
                  </span>
                </div>
                <button className="fp-task-dismiss" onClick={() => dismissTask(task.taskId)} title="关闭">
                  {'\u2715'}
                </button>
              </div>
              <div className="fp-progress-track">
                {task.progress >= 0 ? (
                  <div
                    className={`fp-progress-bar fp-progress-${task.status}`}
                    style={{ width: `${Math.min(task.progress, 100)}%` }}
                  />
                ) : (
                  <div className="fp-progress-bar fp-progress-indeterminate" />
                )}
              </div>
              {task.status === 'error' && task.error && (
                <div className="fp-task-errmsg" title={task.error}>{task.error}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
