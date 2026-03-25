export interface ConnectionConfig {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'privateKey'
  password?: string
  privateKey?: string
  passphrase?: string
  group?: string
  bgImage?: string
  bgOpacity?: number
  createdAt?: number
  updatedAt?: number
}

export interface Session {
  id: string
  connectionId: string
  name: string
  host: string
  status: 'connecting' | 'connected' | 'disconnected' | 'error'
  isLocal?: boolean
}

export interface AiMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  tokenCount?: number      // 估算的 token 数
  compacted?: boolean       // 是否为压缩摘要消息
  agentId?: string          // 产生此消息的 Agent
}

export type AiProvider = 'openai' | 'anthropic' | 'ollama' | 'custom' | 'deepseek' | 'kimi' | 'qwen' | 'gemini' | 'groq' | 'xai' | 'custom-anthropic'

export interface AiProfile {
  provider: AiProvider
  apiKey?: string
  apiUrl?: string
  model?: string
  models?: string[]
  ollamaUrl?: string
  customPrompt?: string
  temperature?: number
  maxTokens?: number
  topP?: number
}

export interface AiSettings {
  provider: AiProvider
  apiKey: string
  apiUrl: string
  model: string
  ollamaUrl: string
  customPrompt?: string
  temperature?: number
  maxTokens?: number
  topP?: number
  profiles?: Record<string, AiProfile>
  activeProfile?: string
}

export interface ChatHistoryEntry {
  sessionKey: string
  name: string
  messages: AiMessage[]
  createdAt: number
  updatedAt: number
}

export interface AgentConfig {
  id: string
  name: string
  description: string
  icon: string
  color: string
  temperature?: number
  builtin: boolean
}

export interface TokenInfo {
  currentTokens: number
  contextWindow: number
  maxOutput: number
  usageRatio: number    // 0-100
  isOverflow: boolean
  messagesCount: number
}

// Agent 自动执行结果
export interface AgentResult {
  id: string
  type: 'memory' | 'disk' | 'process' | 'network' | 'service' | 'generic'
  title: string
  summary: string          // AI 白话总结
  timestamp: number
  status: 'running' | 'done' | 'error'
  command: string          // 执行的命令
  rawOutput?: string       // 原始输出
  data?: AgentResultData   // 结构化数据
}

export interface AgentResultData {
  // Memory
  memoryTotal?: string
  memoryUsed?: string
  memoryFree?: string
  memoryPercent?: number
  swapTotal?: string
  swapUsed?: string
  // Disk
  disks?: Array<{ mount: string; size: string; used: string; avail: string; percent: number }>
  // Process
  processes?: Array<{ pid: string; name: string; cpu: string; mem: string; user?: string }>
  // Network
  connections?: Array<{ proto: string; local: string; remote: string; state: string }>
  // Service
  services?: Array<{ name: string; status: 'running' | 'stopped' | 'failed'; description?: string }>
  // Generic key-value
  items?: Array<{ label: string; value: string; color?: string }>
}

// Workflow types
export interface WorkflowNode {
  id: string
  title: string
  command: string
  description: string
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped'
  selected: boolean
  output?: string
  summary?: string
  error?: string
  branches?: WorkflowBranch[]
}

export interface WorkflowBranch {
  label: string
  description: string
  nodes: WorkflowNode[]
}

export interface Workflow {
  id: string
  title: string
  description: string
  status: 'planning' | 'confirmed' | 'running' | 'paused' | 'done' | 'error'
  nodes: WorkflowNode[]
  currentNodeIndex: number
  createdAt: number
}

export interface AppSettings {
  ai: AiSettings
  relaxedMode: boolean
  workflowMode: boolean
  termBgImage?: string | null
  termFontSize?: number
  termLineHeight?: number
  termTheme?: string
  termCursorStyle?: 'block' | 'underline' | 'bar'
  termCursorBlink?: boolean
  termOpacity?: number
  termScrollback?: number
  termFontFamily?: string
  sidebarCollapsed?: boolean
  defaultDownloadPath?: string
}

export interface AgentSkill {
  id: string
  title: string
  description: string
  tags: string[]
  compressedContext: string
  createdAt: number
}

