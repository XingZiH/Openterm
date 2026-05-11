import { useEffect, useState } from 'react'
import type { ParsedCommand } from '../utils/multi-line-parser'

export type ItemStatus = 'pending' | 'running' | 'success' | 'failed' | 'timeout' | 'aborted'

export interface MultiLineExecutionItem {
  command: ParsedCommand
  status: ItemStatus
  exitCode?: number
}

interface Props {
  open: boolean
  items: MultiLineExecutionItem[]
  // 主流程状态：idle 表示尚未开始，running/paused/done/aborted 见执行器
  phase: 'idle' | 'running' | 'paused' | 'done' | 'aborted'
  pauseReason?: 'failed' | 'timeout'
  onStart: () => void
  onContinue: () => void
  onAbort: () => void
  onClose: () => void
}

const STATUS_LABEL: Record<ItemStatus, { icon: string; text: string; className: string }> = {
  pending: { icon: '⏸', text: '待执行', className: 'pending' },
  running: { icon: '▶', text: '执行中', className: 'running' },
  success: { icon: '✓', text: '已完成', className: 'success' },
  failed: { icon: '✗', text: '失败', className: 'failed' },
  timeout: { icon: '⏱', text: '超时', className: 'timeout' },
  aborted: { icon: '■', text: '已停止', className: 'aborted' },
}

const MAX_VISIBLE_ITEMS = 50

function CommandText({ raw }: { raw: string }) {
  const lines = raw.split('\n')
  const [expanded, setExpanded] = useState(false)
  if (lines.length <= 2) {
    return <pre className="multi-line-cmd-text">{raw}</pre>
  }
  return (
    <div className="multi-line-cmd-text">
      <pre>{expanded ? raw : lines.slice(0, 2).join('\n') + '\n…'}</pre>
      <button
        className="multi-line-cmd-toggle"
        type="button"
        onClick={() => setExpanded(v => !v)}
      >
        {expanded ? '收起' : `展开（共 ${lines.length} 行）`}
      </button>
    </div>
  )
}

export function MultiLineExecutionDialog({
  open,
  items,
  phase,
  pauseReason,
  onStart,
  onContinue,
  onAbort,
  onClose,
}: Props) {
  // Esc 等价 abort + close
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (phase === 'running' || phase === 'paused') onAbort()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, phase, onAbort, onClose])

  if (!open) return null

  const visibleItems = items.slice(0, MAX_VISIBLE_ITEMS)
  const overflow = items.length - visibleItems.length

  const totalCount = items.length
  const finishedCount = items.filter(
    it => it.status === 'success' || it.status === 'failed' || it.status === 'timeout' || it.status === 'aborted',
  ).length

  const handleOverlayClick = () => {
    if (phase === 'running') return // 执行中不允许遮罩关闭
    if (phase === 'paused') onAbort()
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div
        className="modal-content multi-line-dialog"
        style={{ width: 560, maxWidth: '90vw' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="multi-line-dialog-header">
          <span className="multi-line-dialog-title">
            粘贴包含 {totalCount} 条命令
            {phase === 'running' && (
              <span className="multi-line-dialog-progress">
                {finishedCount} / {totalCount}
              </span>
            )}
            {phase === 'paused' && pauseReason && (
              <span className={`multi-line-dialog-progress ${pauseReason}`}>
                已暂停（{pauseReason === 'failed' ? '上一条失败' : '上一条超时'}）
              </span>
            )}
            {phase === 'done' && (
              <span className="multi-line-dialog-progress success">全部完成</span>
            )}
          </span>
        </div>

        <div className="multi-line-dialog-body">
          <ol className="multi-line-list">
            {visibleItems.map((it, i) => {
              const meta = STATUS_LABEL[it.status]
              return (
                <li key={i} className={`multi-line-item ${meta.className}`}>
                  <div className="multi-line-item-status">
                    <span className="multi-line-item-icon">{meta.icon}</span>
                    <span className="multi-line-item-label">
                      {meta.text}
                      {(it.status === 'failed' || it.status === 'timeout') && typeof it.exitCode === 'number' && (
                        <span className="multi-line-item-exit"> exit={it.exitCode}</span>
                      )}
                    </span>
                  </div>
                  <CommandText raw={it.command.raw} />
                </li>
              )
            })}
          </ol>
          {overflow > 0 && (
            <div className="multi-line-overflow">还有 {overflow} 条已折叠（执行不受影响）</div>
          )}
        </div>

        <div className="multi-line-dialog-footer">
          {phase === 'idle' && (
            <>
              <button className="btn btn-secondary" onClick={onClose}>取消</button>
              <button className="btn btn-primary" onClick={onStart}>▶ 顺序执行</button>
            </>
          )}
          {phase === 'running' && (
            <button className="btn btn-danger" onClick={() => { onAbort(); onClose() }}>■ 停止</button>
          )}
          {phase === 'paused' && (
            <>
              <button className="btn btn-secondary" onClick={() => { onAbort(); onClose() }}>停止</button>
              <button className="btn btn-primary" onClick={onContinue}>继续执行</button>
            </>
          )}
          {(phase === 'done' || phase === 'aborted') && (
            <button className="btn btn-primary" onClick={onClose}>关闭</button>
          )}
        </div>
      </div>
    </div>
  )
}
