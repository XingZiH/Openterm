import { useEffect, useRef, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'

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
  const [menuStyle, setMenuStyle] = useState<{ left: number; top: number; maxHeight: number; visibility: 'hidden' | 'visible' }>({
    left: state.x,
    top: state.y,
    maxHeight: Math.max(120, window.innerHeight - 16),
    visibility: 'hidden'
  })

  const visibleItems = state.items.filter(item => !item.hidden)

  useLayoutEffect(() => {
    if (!state.visible || !menuRef.current) return

    const gap = 8
    const minHeight = 120

    const updatePosition = () => {
      if (!menuRef.current) return

      const menu = menuRef.current
      const viewportWidth = window.visualViewport?.width ?? window.innerWidth
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight

      const maxHeight = Math.max(minHeight, Math.floor(viewportHeight - gap * 2))
      menu.style.maxHeight = `${maxHeight}px`

      const rect = menu.getBoundingClientRect()
      const left = Math.min(Math.max(state.x, gap), Math.max(gap, viewportWidth - rect.width - gap))
      const top = Math.min(Math.max(state.y, gap), Math.max(gap, viewportHeight - rect.height - gap))

      setMenuStyle({ left, top, maxHeight, visibility: 'visible' })
    }

    setMenuStyle(prev => ({ ...prev, visibility: 'hidden' }))
    updatePosition()

    const handleResize = () => updatePosition()
    window.addEventListener('resize', handleResize)
    window.visualViewport?.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      window.visualViewport?.removeEventListener('resize', handleResize)
    }
  }, [state.visible, state.x, state.y, visibleItems.length])

  useEffect(() => {
    if (!state.visible) return

    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }

    document.addEventListener('mousedown', handleClick, true)
    document.addEventListener('keydown', handleKey, true)
    return () => {
      document.removeEventListener('mousedown', handleClick, true)
      document.removeEventListener('keydown', handleKey, true)
    }
  }, [state.visible, onClose])

  if (!state.visible) return null
  if (visibleItems.length === 0) return null

  const menuContent = (
    <div
      ref={menuRef}
      className="context-menu"
      style={{
        left: menuStyle.left,
        top: menuStyle.top,
        maxHeight: `${menuStyle.maxHeight}px`,
        visibility: menuStyle.visibility
      }}
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

  return createPortal(menuContent, document.body)
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