// dangerous command patterns for relaxed mode
export const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*[rR]|--recursive)/,
  /\brm\s+-[a-zA-Z]*f/,
  /\bmkfs\b/,
  /\bformat\b/,
  /\bdd\s+if=/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bpoweroff\b/,
  /\binit\s+[06]\b/,
  /\biptables\s+-F/,
  /\bchmod\s+(-[a-zA-Z]*R|777)/,
  />\s*\/dev\/[sh]d/,
  /\bkill\s+-9\s+1\b/,
  /\bkillall\b/,
  /\bpasswd\b/,
  /\buserdel\b/,
  /\bgroupdel\b/,
  /\bmkswap\b/,
  /\bfdisk\b/,
  /\bparted\b/,
  /:(){ :|:& };:/
]

export function isDangerousCommand(cmd: string): boolean {
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(cmd))
}

export function extractCommands(text: string): string[] {
  const codeBlockRegex = /```(?:bash|sh|shell|zsh|powershell|ps1|bat|cmd)?\w*\s*\n([\s\S]*?)```/g
  const commands: string[] = []
  let match: RegExpExecArray | null
  while ((match = codeBlockRegex.exec(text)) !== null) {
    const block = match[1].trim()
    if (block) {
      commands.push(block)
    }
  }
  return commands
}

export interface SFTPFile {
  name: string
  type: 'd' | '-' | 'l'    // directory, file, symlink
  size: number             // bytes
  modifyTime: number       // timestamp in seconds or ms
  accessTime: number
  permissions: string      // e.g. 'drwxr-xr-x' or numeric '0755'
}

declare global {
  interface Window {
    electronAPI: {
      sftp: {
        ls: (sessionId: string, remotePath: string) => Promise<{ success: boolean; data?: SFTPFile[]; error?: string }>
        download: (sessionId: string, remotePath: string, localPath: string) => Promise<{ success: boolean; error?: string }>
        upload: (sessionId: string, localPath: string, remotePath: string) => Promise<{ success: boolean; error?: string }>
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
        selectDirectory: () => Promise<{ canceled: boolean; filePaths: string[] }>
        openFile: (options: any) => Promise<{ canceled: boolean; filePaths: string[] }>
      }
      file: {
        readAsDataUrl: (filePath: string) => Promise<string | null>
        readForAi: (sessionId: string, path: string, type: 'file' | 'dir') => Promise<{ success: boolean; output?: string; error?: string }>
      }
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
        getConnections: () => Promise<ConnectionConfig[]>
        saveConnection: (conn: ConnectionConfig) => Promise<void>
        deleteConnection: (id: string) => Promise<void>
        getSettings: () => Promise<AppSettings>
        saveSettings: (settings: AppSettings) => Promise<void>
        getSkills: () => Promise<AgentSkill[]>
        saveSkill: (skill: AgentSkill) => Promise<void>
        deleteSkill: (id: string) => Promise<void>
        importSkills: (skills: AgentSkill[]) => Promise<void>
      }
      ai: {
        testConnection: (settings: any) => Promise<{ success: boolean; error?: string }>
        chat: (
          messages: any[],
          settings: any,
          options?: any
        ) => Promise<{ success: boolean; reply?: string; error?: string }>
        chatStream: (
          messages: any[],
          settings: any,
          streamId: string,
          options?: any
        ) => Promise<{ success: boolean; error?: string }>
        onStreamDelta: (callback: (streamId: string, delta: string) => void) => () => void
        onStreamEnd: (callback: (streamId: string) => void) => () => void
        onStreamError: (callback: (streamId: string, error: string) => void) => () => void
        onCompacted: (callback: (streamId: string, info: any) => void) => () => void
        getAgents: () => Promise<AgentConfig[]>
        getAgentConfig: (agentId: string) => Promise<AgentConfig>
        getTokenInfo: (messages: any[], modelName: string) => Promise<TokenInfo>
        compact: (messages: any[], settings: any) => Promise<any>
      }
      chatHistory: {
        getAll: () => Promise<ChatHistoryEntry[]>
        save: (entry: ChatHistoryEntry) => Promise<void>
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
    }
  }
}

