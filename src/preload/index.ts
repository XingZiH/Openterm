import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { SFTPFile } from '../shared/sftp-file'

export interface ElectronAPI {
  ssh: {
    connect: (config: any) => Promise<{ success: boolean; sessionId?: string; error?: string }>
    disconnect: (sessionId: string) => Promise<{ success: boolean }>
    sendData: (sessionId: string, data: string) => void
    resize: (sessionId: string, cols: number, rows: number) => void
    exec: (sessionId: string, command: string) => Promise<{ success: boolean; output?: string; error?: string }>
    onData: (callback: (sessionId: string, data: string) => void) => () => void
    onClose: (callback: (sessionId: string) => void) => () => void
    onError: (callback: (sessionId: string, error: string) => void) => () => void
  }
  store: {
    getConnections: () => Promise<any[]>
    saveConnection: (conn: any) => Promise<void>
    deleteConnection: (id: string) => Promise<void>
    getSettings: () => Promise<any>
    saveSettings: (settings: any) => Promise<void>
    getSkills: () => Promise<any[]>
    saveSkill: (skill: any) => Promise<void>
    deleteSkill: (id: string) => Promise<void>
    importSkills: (skills: any[]) => Promise<void>
  }
  ai: {
    testConnection: (settings: any) => Promise<{ success: boolean; error?: string }>
    chat: (messages: any[], settings: any, options?: any) => Promise<{ success: boolean; reply?: string; error?: string }>
    chatStream: (messages: any[], settings: any, streamId: string, options?: any) => Promise<{ success: boolean; error?: string }>
    onStreamDelta: (callback: (streamId: string, delta: string) => void) => () => void
    onStreamEnd: (callback: (streamId: string) => void) => () => void
    onStreamError: (callback: (streamId: string, error: string) => void) => () => void
    onCompacted: (callback: (streamId: string, info: any) => void) => () => void
    getAgents: () => Promise<any[]>
    getAgentConfig: (agentId: string) => Promise<any>
    getTokenInfo: (messages: any[], modelName: string) => Promise<any>
    compact: (messages: any[], settings: any) => Promise<any>
  }
  sftp: {
    ls: (sessionId: string, remotePath: string) => Promise<{ success: boolean; data?: SFTPFile[]; error?: string }>
    download: (sessionId: string, remotePath: string, localPath: string) => Promise<{ success: boolean; error?: string }>
    upload: (sessionId: string, localPath: string, remotePath: string) => Promise<{ success: boolean; error?: string }>
    uploadDir: (sessionId: string, localPath: string, remotePath: string) => Promise<{ success: boolean; error?: string }>
    isLocalDirectory: (localPath: string) => Promise<{ success: boolean; isDirectory?: boolean; error?: string }>
    move: (sessionId: string, srcPath: string, destPath: string) => Promise<{ success: boolean; error?: string }>
    copy: (sessionId: string, srcPath: string, destPath: string) => Promise<{ success: boolean; error?: string }>
    delete: (sessionId: string, targetPath: string) => Promise<{ success: boolean; error?: string }>
    rename: (sessionId: string, oldPath: string, newPath: string) => Promise<{ success: boolean; error?: string }>
    createFile: (sessionId: string, filePath: string) => Promise<{ success: boolean; error?: string }>
    mkdir: (sessionId: string, dirPath: string) => Promise<{ success: boolean; error?: string }>
    readFile: (sessionId: string, filePath: string) => Promise<{ success: boolean; content?: string; size?: number; error?: string }>
    writeFile: (sessionId: string, filePath: string, content: string) => Promise<{ success: boolean; error?: string }>
  }
  clipboard: {
    readText: () => Promise<string>
    writeText: (text: string) => Promise<void>
  }
  dialog: {
    openFile: (options: any) => Promise<{ canceled: boolean; filePaths: string[] }>
    selectDirectory: () => Promise<{ canceled: boolean; filePaths: string[] }>
  }
  file: {
    readAsDataUrl: (filePath: string) => Promise<string | null>
    getPathForFile: (file: File) => string | undefined
    readForAi: (sessionId: string, path: string, type: 'file' | 'dir') => Promise<{ success: boolean; output?: string; error?: string }>
  }
  chatHistory: {
    getAll: () => Promise<any[]>
    save: (entry: any) => Promise<void>
    delete: (sessionKey: string) => Promise<void>
    clearAll: () => Promise<void>
  }
  window: {
    minimize: () => void
    maximize: () => void
    close: () => void
    isMaximized: () => Promise<boolean>
    getPlatform: () => Promise<string>
    getSize: () => Promise<number[]>
    setSize: (width: number, height: number) => void
  }
  pty: {
    spawn: (id: string, cwd?: string) => Promise<{ success: boolean; error?: string }>
    write: (id: string, data: string) => void
    resize: (id: string, cols: number, rows: number) => void
    kill: (id: string) => Promise<{ success: boolean }>
    onData: (callback: (id: string, data: string) => void) => () => void
    onExit: (callback: (id: string, exitCode: number) => void) => () => void
  }
  nativeMenu: {
    openFileContextMenu: (payload: {
      requestId: string
      x: number
      y: number
      items: Array<{
        id: string
        label?: string
        shortcut?: string
        type?: 'normal' | 'separator'
        enabled?: boolean
        danger?: boolean
      }>
    }) => Promise<{ success: boolean; error?: string }>
    hideFileContextMenu: () => void
    onFileMenuAction: (callback: (requestId: string, actionId: string) => void) => () => void
    onFileContextRender: (callback: (payload: {
      requestId: string
      items: Array<{
        id: string
        label: string
        shortcut?: string
        type: 'normal' | 'separator'
        enabled: boolean
        danger: boolean
      }>
    }) => void) => () => void
    sendFileContextAction: (requestId: string, actionId: string) => void
    notifyFileContextReady: () => void
  }
  config: {
    getPath: () => Promise<string>
    openFile: () => Promise<{ success: boolean; path: string }>
  }
}

