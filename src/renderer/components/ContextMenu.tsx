import { useEffect, useRef, useCallback } from 'react'

export interface ContextMenuItem {
  id: string
  label: string
  icon?: string
  shortcut?: string
  disabled?: boolean
  hidden?: boolean
  danger?: boolean
  separator?: boolean
  onClick?: () => void
}

export interface ContextMenuState {
  visible: boolean
  x: number
  y: number
  items: ContextMenuItem[]
}

interface ContextMenuProps {
  state: ContextMenuState
  onClose: () => void
}

export const INITIAL_CONTEXT_MENU_STATE: ContextMenuState = {
  visible: false,
  x: 0,
  y: 0,
  items: []
}

export function ContextMenu({ state, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  const adjustPosition = useCallback(() => {
    if (!menuRef.current || !state.visible) return
    const menu = menuRef.current
    const rect = menu.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight

    let x = state.x
    let y = state.y

    if (x + rect.width > vw) x = vw - rect.width - 4
    if (y + rect.height > vh) y = vh - rect.height - 4
    if (x < 0) x = 4
    if (y < 0) y = 4

    menu.style.left = `${x}px`
    menu.style.top = `${y}px`
  }, [state.x, state.y, state.visible])

  useEffect(() => {
    if (!state.visible) return
    adjustPosition()
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const handleScroll = () => onClose()
    document.addEventListener('mousedown', handleClick, true)
    document.addEventListener('keydown', handleKey, true)
    window.addEventListener('scroll', handleScroll, true)
    return () => {
      document.removeEventListener('mousedown', handleClick, true)
      document.removeEventListener('keydown', handleKey, true)
      window.removeEventListener('scroll', handleScroll, true)
    }
  }, [state.visible, onClose, adjustPosition])

  if (!state.visible) return null

  const visibleItems = state.items.filter(item => !item.hidden)
  if (visibleItems.length === 0) return null

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: state.x, top: state.y }}
    >
      {visibleItems.map((item, index) => {
        if (item.separator) {
          return <div key={`sep-${index}`} className="context-menu-separator" />
        }
        return (
          <div
            key={item.id}
            className={`context-menu-item${item.disabled ? ' disabled' : ''}${item.danger ? ' danger' : ''}`}
            onClick={() => {
              if (item.disabled) return
              onClose()
              item.onClick?.()
            }}
          >
            {item.icon && <span className="context-menu-icon">{item.icon}</span>}
            <span className="context-menu-label">{item.label}</span>
            {item.shortcut && <span className="context-menu-shortcut">{item.shortcut}</span>}
          </div>
        )
      })}
    </div>
  )
}

export function buildTerminalMenuItems(opts: {
  hasSelection: boolean
  onCopy: () => void
  onPaste: () => void
  onSelectAll: () => void
  onClear: () => void
  isMac: boolean
}): ContextMenuItem[] {
  const copyShortcut = opts.isMac ? '⌘C' : 'Ctrl+Shift+C'
  const pasteShortcut = opts.isMac ? '⌘V' : 'Ctrl+Shift+V'
  const selectAllShortcut = opts.isMac ? '⌘A' : 'Ctrl+Shift+A'
  return [
    {
      id: 'term-copy',
      label: '复制',
      icon: '📋',
      shortcut: copyShortcut,
      disabled: !opts.hasSelection,
      onClick: opts.onCopy
    },
    {
      id: 'term-paste',
      label: '粘贴',
      icon: '📌',
      shortcut: pasteShortcut,
      onClick: opts.onPaste
    },
    { id: 'sep1', label: '', separator: true },
    {
      id: 'term-select-all',
      label: '全选',
      icon: '🔲',
      shortcut: selectAllShortcut,
      onClick: opts.onSelectAll
    },
    { id: 'sep2', label: '', separator: true },
    {
      id: 'term-clear',
      label: '清屏',
      icon: '🧹',
      onClick: opts.onClear
    }
  ]
}

export function buildFileMenuItems(opts: {
  hasFile: boolean
  fileName?: string
  isDirectory?: boolean
  onCopyFile: () => void
  onCutFile: () => void
  onPasteFile: () => void
  onRename: () => void
  onDelete: () => void
  onDownload: () => void
  onRefresh: () => void
  onCopyPath: () => void
  onCreateFile: () => void
  onCreateFolder: () => void
  onEdit?: () => void
  hasClipboard: boolean
  isMac: boolean
}): ContextMenuItem[] {
  const mod = opts.isMac ? '⌘' : 'Ctrl+'
  return [
    {
      id: 'file-edit',
      label: '编辑文件',
      icon: '✏️',
      disabled: !opts.hasFile || !!opts.isDirectory,
      hidden: !opts.hasFile || !!opts.isDirectory,
      onClick: opts.onEdit
    },
    {
      id: 'file-new-file',
      label: '新建文件',
      icon: '📄',
      onClick: opts.onCreateFile
    },
    {
      id: 'file-new-folder',
      label: '新建文件夹',
      icon: '📁',
      onClick: opts.onCreateFolder
    },
    { id: 'sep0', label: '', separator: true },
    {
      id: 'file-copy',
      label: '复制',
      icon: '📋',
      shortcut: `${mod}C`,
      disabled: !opts.hasFile,
      onClick: opts.onCopyFile
    },
    {
      id: 'file-cut',
      label: '剪切',
      icon: '✂️',
      shortcut: `${mod}X`,
      disabled: !opts.hasFile,
      onClick: opts.onCutFile
    },
    {
      id: 'file-paste',
      label: '粘贴',
      icon: '📌',
      shortcut: `${mod}V`,
      disabled: !opts.hasClipboard,
      onClick: opts.onPasteFile
    },
    { id: 'sep1', label: '', separator: true },
    {
      id: 'file-rename',
      label: '重命名',
      icon: '✏️',
      shortcut: 'F2',
      disabled: !opts.hasFile,
      onClick: opts.onRename
    },
    {
      id: 'file-delete',
      label: '删除',
      icon: '🗑️',
      shortcut: 'Del',
      disabled: !opts.hasFile,
      danger: true,
      onClick: opts.onDelete
    },
    { id: 'sep2', label: '', separator: true },
    {
      id: 'file-download',
      label: opts.isDirectory ? '下载文件夹' : '下载',
      icon: '⬇️',
      disabled: !opts.hasFile,
      onClick: opts.onDownload
    },
    {
      id: 'file-copy-path',
      label: '复制路径',
      icon: '📎',
      disabled: !opts.hasFile,
      onClick: opts.onCopyPath
    },
    { id: 'sep3', label: '', separator: true },
    {
      id: 'file-refresh',
      label: '刷新',
      icon: '🔄',
      shortcut: 'F5',
      onClick: opts.onRefresh
    }
  ]
}
