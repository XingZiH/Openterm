import { app, BrowserWindow, ipcMain, shell, safeStorage, dialog, clipboard, screen } from 'electron'
import { join, dirname, basename, extname } from 'path'
import { readFileSync, promises as fsPromises } from 'fs'
import { cp as fsCp } from 'fs/promises'
import { exec } from 'child_process'
import { promisify } from 'util'
import { randomUUID } from 'crypto'

const execAsync = promisify(exec)
import { SSHManager, shellEscape } from './ssh-manager'
import { Store } from './store'
import { AiService } from './ai-service'
import { LocalPtyManager } from './local-pty'
import { getConfigPath } from './config-file'
import { MAX_EDIT_FILE_SIZE, localFileManager } from './local-file-manager'

const isDev = process.env.NODE_ENV === 'development'
const MAX_FILE_MENU_ITEMS = 40
const MAX_FILE_MENU_LABEL_LENGTH = 80
const FILE_MENU_WIDTH = 236
const FILE_MENU_ITEM_HEIGHT = 30
const FILE_MENU_SEPARATOR_HEIGHT = 8
const FILE_MENU_PADDING = 6

type FileContextMenuItem = {
  id: string
  label?: string
  shortcut?: string
  type?: 'normal' | 'separator'
  enabled?: boolean
  danger?: boolean
}

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

let fileContextMenuWindow: BrowserWindow | null = null
let pendingFileContextMenuPayload: FileContextMenuRenderPayload | null = null
let isFileContextMenuLoaded = false

let mainWindow: BrowserWindow | null = null

// --- File progress helper ---
type FileProgressEvent = {
  taskId: string
  type: 'upload' | 'download' | 'copy' | 'delete' | 'move' | 'uploadDir'
  fileName: string
  status: 'started' | 'progress' | 'completed' | 'error'
  progress: number
  error?: string
  totalBytes?: number
  transferredBytes?: number
}

function sendFileProgress(event: FileProgressEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('file-progress', event)
  }
}

// Throttled progress sender: at most once per 100ms per task, but always sends started/completed/error immediately
const progressThrottleMap = new Map<string, { timer: ReturnType<typeof setTimeout>; pending: FileProgressEvent | null }>()

function sendFileProgressThrottled(event: FileProgressEvent) {
  if (event.status !== 'progress') {
    // started/completed/error: send immediately and clean up throttle
    const entry = progressThrottleMap.get(event.taskId)
    if (entry) {
      clearInterval(entry.timer)
      progressThrottleMap.delete(event.taskId)
    }
    sendFileProgress(event)
    return
  }

  const existing = progressThrottleMap.get(event.taskId)
  if (existing) {
    // Already throttled: just update pending
    existing.pending = event
    return
  }

  // First progress event: send immediately, then throttle subsequent
  sendFileProgress(event)
  progressThrottleMap.set(event.taskId, {
    pending: null,
    timer: setInterval(() => {
      const entry = progressThrottleMap.get(event.taskId)
      if (entry?.pending) {
        sendFileProgress(entry.pending)
        entry.pending = null
      }
    }, 100)
  })
}

function extractFileName(filePath: string): string {
  return filePath.split(/[/\\]/).filter(Boolean).pop() || filePath
}

// Generate a unique local path by appending (1), (2), ... if the file already exists
// expectedType: 'file' 时若已存在同名目录也视为冲突，'directory' 时若已存在同名文件也视为冲突
async function getUniqueLocalPath(targetPath: string, expectedType?: 'file' | 'directory'): Promise<string> {
  const getPathKind = async (p: string): Promise<'missing' | 'file' | 'directory' | 'other'> => {
    try {
      const stat = await fsPromises.stat(p)
      if (stat.isDirectory()) return 'directory'
      if (stat.isFile()) return 'file'
      return 'other'
    } catch {
      return 'missing'
    }
  }

  const isConflict = async (p: string): Promise<boolean> => {
    const kind = await getPathKind(p)
    if (kind === 'missing') return false
    return true
  }

  if (!(await isConflict(targetPath))) return targetPath

  const dir = dirname(targetPath)
  const isDirectoryTarget = expectedType === 'directory'
  const ext = isDirectoryTarget ? '' : extname(targetPath)
  const base = isDirectoryTarget ? basename(targetPath) : basename(targetPath, ext)

  let counter = 1
  while (true) {
    const candidate = join(dir, `${base} (${counter})${ext}`)
    if (!(await isConflict(candidate))) return candidate
    counter++
  }
}

const sshManager = new SSHManager()
const store = new Store()
const aiService = new AiService()
const localPtyManager = new LocalPtyManager()

function estimateFileContextMenuHeight(items: FileContextMenuRenderPayload['items']): number {
  const bodyHeight = items.reduce((height, item) => {
    return height + (item.type === 'separator' ? FILE_MENU_SEPARATOR_HEIGHT : FILE_MENU_ITEM_HEIGHT)
  }, 0)
  return Math.max(80, bodyHeight + FILE_MENU_PADDING * 2)
}

