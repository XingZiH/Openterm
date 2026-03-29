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

export interface CredentialProfile {
  id: string
  name: string
  username?: string
  authType: 'password' | 'privateKey'
  password?: string
  privateKey?: string
  passphrase?: string
  createdAt: number
  updatedAt: number
}

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
  uiTheme?: 'dark' | 'light'
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

export class Store {
  private store: any = null

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
    const store = await this.getStore()
    const base = store.get('settings') as AppSettings
    // 合并 jsonc 配置覆盖
    try {
      const fileConfig = loadConfig()
      if (fileConfig.ai) {
        base.ai = { ...base.ai, ...fileConfig.ai }
      }
      const { ai, ...rest } = fileConfig
      Object.assign(base, rest)
    } catch (err) {
      console.error('[store] Failed to merge config file:', err)
    }
    return base
  }

  async saveSettings(settings: AppSettings): Promise<void> {
    const store = await this.getStore()
    store.set('settings', settings)
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

  // --- Credential Profiles ---

  async getCredentialProfiles(): Promise<CredentialProfile[]> {
    const store = await this.getStore()
    return (store.get('credentialProfiles') || []) as CredentialProfile[]
  }

  async saveCredentialProfile(profile: CredentialProfile): Promise<void> {
    const store = await this.getStore()
    const profiles = (store.get('credentialProfiles') || []) as CredentialProfile[]
    const idx = profiles.findIndex((p: CredentialProfile) => p.id === profile.id)
    if (idx >= 0) {
      profiles[idx] = { ...profile, updatedAt: Date.now() }
    } else {
      profiles.push({ ...profile, createdAt: Date.now(), updatedAt: Date.now() })
    }
    store.set('credentialProfiles', profiles)
  }

  async deleteCredentialProfile(id: string): Promise<void> {
    const store = await this.getStore()
    const profiles = (store.get('credentialProfiles') || []) as CredentialProfile[]
    store.set('credentialProfiles', profiles.filter((p: CredentialProfile) => p.id !== id))
  }

  async exportAll(): Promise<object> {
    const store = await this.getStore()
    return {
      connections: store.get('connections') || [],
      settings: store.get('settings') || {},
      credentialProfiles: store.get('credentialProfiles') || [],
      skills: store.get('skills') || []
    }
  }

  async importAll(data: any): Promise<void> {
    const store = await this.getStore()
    // Merge connections
    if (Array.isArray(data.connections)) {
      const existing = (store.get('connections') || []) as ConnectionConfig[]
      for (const conn of data.connections) {
        const idx = existing.findIndex((c: ConnectionConfig) => c.id === conn.id)
        if (idx >= 0) existing[idx] = conn
        else existing.push(conn)
      }
      store.set('connections', existing)
    }
    // Merge credential profiles
    if (Array.isArray(data.credentialProfiles)) {
      const existing = (store.get('credentialProfiles') || []) as CredentialProfile[]
      for (const profile of data.credentialProfiles) {
        const idx = existing.findIndex((p: CredentialProfile) => p.id === profile.id)
        if (idx >= 0) existing[idx] = profile
        else existing.push(profile)
      }
      store.set('credentialProfiles', existing)
    }
    // Merge skills
    if (Array.isArray(data.skills)) {
      const existing = (store.get('skills') || []) as AgentSkill[]
      for (const skill of data.skills) {
        const idx = existing.findIndex((s: AgentSkill) => s.id === skill.id)
        if (idx >= 0) existing[idx] = skill
        else existing.push(skill)
      }
      store.set('skills', existing)
    }
  }
}

