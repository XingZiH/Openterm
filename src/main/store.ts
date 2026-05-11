import { loadConfig, saveConfig } from './config-file'

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
  createdAt: number
  updatedAt: number
}

export type AiProvider = 'openai' | 'anthropic' | 'ollama' | 'custom' | 'deepseek' | 'kimi' | 'qwen' | 'gemini' | 'groq' | 'xai' | 'custom-anthropic'

export interface AppSettings {
  ai: {
    provider: AiProvider
    apiKey: string
    apiUrl: string
    model: string
    ollamaUrl: string
    customPrompt?: string
    temperature?: number
    maxTokens?: number
    topP?: number
    profiles?: Record<string, {
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
    }>
    activeProfile?: string
  }
  relaxedMode: boolean
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

export interface ChatHistoryEntry {
  sessionKey: string   // connectionId or custom key
  name: string         // display name
  messages: { role: 'user' | 'assistant'; content: string; timestamp: number }[]
  createdAt: number
  updatedAt: number
}

export interface AgentSkill {
  id: string
  title: string
  description: string
  tags: string[]
  compressedContext: string
  createdAt: number
}

const DEFAULT_SETTINGS: AppSettings = {
  ai: {
    provider: 'openai',
    apiKey: '',
    apiUrl: '',
    model: '',
    ollamaUrl: 'http://localhost:11434',
    temperature: 0.7,
    maxTokens: 4096,
    topP: 1
  },
  relaxedMode: false
}

function cloneFromJson<T>(json: string): T {
  return JSON.parse(json) as T
}

export class Store {
  private store: any = null
  private settingsCacheJson: string | null = null

  private async getStore(): Promise<any> {
    if (this.store) return this.store
    const ElectronStore = (await import('electron-store')).default
    this.store = new ElectronStore({
      name: 'openterm-data',
      defaults: {
        connections: [] as ConnectionConfig[],
        settings: DEFAULT_SETTINGS,
        chatHistory: [] as ChatHistoryEntry[],
        skills: [] as AgentSkill[]
      }
    })
    return this.store
  }

  async getConnections(): Promise<ConnectionConfig[]> {
    const store = await this.getStore()
    return store.get('connections') as ConnectionConfig[]
  }

  async saveConnection(conn: ConnectionConfig): Promise<void> {
    const store = await this.getStore()
    const connections = store.get('connections') as ConnectionConfig[]
    const idx = connections.findIndex((c: ConnectionConfig) => c.id === conn.id)
    if (idx >= 0) {
      connections[idx] = { ...conn, updatedAt: Date.now() }
    } else {
      connections.push({ ...conn, createdAt: Date.now(), updatedAt: Date.now() })
    }
    store.set('connections', connections)
  }

  async deleteConnection(id: string): Promise<void> {
    const store = await this.getStore()
    const connections = (store.get('connections') as ConnectionConfig[]).filter(
      (c: ConnectionConfig) => c.id !== id
    )
    store.set('connections', connections)
  }

  async getSettings(): Promise<AppSettings> {
    // 内存缓存：避免每次调用都读取磁盘和解析 JSONC
    // 统一返回深拷贝，防止外部修改污染缓存
    if (this.settingsCacheJson) return cloneFromJson<AppSettings>(this.settingsCacheJson)

    const store = await this.getStore()
    const base = store.get('settings') as AppSettings
    let merged = base

    // 合并 jsonc 配置覆盖（不可变合并，避免修改 store 返回对象）
    try {
      const fileConfig = loadConfig()
      const mergedAi = fileConfig.ai ? { ...base.ai, ...fileConfig.ai } : base.ai
      const { ai: _ignoredAi, ...rest } = fileConfig
      merged = { ...base, ...rest, ai: mergedAi }
    } catch (err) {
      console.error('[store] Failed to merge config file:', err)
    }

    this.settingsCacheJson = JSON.stringify(merged)
    return cloneFromJson<AppSettings>(this.settingsCacheJson)
  }

  async saveSettings(settings: AppSettings): Promise<void> {
    const store = await this.getStore()
    store.set('settings', settings)
    this.settingsCacheJson = null // 失效缓存
    // 同步写入 jsonc 配置文件
    try {
      saveConfig(settings)
    } catch (err) {
      console.error('[store] Failed to save config file:', err)
    }
  }

  // --- Agent Skills ---

  async getSkills(): Promise<AgentSkill[]> {
    const store = await this.getStore()
    return (store.get('skills') || []) as AgentSkill[]
  }

  async saveSkill(skill: AgentSkill): Promise<void> {
    const store = await this.getStore()
    const skills = (store.get('skills') || []) as AgentSkill[]
    const idx = skills.findIndex((s: AgentSkill) => s.id === skill.id)
    if (idx >= 0) {
      skills[idx] = skill
    } else {
      skills.push(skill)
    }
    store.set('skills', skills)
  }

  async deleteSkill(id: string): Promise<void> {
    const store = await this.getStore()
    let skills = (store.get('skills') || []) as AgentSkill[]
    skills = skills.filter((s: AgentSkill) => s.id !== id)
    store.set('skills', skills)
  }

  async importSkills(newSkills: AgentSkill[]): Promise<void> {
    const store = await this.getStore()
    const skills = (store.get('skills') || []) as AgentSkill[]
    
    // Merge by ID
    for (const ns of newSkills) {
      const idx = skills.findIndex((s: AgentSkill) => s.id === ns.id)
      if (idx >= 0) {
        skills[idx] = ns
      } else {
        skills.push(ns)
      }
    }
    store.set('skills', skills)
  }

  // --- Chat History ---

  async getChatHistory(): Promise<ChatHistoryEntry[]> {
    const store = await this.getStore()
    return (store.get('chatHistory') || []) as ChatHistoryEntry[]
  }

  async saveChatSession(entry: ChatHistoryEntry): Promise<void> {
    const store = await this.getStore()
    const history = (store.get('chatHistory') || []) as ChatHistoryEntry[]
    const idx = history.findIndex((h: ChatHistoryEntry) => h.sessionKey === entry.sessionKey)
    if (idx >= 0) {
      history[idx] = { ...entry, updatedAt: Date.now() }
    } else {
      history.push({ ...entry, createdAt: Date.now(), updatedAt: Date.now() })
    }
    store.set('chatHistory', history)
  }

  async deleteChatSession(sessionKey: string): Promise<void> {
    const store = await this.getStore()
    const history = (store.get('chatHistory') || []) as ChatHistoryEntry[]
    store.set('chatHistory', history.filter((h: ChatHistoryEntry) => h.sessionKey !== sessionKey))
  }

  async clearAllChatHistory(): Promise<void> {
    const store = await this.getStore()
    store.set('chatHistory', [])
  }
}

