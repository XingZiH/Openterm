import { useEffect, useMemo, useRef, useState } from 'react'

type FileContextMenuRenderPayload = {
  requestId: string
  items: Array<{
    id: string
    label: string
    shortcut?: string
    type: 'normal' | 'separator'
    enabled: boolean
    danger: boolean
  }>
}

export function FileContextMenuWindow() {
  const [payload, setPayload] = useState<FileContextMenuRenderPayload | null>(null)
  const [activeIndex, setActiveIndex] = useState(-1)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const payloadRef = useRef<FileContextMenuRenderPayload | null>(null)
  const activeIndexRef = useRef(-1)
  const navigableIndexesRef = useRef<number[]>([])

  const items = useMemo(() => payload?.items ?? [], [payload])
  const navigableIndexes = useMemo(() => {
    return items.reduce<number[]>((acc, item, index) => {
      if (item.type === 'normal' && item.enabled) acc.push(index)
      return acc
    }, [])
  }, [items])

  useEffect(() => {
    payloadRef.current = payload
  }, [payload])

  useEffect(() => {
    activeIndexRef.current = activeIndex
  }, [activeIndex])

  useEffect(() => {
    navigableIndexesRef.current = navigableIndexes
  }, [navigableIndexes])

  useEffect(() => {
    if (navigableIndexes.length === 0) {
      setActiveIndex(-1)
      return
    }

    const firstIndex = navigableIndexes[0]
    setActiveIndex(firstIndex)
    requestAnimationFrame(() => {
      itemRefs.current[firstIndex]?.focus()
    })
  }, [payload?.requestId, navigableIndexes])

  useEffect(() => {
    if (activeIndex < 0) return
    itemRefs.current[activeIndex]?.focus()
  }, [activeIndex])

  useEffect(() => {
    window.electronAPI.nativeMenu.notifyFileContextReady()
    const offRender = window.electronAPI.nativeMenu.onFileContextRender((nextPayload) => {
      itemRefs.current = []
      setPayload(nextPayload)
    })

    return () => {
      offRender()
    }
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        window.electronAPI.nativeMenu.hideFileContextMenu()
        return
      }

      const indexes = navigableIndexesRef.current
      if (indexes.length === 0) return

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const currentPos = indexes.indexOf(activeIndexRef.current)
        let nextPos = 0

        if (currentPos < 0) {
          nextPos = event.key === 'ArrowDown' ? 0 : indexes.length - 1
        } else {
          nextPos = event.key === 'ArrowDown'
            ? (currentPos + 1) % indexes.length
            : (currentPos - 1 + indexes.length) % indexes.length
        }

        setActiveIndex(indexes[nextPos])
        return
      }

      if (event.key === 'Enter') {
        const currentPayload = payloadRef.current
        const currentIndex = activeIndexRef.current
        if (!currentPayload || currentIndex < 0) return

        const target = currentPayload.items[currentIndex]
        if (!target || target.type !== 'normal' || !target.enabled) return

        event.preventDefault()
        window.electronAPI.nativeMenu.sendFileContextAction(currentPayload.requestId, target.id)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  return (
    <div className="file-context-menu-window" onContextMenu={(event) => event.preventDefault()}>
      <div className="file-context-menu-panel" role="menu" aria-label="文件右键菜单">
        {items.map((item, index) => {
          if (item.type === 'separator') {
            return <div key={`separator-${index}`} className="file-context-menu-separator" role="separator" />
          }

          const isActive = index === activeIndex
          return (
            <button
              key={item.id}
              ref={(el) => {
                itemRefs.current[index] = el
              }}
              type="button"
              role="menuitem"
              className={`file-context-menu-item${item.danger ? ' danger' : ''}${isActive ? ' active' : ''}`}
              disabled={!item.enabled}
              tabIndex={isActive ? 0 : -1}
              onMouseEnter={() => {
                if (item.enabled) setActiveIndex(index)
              }}
              onClick={() => {
                if (!payload || !item.enabled) return
                window.electronAPI.nativeMenu.sendFileContextAction(payload.requestId, item.id)
              }}
            >
              <span className="file-context-menu-label">{item.label}</span>
              {item.shortcut && <span className="file-context-menu-shortcut">{item.shortcut}</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}
