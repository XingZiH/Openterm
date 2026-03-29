import { app, BrowserWindow, ipcMain, shell, safeStorage, dialog, clipboard, Menu } from 'electron'
import { autoUpdater } from 'electron-updater'
import { join } from 'path'
import { readFileSync, promises as fsPromises } from 'fs'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)
import { SSHManager } from './ssh-manager'
import { Store } from './store'
import { AiService } from './ai-service'
import { LocalPtyManager } from './local-pty'
import { getConfigPath } from './config-file'
import { localFileManager } from './local-file-manager'

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

// --- IPC: Clipboard ---
ipcMain.handle('clipboard:read', () => clipboard.readText())
ipcMain.handle('clipboard:write', (_e, text: string) => { clipboard.writeText(text) })

// --- IPC: App Update (electron-updater) ---
ipcMain.handle('app:getVersion', () => app.getVersion())

// Configure autoUpdater
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = true

autoUpdater.on('checking-for-update', () => {
  mainWindow?.webContents.send('app:update-status', { status: 'checking' })
})
autoUpdater.on('update-available', (info) => {
  mainWindow?.webContents.send('app:update-status', { status: 'available', version: info.version, releaseNotes: info.releaseNotes })
})
autoUpdater.on('update-not-available', (info) => {
  mainWindow?.webContents.send('app:update-status', { status: 'not-available', version: info.version })
})
autoUpdater.on('download-progress', (progress) => {
  mainWindow?.webContents.send('app:update-status', { status: 'downloading', percent: Math.round(progress.percent), bytesPerSecond: progress.bytesPerSecond })
})
autoUpdater.on('update-downloaded', (info) => {
  mainWindow?.webContents.send('app:update-status', { status: 'downloaded', version: info.version })
})
autoUpdater.on('error', (err) => {
  mainWindow?.webContents.send('app:update-status', { status: 'error', error: err.message })
})

ipcMain.handle('app:checkUpdate', async () => {
  try {
    // Check via GitHub API
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000)
    const response = await fetch('https://api.github.com/repos/XingZiH/Openterm/releases/latest', { signal: controller.signal })
    clearTimeout(timeoutId)
    if (!response.ok) throw new Error(`网络错误: ${response.status}`)
    const data = await response.json() as { tag_name: string; html_url: string; name: string }
    const latestVersion = data.tag_name.replace(/^v/, '')
    const currentVersion = app.getVersion()
    // Skip update check in dev mode (version is '0.0.0' or 'dev')
    const isDevMode = !app.isPackaged
    if (isDevMode) {
      mainWindow?.webContents.send('app:update-status', { status: 'not-available', version: currentVersion })
      return { success: true }
    }
    // Compare versions properly (semver-lite)
    const parseVer = (v: string) => v.split('.').map(n => parseInt(n) || 0)
    const [la, lb, lc] = parseVer(latestVersion)
    const [ca, cb, cc] = parseVer(currentVersion)
    const hasUpdate = la > ca || (la === ca && lb > cb) || (la === ca && lb === cb && lc > cc)
    if (!hasUpdate) {
      mainWindow?.webContents.send('app:update-status', { status: 'not-available', version: currentVersion })
      return { success: true }
    }
    // Has update: notify renderer and start auto download
    mainWindow?.webContents.send('app:update-status', { status: 'available', version: latestVersion, currentVersion })
    // autoUpdater handles download-progress and update-downloaded events automatically
    autoUpdater.downloadUpdate().catch(() => {
      // silently ignore download errors in packaged env
    })
    return { success: true }
  } catch (e: any) {
    const msg = e.name === 'AbortError' ? '网络超时，请检查网络连接' : '网络出错，请检查网络连接'
    mainWindow?.webContents.send('app:update-status', { status: 'error', error: msg })
    return { success: false, error: msg }
  }
})

ipcMain.handle('app:downloadUpdate', async () => {
  try {
    await autoUpdater.downloadUpdate()
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('app:installUpdate', () => {
  autoUpdater.quitAndInstall()
})

ipcMain.handle('app:openReleasePage', () => {
  shell.openExternal('https://github.com/XingZiH/Openterm/releases/latest')
})

// --- IPC: Config Export/Import ---
ipcMain.handle('config:export', async () => {
  const result = await dialog.showSaveDialog(mainWindow!, {
    title: '导出配置',
    defaultPath: `openterm-config-${new Date().toISOString().slice(0,10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (result.canceled || !result.filePath) return { success: false, canceled: true }
  const data = await store.exportAll()
  await fsPromises.writeFile(result.filePath, JSON.stringify(data, null, 2), 'utf-8')
  return { success: true, path: result.filePath }
})
ipcMain.handle('config:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: '导入配置',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  })
  if (result.canceled || !result.filePaths.length) return { success: false, canceled: true }
  const raw = await fsPromises.readFile(result.filePaths[0], 'utf-8')
  const data = JSON.parse(raw)
  await store.importAll(data)
  return { success: true }
})

// --- IPC: Credential Profiles ---
ipcMain.handle('credentials:getAll', () => store.getCredentialProfiles())
ipcMain.handle('credentials:save', (_e, profile) => store.saveCredentialProfile(profile))
ipcMain.handle('credentials:delete', (_e, id: string) => store.deleteCredentialProfile(id))

// --- IPC: AI Fetch Models ---
ipcMain.handle('ai:fetchModels', async (_e, settings: any) => {
  try {
    const provider = settings.provider
    const presets: Record<string, string[]> = {
      anthropic: ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-3-5'],
      deepseek: ['deepseek-chat', 'deepseek-reasoner'],
      kimi: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
      qwen: ['qwen-plus', 'qwen-turbo', 'qwen-max'],
      gemini: ['gemini-2.0-flash', 'gemini-2.5-pro', 'gemini-1.5-pro'],
      xai: ['grok-3', 'grok-3-fast', 'grok-2'],
      'custom-anthropic': ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-3-5']
    }
    if (presets[provider]) return { success: true, models: presets[provider] }
    if (provider === 'ollama') {
      const url = `${settings.ollamaUrl || 'http://localhost:11434'}/api/tags`
      const res = await fetch(url)
      const data = await res.json() as { models: { name: string }[] }
      return { success: true, models: data.models.map((m: any) => m.name) }
    }
    // openai / custom / groq / others
    let baseUrl = settings.apiUrl || 'https://api.openai.com/v1/chat/completions'
    // Normalize: strip trailing /chat/completions or /completions to get base v1 URL
    baseUrl = baseUrl
      .replace(/\/chat\/completions$/, '')
      .replace(/\/completions$/, '')
      .replace(/\/$/, '')
    // Blink uses /ai/models instead of /models
    const isBlinkGateway = baseUrl.includes('blink.new')
    const modelsPath = isBlinkGateway ? `${baseUrl}/ai/models` : `${baseUrl}/models`
    const res = await fetch(modelsPath, {
      headers: { 'Authorization': `Bearer ${settings.apiKey || ''}` }
    })
    if (!res.ok) {
      const errText = await res.text()
      return { success: false, error: `HTTP ${res.status}: ${errText.slice(0, 200)}` }
    }
    const data = await res.json() as { data: { id: string }[] }
    const models = (data.data || []).map((m: any) => m.id).filter(Boolean).sort()
    return { success: true, models }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

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
