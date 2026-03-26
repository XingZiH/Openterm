import { app, BrowserWindow, ipcMain, shell, safeStorage, dialog, clipboard } from 'electron'
import { join } from 'path'
import { readFileSync, promises as fsPromises } from 'fs'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)
import { SSHManager, shellEscape } from './ssh-manager'
import { Store } from './store'
import { AiService } from './ai-service'
import { LocalPtyManager } from './local-pty'
import { getConfigPath } from './config-file'
import { MAX_EDIT_FILE_SIZE, localFileManager } from './local-file-manager'

const isDev = process.env.NODE_ENV === 'development'

let mainWindow: BrowserWindow | null = null
const sshManager = new SSHManager()
const store = new Store()
const aiService = new AiService()
const localPtyManager = new LocalPtyManager()

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
  mainWindow?.webContents.send('ssh:data', sessionId, data)
})

sshManager.on('close', (sessionId: string) => {
  mainWindow?.webContents.send('ssh:close', sessionId)
})

sshManager.on('error', (sessionId: string, error: string) => {
  mainWindow?.webContents.send('ssh:error', sessionId, error)
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
  try {
    if (sessionId.startsWith('local-')) {
      await localFileManager.download(remotePath, localPath)
      return { success: true }
    }
    await sshManager.sftpDownload(sessionId, remotePath, localPath)
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('sftp:upload', async (_e, sessionId: string, localPath: string, remotePath: string) => {
  try {
    if (sessionId.startsWith('local-')) {
      await localFileManager.upload(localPath, remotePath)
      return { success: true }
    }
    await sshManager.sftpUpload(sessionId, localPath, remotePath)
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('sftp:move', async (_e, sessionId: string, srcPath: string, destPath: string) => {
  try {
    if (sessionId.startsWith('local-')) {
      await localFileManager.move(srcPath, destPath)
      return { success: true }
    }
    await sshManager.sftpMove(sessionId, srcPath, destPath)
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('sftp:copy', async (_e, sessionId: string, srcPath: string, destPath: string) => {
  try {
    if (sessionId.startsWith('local-')) {
      await localFileManager.copy(srcPath, destPath)
      return { success: true }
    }
    await sshManager.sftpCopy(sessionId, srcPath, destPath)
    return { success: true }
  } catch (err: any) {
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
  try {
    if (sessionId.startsWith('local-')) {
      const stat = await fsPromises.stat(targetPath)
      if (stat.isDirectory()) {
        await fsPromises.rm(targetPath, { recursive: true })
      } else {
        await fsPromises.unlink(targetPath)
      }
      return { success: true }
    }
    await sshManager.exec(sessionId, `rm -rf "${shellEscape(targetPath)}"`)
    return { success: true }
  } catch (err: any) {
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

app.whenReady().then(() => {
  createWindow()

  // Kill PTYs before window closes to prevent 'Object has been destroyed' errors
  mainWindow?.on('close', () => {
    localPtyManager.killAll()
    sshManager.disconnectAll()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  sshManager.disconnectAll()
  localPtyManager.killAll()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
