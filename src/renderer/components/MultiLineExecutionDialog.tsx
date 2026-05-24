import { useEffect, useState } from 'react'
import type { ParsedCommand } from '../utils/multi-line-parser'

export type ItemStatus = 'pending' | 'running' | 'success' | 'failed' | 'timeout' | 'aborted'
export type MultiLineDialogViewMode = 'modal' | 'minimized'

export interface MultiLineExecutionItem {
  command: ParsedCommand
  status: ItemStatus
  exitCode?: number
  runCount?: number
  lastRunAt?: number
}

interface Props {
  open: boolean
  viewMode: MultiLineDialogViewMode
  items: MultiLineExecutionItem[]
  phase: 'idle' | 'running' | 'paused' | 'done' | 'aborted'
  pauseReason?: 'failed' | 'timeout'
  activeMode?: 'batch' | 'single'
  activeIndex?: number
  onStart: () => void
  onContinue: () => void
  onAbort: () => void
  onClose: () => void
  onMinimize: () => void
  onRestore: () => void
  onRunItem: (index: number) => void
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

function getItemActionText(status: ItemStatus): string {
  if (status === 'success') return '重新执行'
  if (status === 'failed' || status === 'timeout' || status === 'aborted') return '重试'
  return '执行'
}

export function MultiLineExecutionDialog({
  open,
  viewMode,
  items,
  phase,
  pauseReason,
  activeMode,
  activeIndex,
  onStart,
  onContinue,
  onAbort,
  onClose,
  onMinimize,
  onRestore,
  onRunItem,
}: Props) {
  useEffect(() => {
    if (!open || viewMode !== 'modal') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (phase === 'running' || phase === 'paused') onAbort()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, viewMode, phase, onAbort, onClose])

  if (!open) return null

  const visibleItems = items.slice(0, MAX_VISIBLE_ITEMS)
  const overflow = items.length - visibleItems.length
  const totalCount = items.length
  const finishedCount = items.filter(
    it => it.status === 'success' || it.status === 'failed' || it.status === 'timeout' || it.status === 'aborted',
  ).length
  const isBusy = phase === 'running'
  const isBatchRunning = isBusy && activeMode === 'batch'

  const phaseText = (() => {
    if (phase === 'running') return activeMode === 'single' && activeIndex != null ? `第 ${activeIndex + 1} 条执行中` : '顺序执行中'
    if (phase === 'paused' && pauseReason) return `已暂停（${pauseReason === 'failed' ? '上一条失败' : '上一条超时'}）`
    if (phase === 'done') return '全部完成'
    if (phase === 'aborted') return '已停止'
    return '待执行'
  })()

  const handleOverlayClick = () => {
    if (phase === 'running') return
    if (phase === 'paused') onAbort()
    onClose()
  }

  if (viewMode === 'minimized') {
    return (
      <div className={`multi-line-floating ${phase}`}>
        <div className="multi-line-floating-main">
          <span className="multi-line-floating-title">多行命令</span>
          <span className="multi-line-floating-progress">{finishedCount} / {totalCount}</span>
          <span className="multi-line-floating-phase">{phaseText}</span>
        </div>
        <div className="multi-line-floating-actions">
          <button className="btn btn-secondary" onClick={onRestore}>恢复</button>
          {phase === 'running' && <button className="btn btn-danger" onClick={onAbort}>停止</button>}
          <button className="btn btn-secondary" onClick={onClose}>关闭</button>
        </div>
      </div>
    )
  }

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div
        className="modal-content multi-line-dialog"
        style={{ width: 620, maxWidth: '90vw' }}
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
          <div className="multi-line-dialog-actions">
            <button className="multi-line-dialog-icon-btn" type="button" onClick={onMinimize} title="最小化">—</button>
            <button className="multi-line-dialog-icon-btn" type="button" onClick={onClose} title={phase === 'running' ? '停止并关闭' : '关闭'}>×</button>
          </div>
        </div>

        <div className="multi-line-dialog-body">
          <ol className="multi-line-list">
            {visibleItems.map((it, i) => {
              const meta = STATUS_LABEL[it.status]
              return (
                <li key={i} className={`multi-line-item ${meta.className}`}>
                  <div className="multi-line-item-status-row">
                    <div className="multi-line-item-status">
                      <span className="multi-line-item-icon">{meta.icon}</span>
                      <span className="multi-line-item-label">
                        {meta.text}
                        {(it.status === 'failed' || it.status === 'timeout') && typeof it.exitCode === 'number' && (
                          <span className="multi-line-item-exit"> exit={it.exitCode}</span>
                        )}
                        {!!it.runCount && it.runCount > 1 && (
                          <span className="multi-line-item-runs">第 {it.runCount} 次</span>
                        )}
                      </span>
                    </div>
                    <button
                      className="btn btn-secondary multi-line-item-run"
                      type="button"
                      disabled={isBusy || it.status === 'running'}
                      onClick={() => onRunItem(i)}
                    >
                      {getItemActionText(it.status)}
                    </button>
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
              <button className="btn btn-primary" onClick={onStart} disabled={isBusy}>▶ 顺序执行</button>
            </>
          )}
          {phase === 'running' && (
            <>
              <button className="btn btn-secondary" onClick={onMinimize}>最小化</button>
              <button className="btn btn-danger" onClick={onAbort}>■ 停止</button>
            </>
          )}
          {phase === 'paused' && (
            <>
              <button className="btn btn-secondary" onClick={() => { onAbort(); onClose() }}>停止</button>
              <button className="btn btn-primary" onClick={onContinue} disabled={activeMode === 'single' || isBatchRunning}>继续执行</button>
            </>
          )}
          {(phase === 'done' || phase === 'aborted') && (
            <>
              <button className="btn btn-secondary" onClick={onStart}>重新顺序执行</button>
              <button className="btn btn-primary" onClick={onClose}>关闭</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