const api: ElectronAPI = {
  ssh: {
    connect: (config) => ipcRenderer.invoke('ssh:connect', config),
    disconnect: (sessionId) => ipcRenderer.invoke('ssh:disconnect', sessionId),
    sendData: (sessionId, data) => ipcRenderer.send('ssh:data', sessionId, data),
    resize: (sessionId, cols, rows) => ipcRenderer.send('ssh:resize', sessionId, cols, rows),
    exec: (sessionId, command) => ipcRenderer.invoke('ssh:exec', sessionId, command),
    onData: (callback) => {
      const handler = (_: any, sessionId: string, data: string) => callback(sessionId, data)
      ipcRenderer.on('ssh:data', handler)
      return () => ipcRenderer.removeListener('ssh:data', handler)
    },
    onClose: (callback) => {
      const handler = (_: any, sessionId: string) => callback(sessionId)
      ipcRenderer.on('ssh:close', handler)
      return () => ipcRenderer.removeListener('ssh:close', handler)
    },
    onError: (callback) => {
      const handler = (_: any, sessionId: string, error: string) => callback(sessionId, error)
      ipcRenderer.on('ssh:error', handler)
      return () => ipcRenderer.removeListener('ssh:error', handler)
    }
  },
  store: {
    getConnections: () => ipcRenderer.invoke('store:getConnections'),
    saveConnection: (conn) => ipcRenderer.invoke('store:saveConnection', conn),
    deleteConnection: (id) => ipcRenderer.invoke('store:deleteConnection', id),
    getSettings: () => ipcRenderer.invoke('store:getSettings'),
    saveSettings: (settings) => ipcRenderer.invoke('store:saveSettings', settings),
    getSkills: () => ipcRenderer.invoke('store:getSkills'),
    saveSkill: (skill) => ipcRenderer.invoke('store:saveSkill', skill),
    deleteSkill: (id) => ipcRenderer.invoke('store:deleteSkill', id),
    importSkills: (skills) => ipcRenderer.invoke('store:importSkills', skills)
  },
  ai: {
    testConnection: (settings) => ipcRenderer.invoke('ai:testConnection', settings),
    chat: (messages, settings, options) => ipcRenderer.invoke('ai:chat', messages, settings, options),
    chatStream: (messages, settings, streamId, options) => ipcRenderer.invoke('ai:chatStream', messages, settings, streamId, options),
    onStreamDelta: (callback) => {
      const handler = (_: any, streamId: string, delta: string) => callback(streamId, delta)
      ipcRenderer.on('ai:stream:delta', handler)
      return () => ipcRenderer.removeListener('ai:stream:delta', handler)
    },
    onStreamEnd: (callback) => {
      const handler = (_: any, streamId: string) => callback(streamId)
      ipcRenderer.on('ai:stream:end', handler)
      return () => ipcRenderer.removeListener('ai:stream:end', handler)
    },
    onStreamError: (callback) => {
      const handler = (_: any, streamId: string, error: string) => callback(streamId, error)
      ipcRenderer.on('ai:stream:error', handler)
      return () => ipcRenderer.removeListener('ai:stream:error', handler)
    },
    onCompacted: (callback) => {
      const handler = (_: any, streamId: string, info: any) => callback(streamId, info)
      ipcRenderer.on('ai:compacted', handler)
      return () => ipcRenderer.removeListener('ai:compacted', handler)
    },
    getAgents: () => ipcRenderer.invoke('ai:getAgents'),
    getAgentConfig: (agentId) => ipcRenderer.invoke('ai:getAgentConfig', agentId),
    getTokenInfo: (messages, modelName) => ipcRenderer.invoke('ai:getTokenInfo', messages, modelName),
    compact: (messages, settings) => ipcRenderer.invoke('ai:compact', messages, settings)
  },
  sftp: {
    ls: (sessionId, remotePath) => ipcRenderer.invoke('sftp:ls', sessionId, remotePath),
    download: (sessionId, remotePath, localPath) => ipcRenderer.invoke('sftp:download', sessionId, remotePath, localPath),
    upload: (sessionId, localPath, remotePath) => ipcRenderer.invoke('sftp:upload', sessionId, localPath, remotePath),
    uploadDir: (sessionId, localPath, remotePath) => ipcRenderer.invoke('sftp:uploadDir', sessionId, localPath, remotePath),
    isLocalDirectory: (localPath) => ipcRenderer.invoke('sftp:isLocalDirectory', localPath),
    move: (sessionId, srcPath, destPath) => ipcRenderer.invoke('sftp:move', sessionId, srcPath, destPath),
    copy: (sessionId, srcPath, destPath) => ipcRenderer.invoke('sftp:copy', sessionId, srcPath, destPath),
    delete: (sessionId, targetPath) => ipcRenderer.invoke('sftp:delete', sessionId, targetPath),
    rename: (sessionId, oldPath, newPath) => ipcRenderer.invoke('sftp:rename', sessionId, oldPath, newPath),
    createFile: (sessionId, filePath) => ipcRenderer.invoke('sftp:createFile', sessionId, filePath),
    mkdir: (sessionId, dirPath) => ipcRenderer.invoke('sftp:mkdir', sessionId, dirPath),
    readFile: (sessionId, filePath) => ipcRenderer.invoke('sftp:readFile', sessionId, filePath),
    writeFile: (sessionId, filePath, content) => ipcRenderer.invoke('sftp:writeFile', sessionId, filePath, content)
  },
  clipboard: {
    readText: () => ipcRenderer.invoke('clipboard:readText'),
    writeText: (text) => ipcRenderer.invoke('clipboard:writeText', text)
  },
  dialog: {
    openFile: (options) => ipcRenderer.invoke('dialog:openFile', options),
    selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory')
  },
  file: {
    readAsDataUrl: (filePath) => ipcRenderer.invoke('file:readAsDataUrl', filePath),
    getPathForFile: (file) => webUtils.getPathForFile(file),
    readForAi: (sessionId, path, type) => ipcRenderer.invoke('file:readForAi', sessionId, path, type)
  },
  chatHistory: {
    getAll: () => ipcRenderer.invoke('chatHistory:getAll'),
    save: (entry) => ipcRenderer.invoke('chatHistory:save', entry),
    delete: (sessionKey) => ipcRenderer.invoke('chatHistory:delete', sessionKey),
    clearAll: () => ipcRenderer.invoke('chatHistory:clearAll')
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    getPlatform: () => ipcRenderer.invoke('window:getPlatform'),
    getSize: () => ipcRenderer.invoke('window:getSize'),
    setSize: (width: number, height: number) => ipcRenderer.send('window:setSize', width, height)
  },
  pty: {
    spawn: (id, cwd) => ipcRenderer.invoke('pty:spawn', id, cwd),
    write: (id, data) => ipcRenderer.send('pty:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id) => ipcRenderer.invoke('pty:kill', id),
    onData: (callback) => {
      const handler = (_: any, id: string, data: string) => callback(id, data)
      ipcRenderer.on('pty:data', handler)
      return () => ipcRenderer.removeListener('pty:data', handler)
    },
    onExit: (callback) => {
      const handler = (_: any, id: string, exitCode: number) => callback(id, exitCode)
      ipcRenderer.on('pty:exit', handler)
      return () => ipcRenderer.removeListener('pty:exit', handler)
    }
  },
  nativeMenu: {
    openFileContextMenu: (payload) => ipcRenderer.invoke('menu:fileContext:open', payload),
    hideFileContextMenu: () => ipcRenderer.send('menu:fileContext:hide'),
    onFileMenuAction: (callback) => {
      const handler = (_: any, requestId: string, actionId: string) => callback(requestId, actionId)
      ipcRenderer.on('menu:fileContext:action', handler)
      return () => ipcRenderer.removeListener('menu:fileContext:action', handler)
    },
    onFileContextRender: (callback) => {
      const handler = (_: any, payload: {
        requestId: string
        items: Array<{
          id: string
          label: string
          shortcut?: string
          type: 'normal' | 'separator'
          enabled: boolean
          danger: boolean
        }>
      }) => callback(payload)
      ipcRenderer.on('menu:fileContext:render', handler)
      return () => ipcRenderer.removeListener('menu:fileContext:render', handler)
    },
    sendFileContextAction: (requestId: string, actionId: string) => ipcRenderer.send('menu:fileContext:action', requestId, actionId),
    notifyFileContextReady: () => ipcRenderer.send('menu:fileContext:ready')
  },
  config: {
    getPath: () => ipcRenderer.invoke('config:getPath'),
    openFile: () => ipcRenderer.invoke('config:openFile')
  }
}

contextBridge.exposeInMainWorld('electronAPI', api)