function createFileContextMenuWindow(): BrowserWindow {
  if (fileContextMenuWindow && !fileContextMenuWindow.isDestroyed()) {
    return fileContextMenuWindow
  }

  fileContextMenuWindow = new BrowserWindow({
    width: FILE_MENU_WIDTH,
    height: 200,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: true,
    transparent: true,
    backgroundColor: '#00000000',
    parent: mainWindow ?? undefined,
    hasShadow: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  fileContextMenuWindow.on('closed', () => {
    fileContextMenuWindow = null
    isFileContextMenuLoaded = false
    pendingFileContextMenuPayload = null
  })

  fileContextMenuWindow.on('blur', () => {
    if (fileContextMenuWindow && !fileContextMenuWindow.isDestroyed()) {
      fileContextMenuWindow.hide()
    }
  })

  fileContextMenuWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    fileContextMenuWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/file-context-menu.html`)
  } else {
    fileContextMenuWindow.loadFile(join(__dirname, '../renderer/file-context-menu.html'))
  }

  fileContextMenuWindow.webContents.once('did-finish-load', () => {
    isFileContextMenuLoaded = true
    if (pendingFileContextMenuPayload && fileContextMenuWindow && !fileContextMenuWindow.isDestroyed()) {
      fileContextMenuWindow.webContents.send('menu:fileContext:render', pendingFileContextMenuPayload)
      pendingFileContextMenuPayload = null
    }
  })

  return fileContextMenuWindow
}

function hideFileContextMenuWindow(): void {
  if (fileContextMenuWindow && !fileContextMenuWindow.isDestroyed()) {
    fileContextMenuWindow.hide()
  }
}

function createWindow(): void {
  const isMac = process.platform === 'darwin'

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    frame: isMac,
    icon: join(__dirname, '../../resources/icon.png'),
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 15, y: 15 } : undefined,
    backgroundColor: '#1a1a2e',
    vibrancy: isMac ? 'sidebar' : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// --- IPC: Window Controls ---
ipcMain.on('window:minimize', () => mainWindow?.minimize())
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize()
  } else {
    mainWindow?.maximize()
  }
})
ipcMain.on('window:close', () => mainWindow?.close())
ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized() ?? false)
ipcMain.handle('window:getPlatform', () => process.platform)
ipcMain.handle('window:getSize', () => mainWindow?.getSize() ?? [1200, 800])
ipcMain.on('window:setSize', (_e, width: number, height: number) => {
  if (!mainWindow || mainWindow.isMaximized()) return
  const [, currentH] = mainWindow.getSize()
  mainWindow.setSize(Math.max(900, width), Math.max(600, height || currentH), true)
})

// renderer 通知终端清理完成的信号
let rendererCleanupDone = false
ipcMain.on('window:before-close-done', () => {
  rendererCleanupDone = true
  // 如果 close 已被拦截等待中，重新触发关闭
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close()
  }
})

// --- IPC: File Context Menu Window ---
ipcMain.handle('menu:fileContext:open', async (event, payload: {
  requestId: string
  x: number
  y: number
  items: FileContextMenuItem[]
}) => {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { success: false, error: 'No window' }
    }

    const requestId = typeof payload?.requestId === 'string' ? payload.requestId : ''
    if (!requestId) {
      return { success: false, error: 'Invalid requestId' }
    }

    const sourceItems = Array.isArray(payload?.items) ? payload.items.slice(0, MAX_FILE_MENU_ITEMS) : []
    const items = sourceItems.map((item, index) => {
      if (item?.type === 'separator') {
        return {
          id: `separator-${index}`,
          label: '',
          shortcut: '',
          type: 'separator' as const,
          enabled: false,
          danger: false
        }
      }

      const actionId = typeof item?.id === 'string' && item.id.trim() ? item.id.trim() : `item-${index}`
      const label = typeof item?.label === 'string' ? item.label.slice(0, MAX_FILE_MENU_LABEL_LENGTH) : ''
      const shortcut = typeof item?.shortcut === 'string' ? item.shortcut.slice(0, 24) : ''
      return {
        id: actionId,
        label,
        shortcut,
        type: 'normal' as const,
        enabled: item?.enabled !== false,
        danger: item?.danger === true
      }
    })

    if (items.length === 0) {
      return { success: false, error: 'No valid menu items' }
    }

    const windowRef = createFileContextMenuWindow()

    const cursorPoint = screen.getCursorScreenPoint()
    const ownerWindow = BrowserWindow.fromWebContents(event.sender)
    const contentBounds = ownerWindow?.getContentBounds()
    const clickX = Number.isFinite(payload?.x) ? Math.floor(payload.x) : 0
    const clickY = Number.isFinite(payload?.y) ? Math.floor(payload.y) : 0

    const requestedX = contentBounds ? contentBounds.x + clickX : cursorPoint.x
    const requestedY = contentBounds ? contentBounds.y + clickY : cursorPoint.y

    const height = estimateFileContextMenuHeight(items)
    const display = screen.getDisplayNearestPoint({ x: requestedX, y: requestedY })
    const workArea = display.workArea

    const boundedX = Math.min(
      Math.max(requestedX, workArea.x),
      Math.max(workArea.x, workArea.x + workArea.width - FILE_MENU_WIDTH)
    )
    const boundedY = Math.min(
      Math.max(requestedY, workArea.y),
      Math.max(workArea.y, workArea.y + workArea.height - height)
    )

    const renderPayload: FileContextMenuRenderPayload = { requestId, items }
    if (isFileContextMenuLoaded && !windowRef.webContents.isLoading()) {
      windowRef.webContents.send('menu:fileContext:render', renderPayload)
    } else {
      pendingFileContextMenuPayload = renderPayload
    }

    windowRef.setBounds({ x: boundedX, y: boundedY, width: FILE_MENU_WIDTH, height }, false)
    windowRef.showInactive()
    windowRef.focus()

    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

ipcMain.on('menu:fileContext:hide', () => {
  hideFileContextMenuWindow()
})

ipcMain.on('menu:fileContext:action', (_event, requestId: string, actionId: string) => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (!requestId || !actionId) return
  mainWindow.webContents.send('menu:fileContext:action', requestId, actionId)
  hideFileContextMenuWindow()
})

ipcMain.on('menu:fileContext:ready', () => {
  isFileContextMenuLoaded = true
  if (pendingFileContextMenuPayload && fileContextMenuWindow && !fileContextMenuWindow.isDestroyed()) {
    fileContextMenuWindow.webContents.send('menu:fileContext:render', pendingFileContextMenuPayload)
    pendingFileContextMenuPayload = null
  }
})

// --- IPC: Store ---
ipcMain.handle('store:getConnections', () => store.getConnections())
ipcMain.handle('store:saveConnection', (_e, conn) => store.saveConnection(conn))
ipcMain.handle('store:deleteConnection', (_e, id) => store.deleteConnection(id))
ipcMain.handle('store:getSettings', () => store.getSettings())
ipcMain.handle('store:saveSettings', (_e, settings) => store.saveSettings(settings))
ipcMain.handle('store:getSkills', () => store.getSkills())
ipcMain.handle('store:saveSkill', (_e, skill) => store.saveSkill(skill))
ipcMain.handle('store:deleteSkill', (_e, id) => store.deleteSkill(id))
ipcMain.handle('store:importSkills', (_e, skills) => store.importSkills(skills))

// --- IPC: Config File ---
ipcMain.handle('config:getPath', () => {
  return getConfigPath()
})
ipcMain.handle('config:openFile', async () => {
  const configPath = getConfigPath()
  await shell.openPath(configPath)
  return { success: true, path: configPath }
})
ipcMain.handle('chatHistory:getAll', () => store.getChatHistory())
ipcMain.handle('chatHistory:save', (_e, entry) => store.saveChatSession(entry))
ipcMain.handle('chatHistory:delete', (_e, sessionKey) => store.deleteChatSession(sessionKey))
ipcMain.handle('chatHistory:clearAll', () => store.clearAllChatHistory())

// --- IPC: SSH ---
ipcMain.handle('ssh:connect', async (_e, connConfig) => {
  try {
    const sessionId = await sshManager.connect(connConfig)
    return { success: true, sessionId }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('ssh:disconnect', (_e, sessionId: string) => {
  sshManager.disconnect(sessionId)
  return { success: true }
})

ipcMain.on('ssh:data', (_e, sessionId: string, data: string) => {
  sshManager.write(sessionId, data)
})

ipcMain.on('ssh:resize', (_e, sessionId: string, cols: number, rows: number) => {
  sshManager.resize(sessionId, cols, rows)
})

// Forward SSH data to renderer
sshManager.on('data', (sessionId: string, data: string) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ssh:data', sessionId, data)
  }
})

sshManager.on('close', (sessionId: string) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ssh:close', sessionId)
  }
})

sshManager.on('error', (sessionId: string, error: string) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ssh:error', sessionId, error)
  }
})

sshManager.on('reconnecting', (sessionId: string, info: { attempt: number; maxAttempts: number; nextRetryIn: number }) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ssh:reconnecting', sessionId, info)
  }
})

sshManager.on('reconnected', (sessionId: string) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ssh:reconnected', sessionId)
  }
})

sshManager.on('reconnectFailed', (sessionId: string, reason: string) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ssh:reconnectFailed', sessionId, reason)
  }
})

// --- IPC: AI ---
ipcMain.handle('ai:testConnection', async (_e, settings: any) => {
  try {
    const success = await aiService.testConnection(settings)
    return { success }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})
ipcMain.handle('ai:chat', async (_e, messages: any[], settings: any, options?: any) => {
  try {
    const reply = await aiService.chat(messages, settings, options)
    return { success: true, reply }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

// AI Streaming
ipcMain.handle('ai:chatStream', async (_e, messages: any[], settings: any, streamId: string, options?: any) => {
  if (!mainWindow) return { success: false, error: 'No window' }
  try {
    await aiService.chatStream(messages, settings, mainWindow, streamId, options)
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

// Agent Management
ipcMain.handle('ai:getAgents', () => {
  return aiService.getAgentManager().getVisibleAgents()
})

ipcMain.handle('ai:getAgentConfig', (_e, agentId: string) => {
  return aiService.getAgentManager().getAgent(agentId)
})

// Token Info
ipcMain.handle('ai:getTokenInfo', (_e, messages: any[], modelName: string) => {
  return aiService.getTokenInfo(messages, modelName)
})

// Manual Compaction
ipcMain.handle('ai:compact', async (_e, messages: any[], settings: any) => {
  try {
    const result = await aiService.manualCompact(messages, settings)
    return { success: true, ...result }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

// --- IPC: SSH Exec / Local Exec ---
ipcMain.handle('ssh:exec', async (_e, sessionId: string, command: string) => {
  try {
    if (sessionId.startsWith('local-')) {
      const options: any = { encoding: 'utf-8', windowsHide: true }
      if (process.platform === 'win32') {
        options.shell = 'powershell.exe'
      }
      const { stdout, stderr } = await execAsync(command, options)
      return { success: true, output: stdout || stderr }
    }
    const output = await sshManager.exec(sessionId, command)
    return { success: true, output }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

// --- IPC: AI File Attachment Reader ---
ipcMain.handle('file:readForAi', async (_e, sessionId: string, path: string, type: 'file' | 'dir') => {
  try {
    if (sessionId.startsWith('local-')) {
      if (type === 'dir') {
        const files = await fsPromises.readdir(path)
        return { success: true, output: files.slice(0, 300).join('\n') }
      } else {
        const fd = await fsPromises.open(path, 'r')
        const buffer = Buffer.alloc(50000)
        const { bytesRead } = await fd.read(buffer, 0, 50000, 0)
        await fd.close()
        return { success: true, output: buffer.slice(0, bytesRead).toString('utf-8') }
      }
    } else {
      const script = type === 'dir' 
        ? `ls -lah "${path}" | head -n 300`
        : `head -c 50000 "${path}"`
      const output = await sshManager.exec(sessionId, script)
      return { success: true, output }
    }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

// --- IPC: Encryption ---
ipcMain.handle('encrypt', (_e, text: string) => {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(text).toString('base64')
  }
  return text
})

ipcMain.handle('decrypt', (_e, encrypted: string) => {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  }
  return encrypted
})

// --- IPC: File Dialog ---
ipcMain.handle('dialog:openFile', async (_e, options: any) => {
  if (!mainWindow) return { canceled: true, filePaths: [] }
  const result = await dialog.showOpenDialog(mainWindow, options)
  return result
})

ipcMain.handle('dialog:selectDirectory', async () => {
  if (!mainWindow) return { canceled: true, filePaths: [] }
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory']
  })
  return result
})

// --- IPC: SFTP ---
ipcMain.handle('sftp:ls', async (_e, sessionId: string, path: string) => {
  try {
    if (sessionId.startsWith('local-')) {
      const data = await localFileManager.ls(path)
      return { success: true, data }
    }
    const data = await sshManager.sftpLs(sessionId, path)
    return { success: true, data }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('sftp:download', async (_e, sessionId: string, remotePath: string, localPath: string) => {
  const uniquePath = await getUniqueLocalPath(localPath, 'file')
  const taskId = randomUUID()
  const fileName = extractFileName(remotePath)
  sendFileProgressThrottled({ taskId, type: 'download', fileName, status: 'started', progress: 0 })
  try {
    // Ensure parent directory exists before downloading
    await fsPromises.mkdir(dirname(uniquePath), { recursive: true })

    const onProgress = (transferred: number, total: number) => {
      const pct = total > 0 ? Math.round((transferred / total) * 100) : -1
      sendFileProgressThrottled({ taskId, type: 'download', fileName, status: 'progress', progress: pct, transferredBytes: transferred, totalBytes: total })
    }
    if (sessionId.startsWith('local-')) {
      await localFileManager.download(remotePath, uniquePath, onProgress)
    } else {
      await sshManager.sftpDownload(sessionId, remotePath, uniquePath, onProgress)
    }
    sendFileProgressThrottled({ taskId, type: 'download', fileName, status: 'completed', progress: 100 })
    return { success: true }
  } catch (err: any) {
    sendFileProgressThrottled({ taskId, type: 'download', fileName, status: 'error', progress: 0, error: err.message })
    return { success: false, error: err.message }
  }
})

ipcMain.handle('sftp:upload', async (_e, sessionId: string, localPath: string, remotePath: string) => {
  const taskId = randomUUID()
  const fileName = extractFileName(localPath)
  sendFileProgressThrottled({ taskId, type: 'upload', fileName, status: 'started', progress: 0 })
  try {
    const onProgress = (transferred: number, total: number) => {
      const pct = total > 0 ? Math.round((transferred / total) * 100) : -1
      sendFileProgressThrottled({ taskId, type: 'upload', fileName, status: 'progress', progress: pct, transferredBytes: transferred, totalBytes: total })
    }
    if (sessionId.startsWith('local-')) {
      await localFileManager.upload(localPath, remotePath, onProgress)
    } else {
      await sshManager.sftpUpload(sessionId, localPath, remotePath, onProgress)
    }
    sendFileProgressThrottled({ taskId, type: 'upload', fileName, status: 'completed', progress: 100 })
    return { success: true }
  } catch (err: any) {
    sendFileProgressThrottled({ taskId, type: 'upload', fileName, status: 'error', progress: 0, error: err.message })
    return { success: false, error: err.message }
  }
})

ipcMain.handle('sftp:uploadDir', async (_e, sessionId: string, localPath: string, remotePath: string) => {
  const isLocal = sessionId.startsWith('local-')
  const UPLOAD_CONCURRENCY = 8
  const taskId = randomUUID()
  const dirName = extractFileName(localPath)

  // Count total files first
  const countFiles = async (dir: string): Promise<number> => {
    const entries = await fsPromises.readdir(dir, { withFileTypes: true })
    let count = 0
    for (const entry of entries) {
      if (entry.isDirectory()) count += await countFiles(join(dir, entry.name))
      else if (entry.isFile()) count++
    }
    return count
  }

  try {
    const totalFiles = await countFiles(localPath)
    let uploadedFiles = 0

    sendFileProgressThrottled({ taskId, type: 'uploadDir', fileName: dirName, status: 'started', progress: 0, totalBytes: totalFiles, transferredBytes: 0 })

    const uploadDirRecursive = async (localDir: string, remoteDir: string) => {
      if (isLocal) {
        await fsPromises.mkdir(remoteDir, { recursive: true })
      } else {
        await sshManager.exec(sessionId, `mkdir -p "${shellEscape(remoteDir)}"`)
      }

      const entries = await fsPromises.readdir(localDir, { withFileTypes: true })
      const dirs: typeof entries = []
      const files: typeof entries = []
      for (const entry of entries) {
        if (entry.isDirectory()) dirs.push(entry)
        else if (entry.isFile()) files.push(entry)
      }

      for (const dir of dirs) {
        const localEntryPath = join(localDir, dir.name)
        const remoteEntryPath = isLocal ? join(remoteDir, dir.name) : `${remoteDir}/${dir.name}`
        await uploadDirRecursive(localEntryPath, remoteEntryPath)
      }

      const errors: string[] = []
      for (let i = 0; i < files.length; i += UPLOAD_CONCURRENCY) {
        const batch = files.slice(i, i + UPLOAD_CONCURRENCY)
        const results = await Promise.allSettled(batch.map(async (file) => {
          const localEntryPath = join(localDir, file.name)
          const remoteEntryPath = isLocal ? join(remoteDir, file.name) : `${remoteDir}/${file.name}`
          if (isLocal) {
            await localFileManager.upload(localEntryPath, remoteEntryPath)
          } else {
            await sshManager.sftpUpload(sessionId, localEntryPath, remoteEntryPath)
          }
        }))
        for (let j = 0; j < results.length; j++) {
          const r = results[j]
          if (r.status === 'rejected') {
            errors.push(`${batch[j].name}: ${r.reason?.message || r.reason}`)
          } else {
            uploadedFiles++
            const pct = totalFiles > 0 ? Math.round((uploadedFiles / totalFiles) * 100) : -1
            sendFileProgressThrottled({ taskId, type: 'uploadDir', fileName: dirName, status: 'progress', progress: pct, totalBytes: totalFiles, transferredBytes: uploadedFiles })
          }
        }
      }
      if (errors.length > 0) {
        throw new Error(`部分文件上传失败:\n${errors.join('\n')}`)
      }
    }

    await uploadDirRecursive(localPath, remotePath)
    sendFileProgressThrottled({ taskId, type: 'uploadDir', fileName: dirName, status: 'completed', progress: 100 })
    return { success: true }
  } catch (err: any) {
    sendFileProgressThrottled({ taskId, type: 'uploadDir', fileName: dirName, status: 'error', progress: 0, error: err.message })
    return { success: false, error: err.message }
  }
})

ipcMain.handle('sftp:isLocalDirectory', async (_e, localPath: string) => {
  try {
    const stat = await fsPromises.stat(localPath)
    return { success: true, isDirectory: stat.isDirectory() }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('sftp:downloadDir', async (_e, sessionId: string, remotePath: string, localPath: string) => {
  const isLocal = sessionId.startsWith('local-')
  const DOWNLOAD_CONCURRENCY = 8
  const taskId = randomUUID()
  const uniquePath = await getUniqueLocalPath(localPath, 'directory')
  const dirName = extractFileName(remotePath)

  try {
    sendFileProgressThrottled({ taskId, type: 'downloadDir', fileName: dirName, status: 'started', progress: 0 })

    // Count total files first
    const countRemoteFiles = async (dir: string): Promise<number> => {
      const list = await sshManager.sftpLs(sessionId, dir)
      let count = 0
      for (const item of list) {
        if (item.name === '.' || item.name === '..') continue
        const fullPath = `${dir === '/' ? '' : dir}/${item.name}`
        if (item.type === 'd') {
          count += await countRemoteFiles(fullPath)
        } else if (item.type === '-' || item.type === 'l') {
          count++
        }
      }
      return count
    }

    let totalFiles: number
    let downloadedFiles = 0

    if (isLocal) {
      // Local session: use fs.cp for recursive copy
      totalFiles = await countRemoteFiles(remotePath)
      await fsPromises.mkdir(uniquePath, { recursive: true })
      sendFileProgressThrottled({ taskId, type: 'downloadDir', fileName: dirName, status: 'progress', progress: 0, totalBytes: totalFiles, transferredBytes: 0 })

      // Use recursive cp for local-to-local (much faster)
      await fsCp(remotePath, uniquePath, { recursive: true })
      downloadedFiles = totalFiles
    } else {
      // SSH session: recursive SFTP download
      totalFiles = await countRemoteFiles(remotePath)
      sendFileProgressThrottled({ taskId, type: 'downloadDir', fileName: dirName, status: 'progress', progress: 0, totalBytes: totalFiles, transferredBytes: 0 })

      const downloadDirRecursive = async (remoteDir: string, localDir: string) => {
        await fsPromises.mkdir(localDir, { recursive: true })

        const list = await sshManager.sftpLs(sessionId, remoteDir)
        const dirs: typeof list = []
        const files: typeof list = []
        for (const item of list) {
          if (item.name === '.' || item.name === '..') continue
          if (item.type === 'd') dirs.push(item)
          else if (item.type === '-' || item.type === 'l') files.push(item)
        }

        // Recurse into subdirectories first, collect errors
        const allErrors: string[] = []
        for (const dir of dirs) {
          const remoteEntryPath = `${remoteDir === '/' ? '' : remoteDir}/${dir.name}`
          const localEntryPath = join(localDir, dir.name)
          const subErrors = await downloadDirRecursive(remoteEntryPath, localEntryPath)
          allErrors.push(...subErrors)
        }

        // Download files in parallel batches
        const batchErrors: string[] = []
        for (let i = 0; i < files.length; i += DOWNLOAD_CONCURRENCY) {
          const batch = files.slice(i, i + DOWNLOAD_CONCURRENCY)
          const results = await Promise.allSettled(batch.map(async (file) => {
            const remoteEntryPath = `${remoteDir === '/' ? '' : remoteDir}/${file.name}`
            const localEntryPath = join(localDir, file.name)
            await sshManager.sftpDownload(sessionId, remoteEntryPath, localEntryPath)
          }))
          for (let j = 0; j < results.length; j++) {
            const r = results[j]
            if (r.status === 'rejected') {
              batchErrors.push(`${batch[j].name}: ${r.reason?.message || r.reason}`)
            } else {
              downloadedFiles++
              const pct = totalFiles > 0 ? Math.round((downloadedFiles / totalFiles) * 100) : -1
              sendFileProgressThrottled({ taskId, type: 'downloadDir', fileName: dirName, status: 'progress', progress: pct, totalBytes: totalFiles, transferredBytes: downloadedFiles })
            }
          }
        }
        return [...allErrors, ...batchErrors]
      }

      const allErrors = await downloadDirRecursive(remotePath, uniquePath)
      if (allErrors.length > 0) {
        throw new Error(`部分文件下载失败:\n${allErrors.join('\n')}`)
      }
    }

    sendFileProgressThrottled({ taskId, type: 'downloadDir', fileName: dirName, status: 'completed', progress: 100 })
    return { success: true }
  } catch (err: any) {
    sendFileProgressThrottled({ taskId, type: 'downloadDir', fileName: dirName, status: 'error', progress: 0, error: err.message })
    return { success: false, error: err.message }
  }
})

ipcMain.handle('sftp:move', async (_e, sessionId: string, srcPath: string, destPath: string) => {
  const taskId = randomUUID()
  const fileName = extractFileName(srcPath)
  sendFileProgressThrottled({ taskId, type: 'move', fileName, status: 'started', progress: -1 })
  try {
    if (sessionId.startsWith('local-')) {
      await localFileManager.move(srcPath, destPath)
    } else {
      await sshManager.sftpMove(sessionId, srcPath, destPath)
    }
    sendFileProgressThrottled({ taskId, type: 'move', fileName, status: 'completed', progress: 100 })
    return { success: true }
  } catch (err: any) {
    sendFileProgressThrottled({ taskId, type: 'move', fileName, status: 'error', progress: 0, error: err.message })
    return { success: false, error: err.message }
  }
})

ipcMain.handle('sftp:copy', async (_e, sessionId: string, srcPath: string, destPath: string) => {
  const taskId = randomUUID()
  const fileName = extractFileName(srcPath)
  sendFileProgressThrottled({ taskId, type: 'copy', fileName, status: 'started', progress: -1 })
  try {
    if (sessionId.startsWith('local-')) {
      await localFileManager.copy(srcPath, destPath)
    } else {
      await sshManager.sftpCopy(sessionId, srcPath, destPath)
    }
    sendFileProgressThrottled({ taskId, type: 'copy', fileName, status: 'completed', progress: 100 })
    return { success: true }
  } catch (err: any) {
    sendFileProgressThrottled({ taskId, type: 'copy', fileName, status: 'error', progress: 0, error: err.message })
    return { success: false, error: err.message }
  }
})

// --- IPC: Read file as data URL ---
ipcMain.handle('file:readAsDataUrl', async (_e, filePath: string) => {
  try {
    const data = readFileSync(filePath)
    const ext = filePath.split('.').pop()?.toLowerCase() || 'png'
    const mimeMap: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml'
    }
    const mime = mimeMap[ext] || 'image/png'
    return `data:${mime};base64,${data.toString('base64')}`
  } catch {
    return null
  }
})

// --- IPC: Local PTY ---
ipcMain.handle('pty:spawn', (_e, id: string, cwd?: string) => {
  try {
    localPtyManager.spawn(id, cwd)
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

ipcMain.on('pty:write', (_e, id: string, data: string) => {
  localPtyManager.write(id, data)
})

ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => {
  localPtyManager.resize(id, cols, rows)
})

ipcMain.handle('pty:kill', (_e, id: string) => {
  localPtyManager.kill(id)
  return { success: true }
})

// Forward local PTY data/exit to renderer
localPtyManager.on('data', (id: string, data: string) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pty:data', id, data)
  }
})

localPtyManager.on('exit', (id: string, exitCode: number) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pty:exit', id, exitCode)
  }
})

// --- IPC: Clipboard ---
ipcMain.handle('clipboard:readText', () => clipboard.readText())
ipcMain.handle('clipboard:writeText', (_e, text: string) => clipboard.writeText(text))

// --- IPC: SFTP Delete ---
ipcMain.handle('sftp:delete', async (_e, sessionId: string, targetPath: string) => {
  const taskId = randomUUID()
  const fileName = extractFileName(targetPath)
  sendFileProgressThrottled({ taskId, type: 'delete', fileName, status: 'started', progress: -1 })
  try {
    if (sessionId.startsWith('local-')) {
      const stat = await fsPromises.stat(targetPath)
      if (stat.isDirectory()) {
        await fsPromises.rm(targetPath, { recursive: true })
      } else {
        await fsPromises.unlink(targetPath)
      }
    } else {
      await sshManager.exec(sessionId, `rm -rf "${shellEscape(targetPath)}"`)
    }
    sendFileProgressThrottled({ taskId, type: 'delete', fileName, status: 'completed', progress: 100 })
    return { success: true }
  } catch (err: any) {
    sendFileProgressThrottled({ taskId, type: 'delete', fileName, status: 'error', progress: 0, error: err.message })
    return { success: false, error: err.message }
  }
})

// --- IPC: SFTP Rename ---
ipcMain.handle('sftp:rename', async (_e, sessionId: string, oldPath: string, newPath: string) => {
  try {
    if (sessionId.startsWith('local-')) {
      await fsPromises.rename(oldPath, newPath)
      return { success: true }
    }
    await sshManager.exec(sessionId, `mv "${shellEscape(oldPath)}" "${shellEscape(newPath)}"`)
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

// Validate that a filename (last segment) is safe — no path traversal or illegal chars
// 注意：此函数只验证最后一段名称，允许传入完整路径
function validateFileName(filePath: string): void {
  // 提取最后一段（文件名或目录名）
  const parts = filePath.replace(/\\/g, '/').split('/')
  const name = parts[parts.length - 1] || ''
  // 检查名称是否合法
  if (!name || name === '.' || name === '..' || name.includes('\0')) {
    throw new Error(`非法文件名: "${name}"`)
  }
  // name 已经是 split 后的最后一段，不会包含 /
}

// --- IPC: SFTP Create File ---
ipcMain.handle('sftp:createFile', async (_e, sessionId: string, filePath: string) => {
  try {
    validateFileName(filePath)
    if (sessionId.startsWith('local-')) {
      await fsPromises.writeFile(filePath, '', { flag: 'wx' })
      return { success: true }
    }
    // 远程先检查是否存在，不存在时才创建（与本地 'wx' 行为一致）
    try {
      const checkResult = await sshManager.exec(sessionId, `test -e "${shellEscape(filePath)}" && echo EXISTS || echo NOT_EXISTS`)
      if (checkResult.trim() === 'EXISTS') {
        return { success: false, error: '文件已存在' }
      }
    } catch {
      // test 命令失败视为不存在，继续创建
    }
    await sshManager.exec(sessionId, `touch "${shellEscape(filePath)}"`)
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

// --- IPC: SFTP Mkdir ---
ipcMain.handle('sftp:mkdir', async (_e, sessionId: string, dirPath: string) => {
  try {
    validateFileName(dirPath)
    if (sessionId.startsWith('local-')) {
      await fsPromises.mkdir(dirPath)
      return { success: true }
    }
    await sshManager.exec(sessionId, `mkdir "${shellEscape(dirPath)}"`)
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

type RemoteReadFileMetadata = {
  status: 'ok' | 'too_large' | 'binary'
  size: number
}

// --- IPC: SFTP Read File (for editor) ---
ipcMain.handle('sftp:readFile', async (_e, sessionId: string, filePath: string) => {
  try {
    if (sessionId.startsWith('local-')) {
      const result = await localFileManager.readFile(filePath)
      return { success: true, ...result }
    }

    const escaped = shellEscape(filePath)
    const combined = await sshManager.exec(
      sessionId,
      // 兼容 GNU (Linux) 和 BSD (macOS) 的 stat 命令
      `SIZE=$(stat -c%s "${escaped}" 2>/dev/null || stat -f%z "${escaped}" 2>/dev/null || wc -c < "${escaped}"); ` +
      `if [ "$SIZE" -gt ${MAX_EDIT_FILE_SIZE} ]; then printf '%s\n' '{"status":"too_large","size":'"$SIZE"'}'; exit 0; fi; ` +
      `if [ "$SIZE" -gt 0 ]; then ` +
        `FTYPE=$(file -b --mime-encoding "${escaped}" 2>/dev/null || echo "unknown"); ` +
        `if [ "$FTYPE" = "binary" ]; then printf '%s\n' '{"status":"binary","size":'"$SIZE"'}'; exit 0; fi; ` +
      `fi; ` +
      `printf '%s\n' '{"status":"ok","size":'"$SIZE"'}'; ` +
      `base64 < "${escaped}" | tr -d '\n'`
    )

    const headerEnd = combined.indexOf('\n')
    const metadataLine = headerEnd >= 0 ? combined.slice(0, headerEnd) : combined
    const encodedContent = headerEnd >= 0 ? combined.slice(headerEnd + 1) : ''

    if (!metadataLine) {
      throw new Error('远程读取返回为空')
    }

    const metadata = JSON.parse(metadataLine) as RemoteReadFileMetadata
    if (metadata.status === 'too_large') {
      return { success: false, error: `文件过大 (${(metadata.size / 1024 / 1024).toFixed(1)}MB)，编辑上限为 5MB` }
    }
    if (metadata.status === 'binary') {
      return { success: false, error: '这是一个二进制文件，不支持编辑' }
    }

    const content = encodedContent ? Buffer.from(encodedContent, 'base64').toString('utf-8') : ''
    return { success: true, content, size: metadata.size }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

// --- IPC: SFTP Write File (for editor) ---
ipcMain.handle('sftp:writeFile', async (_e, sessionId: string, filePath: string, content: string) => {
  try {
    if (sessionId.startsWith('local-')) {
      await localFileManager.writeFile(filePath, content)
      return { success: true }
    }
    // 远程: 分块 base64 传输，避免命令行长度限制
    const escapedPath = shellEscape(filePath)
    if (content.length === 0) {
      // 空文件直接截断
      await sshManager.exec(sessionId, `truncate -s 0 "${escapedPath}" 2>/dev/null || printf '' > "${escapedPath}"`)
      return { success: true }
    }
    const b64 = Buffer.from(content, 'utf-8').toString('base64')
    const CHUNK_SIZE = 65536 // 64KB per chunk (safe for most shells)
    // 使用唯一的临时文件名，避免多会话冲突
    // 过滤 sessionId 中的危险字符，只保留字母数字和连字符
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9-]/g, '_')
    const tmpFile = `/tmp/.openterm_edit_${safeSessionId}_${Date.now()}`
    // 第一块用 > 覆盖，后续块用 >> 追加
    for (let i = 0; i < b64.length; i += CHUNK_SIZE) {
      const chunk = b64.substring(i, i + CHUNK_SIZE)
      const op = i === 0 ? '>' : '>>'
      await sshManager.exec(sessionId, `printf '%s' '${chunk}' ${op} "${tmpFile}"`)
    }
    await sshManager.exec(sessionId, `base64 -d "${tmpFile}" > "${escapedPath}" && rm -f "${tmpFile}"`)
    return { success: true }
  } catch (err: any) {
    // 清理临时文件（使用与写入时相同的命名规则）
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9-]/g, '_')
    try { await sshManager.exec(sessionId, `rm -f /tmp/.openterm_edit_${safeSessionId}_*`) } catch {}
    return { success: false, error: err.message }
  }
})

const sessionDataPath = join(app.getPath('userData'), 'sessionData')
app.setPath('sessionData', sessionDataPath)

app.whenReady().then(() => {
  createWindow()

  // 窗口关闭流程：先通知 renderer 清理终端，等待确认后再 kill PTY/SSH 并真正关闭
  mainWindow?.on('close', (e) => {
    hideFileContextMenuWindow()
    // 如果 renderer 已完成清理，直接执行关闭
    if (rendererCleanupDone) {
      localPtyManager.killAll()
      sshManager.disconnectAll()
      return
    }
    // 首次 close：拦截事件，通知 renderer 清理
    e.preventDefault()
    rendererCleanupDone = false
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:before-close')
    }
    // renderer 清理完成后会发送 'window:before-close-done'，触发二次 close
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  hideFileContextMenuWindow()
  sshManager.disconnectAll()
  localPtyManager.killAll()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
