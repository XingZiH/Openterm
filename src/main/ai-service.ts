/**
 * AI Service — 重构版，集成 OpenCode 的对话管理机制
 *
 * 核心改进：
 * 1. 流式响应（SSE）支持
 * 2. 集成 Token 管理和上下文溢出检测
 * 3. 集成对话历史压缩
 * 4. 集成 Agent 系统
 * 5. 自动重试机制
 */

import { TokenManager } from './token-manager'
import { ChatCompaction } from './chat-compaction'
import { AgentManager } from './agent-manager'
import type { AgentConfig } from './agent-manager'
import type { BrowserWindow } from 'electron'

export interface AiMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  timestamp?: number
  tokenCount?: number     // 估算的 token 数
  compacted?: boolean      // 是否为压缩摘要消息
  agentId?: string         // 产生此消息的 Agent
}

export type AiProvider = 'openai' | 'anthropic' | 'ollama' | 'custom' | 'deepseek' | 'kimi' | 'qwen' | 'gemini' | 'groq' | 'xai' | 'custom-anthropic'

export interface AiSettings {
  provider: AiProvider
  apiKey?: string
  apiUrl?: string
  model: string
  ollamaUrl?: string
  customPrompt?: string
  temperature?: number
  maxTokens?: number
  topP?: number
  profiles?: Record<string, any>
  activeProfile?: string
}

// 重试配置
const MAX_RETRIES = 3
const RETRY_BASE_DELAY = 1000 // ms

export class AiService {
  private agentManager: AgentManager

  constructor() {
    this.agentManager = new AgentManager()
  }

  getAgentManager(): AgentManager {
    return this.agentManager
  }

  /**
   * 测试连接是否正常
   * 通过发送一个极简请求来验证 API Key 和 URL 是否可用
   */
  async testConnection(settings: AiSettings): Promise<boolean> {
    try {
      // 构造极简请求，仅要求返回 1 个 token 即可验证鉴权和连通性
      const testSettings = { ...settings, maxTokens: 1, temperature: 0 }
      const testMsg: AiMessage[] = [{ role: 'user', content: 'Hi' }]
      
      const agent = this.agentManager.getDefaultAgent()
      const systemPrompt = settings.customPrompt || agent.systemPrompt
      const fullMessages: Array<{ role: string; content: string }> = [
        { role: 'system', content: systemPrompt },
        ...testMsg.map(m => ({ role: m.role, content: m.content }))
      ]

      await this.rawChat(fullMessages as AiMessage[], testSettings)
      return true
    } catch (err: any) {
      throw new Error(`连接失败: ${err.message}`)
    }
  }

  /**
   * 完整的对话处理流程（非流式）
   * 集成 Agent + Token 管理 + 自动压缩
   */
  async chat(
    messages: Omit<AiMessage, 'id'>[],
    settings: AiSettings,
    options?: { agentId?: string; terminalContext?: string; sessionId?: string }
  ): Promise<string> {
    const agentId = options?.agentId || 'ops'
    const agent = this.agentManager.getAgent(agentId) || this.agentManager.getDefaultAgent()

    // 构建 system prompt
    const systemPrompt = this.agentManager.buildSystemPrompt(
      agentId,
      options?.terminalContext,
      options?.sessionId,
      settings.customPrompt
    )

    const fullMessages: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => ({ role: m.role, content: m.content }))
    ]

    // Token 溢出检测 & 自动压缩
    if (TokenManager.isOverflow(fullMessages, settings.model)) {
      const chatFn = async (msgs: Array<{ role: string; content: string }>, s: AiSettings) => {
        return this.rawChat(msgs as AiMessage[], s)
      }
      const result = await ChatCompaction.compactIfNeeded(
        messages,
        settings,
        chatFn
      )
      if (result.compacted) {
        // 用压缩后的消息重建
        const compactedFull = [
          { role: 'system', content: systemPrompt },
          ...result.messages.map(m => ({ role: m.role, content: m.content }))
        ]
        return this.rawChatWithRetry(compactedFull as AiMessage[], settings, agent)
      }
    }

    // 智能裁剪适配上下文窗口
    const fitted = TokenManager.fitToContext(fullMessages, settings.model)
    return this.rawChatWithRetry(fitted as AiMessage[], settings, agent)
  }

  /**
   * 流式对话（通过 IPC 推送 delta 到 renderer）
   */
  async chatStream(
    messages: AiMessage[],
    settings: AiSettings,
    window: BrowserWindow,
    streamId: string,
    options?: {
      agentId?: string
      terminalContext?: string
      sessionId?: string
    }
  ): Promise<void> {
    const agentId = options?.agentId || 'ops'
    const agent = this.agentManager.getAgent(agentId) || this.agentManager.getDefaultAgent()

    const systemPrompt = this.agentManager.buildSystemPrompt(
      agentId,
      options?.terminalContext,
      options?.sessionId,
      settings.customPrompt
    )

    let chatMessages = messages

    // 检查溢出 & 压缩
    const fullForCheck = [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => ({ role: m.role, content: m.content }))
    ]
    if (TokenManager.isOverflow(fullForCheck, settings.model)) {
      const chatFn = async (msgs: Array<{ role: string; content: string }>, s: AiSettings) => {
        return this.rawChat(msgs as AiMessage[], s)
      }
      const result = await ChatCompaction.compactIfNeeded(messages, settings, chatFn)
      if (result.compacted) {
        chatMessages = result.messages
        // 发布压缩事件
        window.webContents.send('ai:compacted', streamId, {
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
          messagesCompacted: messages.length - result.messages.length
        })
      }
    }

    const fullMessages = [
      { role: 'system', content: systemPrompt },
      ...chatMessages.map(m => ({ role: m.role, content: m.content }))
    ]

    const fitted = TokenManager.fitToContext(fullMessages, settings.model)

    try {
      await this.rawChatStream(fitted as AiMessage[], settings, agent, window, streamId)
    } catch (err: any) {
      window.webContents.send('ai:stream:error', streamId, err.message)
    }
  }

  /**
   * 获取当前对话的 Token 使用信息
   */
  getTokenInfo(messages: AiMessage[], modelName: string) {
    const apiMessages = messages.map(m => ({ role: m.role, content: m.content }))
    const limits = TokenManager.getModelLimits(modelName)
    const currentTokens = TokenManager.estimateMessagesTokens(apiMessages)
    const usageRatio = TokenManager.getUsageRatio(apiMessages, modelName)
    const isOverflow = TokenManager.isOverflow(apiMessages, modelName)

    return {
      currentTokens,
      contextWindow: limits.contextWindow,
      maxOutput: limits.maxOutput,
      usageRatio: Math.round(usageRatio * 100),
      isOverflow,
      messagesCount: messages.length
    }
  }

  /**
   * 手动触发压缩
   */
  async manualCompact(
    messages: AiMessage[],
    settings: AiSettings
  ) {
    const chatFn = async (msgs: Array<{ role: string; content: string }>, s: AiSettings) => {
      return this.rawChat(msgs as AiMessage[], s)
    }
    return ChatCompaction.compact(messages, settings, chatFn)
  }

  // ============ 内部方法 ============

  /**
   * 带重试的 API 调用
   */
  private async rawChatWithRetry(
    messages: AiMessage[],
    settings: AiSettings,
    agent: AgentConfig
  ): Promise<string> {
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.rawChat(messages, settings)
      } catch (err: any) {
        lastError = err
        // 不重试非 5xx 错误
        if (err.message?.includes('4')) break
        if (attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_DELAY * Math.pow(2, attempt)
          await new Promise(resolve => setTimeout(resolve, delay))
        }
      }
    }
    throw lastError
  }

  /**
   * 原始 API 调用（非流式）
   */
  private async rawChat(messages: AiMessage[], settings: AiSettings): Promise<string> {
    switch (settings.provider) {
      case 'anthropic':
      case 'custom-anthropic':
        return this.chatAnthropic(messages, settings)
      case 'ollama':
        return this.chatOllama(messages, settings)
      case 'custom':
      case 'openai':
      case 'deepseek':
      case 'kimi':
      case 'qwen':
      case 'gemini':
      case 'groq':
      case 'xai':
      default:
        return this.chatOpenAICompat(messages, settings)
    }
  }

  /**
   * 流式 API 调用
   */
  private async rawChatStream(
    messages: AiMessage[],
    settings: AiSettings,
    agent: AgentConfig,
    window: BrowserWindow,
    streamId: string
  ): Promise<void> {
    switch (settings.provider) {
      case 'anthropic':
      case 'custom-anthropic':
        return this.streamAnthropic(messages, settings, window, streamId)
      case 'ollama':
        return this.streamOllama(messages, settings, window, streamId)
      case 'custom':
      case 'openai':
      case 'deepseek':
      case 'kimi':
      case 'qwen':
      case 'gemini':
      case 'groq':
      case 'xai':
      default:
        return this.streamOpenAICompat(messages, settings, window, streamId)
    }
  }

  // --- 辅助方法：修复 API URL ---
  private resolveApiUrl(apiUrl: string | undefined): string {
    const url = apiUrl || 'https://api.openai.com/v1/chat/completions'
    // 如果用户只填了 baseURL (例如 https://ai.qaq.al/v1)，像 OpenCode 和 OpenAI SDK 一样自动补充 '/chat/completions'
    if (url.endsWith('/v1')) {
      return url + '/chat/completions'
    }
    if (url.endsWith('/v1/')) {
      return url + 'chat/completions'
    }
    // 如果是个普通域名没有路径，也尽量补齐（除非明确包含了别的路径）
    try {
      const parsed = new URL(url)
      if (parsed.pathname === '/' || parsed.pathname === '') {
        return url.replace(/\/$/, '') + '/v1/chat/completions'
      }
    } catch {
      // ignore parse err
    }
    return url
  }

  // --- OpenAI Compatible (non-streaming) ---
  private async chatOpenAICompat(messages: AiMessage[], settings: AiSettings): Promise<string> {
    const url = this.resolveApiUrl(settings.apiUrl)

    if (!url) throw new Error('请配置 API URL')

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (settings.apiKey) {
      headers['Authorization'] = `Bearer ${settings.apiKey}`
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: settings.model || 'gpt-4o-mini',
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        temperature: settings.temperature ?? 0.7,
        max_tokens: settings.maxTokens ?? 4096,
        top_p: settings.topP ?? 1,
        stream: false
      })
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`API error: ${response.status} - ${errorText}`)
    }

    let data
    try {
      data = await response.json()
    } catch (e) {
      const text = await response.text().catch(() => '')
      throw new Error(`API 返回了非 JSON 格式的数据。请检查 API 地址是否填写正确。返回内容前缀: ${text.slice(0, 100)}`)
    }
    
    return data?.choices?.[0]?.message?.content || ''
  }

  // --- OpenAI Compatible (streaming) ---
  private async streamOpenAICompat(
    messages: AiMessage[],
    settings: AiSettings,
    window: BrowserWindow,
    streamId: string
  ): Promise<void> {
    const url = this.resolveApiUrl(settings.apiUrl)

    if (!url) throw new Error('请配置 API URL')

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (settings.apiKey) {
      headers['Authorization'] = `Bearer ${settings.apiKey}`
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(new Error('请求连接超时，请检查网络代理或 API 地址是否正确。')), 15000)

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: settings.model || 'gpt-4o-mini',
          messages: messages.map(m => ({ role: m.role, content: m.content })),
          temperature: settings.temperature ?? 0.7,
          max_tokens: settings.maxTokens ?? 4096,
          top_p: settings.topP ?? 1,
          stream: true
        }),
        signal: controller.signal as RequestInit['signal']
      })
      clearTimeout(timeoutId)
    } catch (err: any) {
      clearTimeout(timeoutId)
      throw new Error(`网络请求失败: ${err.message}`)
    }

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`API error: ${response.status} - ${errorText}`)
    }

    if (!response.body) throw new Error('No response body')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()

    // 独立进行后台流式读取，不阻塞当前 IPC 调用返回
    ;(async () => {
      let buffer = ''
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || !trimmed.startsWith('data: ')) continue
            const data = trimmed.slice(6)
            if (data === '[DONE]') {
              window.webContents.send('ai:stream:end', streamId)
              return
            }
            try {
              const parsed = JSON.parse(data)
              const delta = parsed.choices?.[0]?.delta?.content
              if (delta) {
                window.webContents.send('ai:stream:delta', streamId, delta)
              }
            } catch {
              // ignore json parse errors
            }
          }
        }
        window.webContents.send('ai:stream:end', streamId)
      } catch (err: any) {
        window.webContents.send('ai:stream:error', streamId, err.message)
      }
    })()
  }

  // --- Anthropic (non-streaming) ---
  private async chatAnthropic(messages: AiMessage[], settings: AiSettings): Promise<string> {
    const url = settings.apiUrl || 'https://api.anthropic.com/v1/messages'

    const systemMsg = messages.find(m => m.role === 'system')
    const chatMsgs = messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content
    }))

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': settings.apiKey || '',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: settings.model || 'claude-sonnet-4-20250514',
        max_tokens: settings.maxTokens ?? 4096,
        temperature: settings.temperature ?? 0.7,
        top_p: settings.topP ?? 1,
        system: systemMsg?.content || '',
        messages: chatMsgs
      })
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Anthropic API error: ${response.status} - ${errorText}`)
    }

    const data = await response.json()
    if (data.content && Array.isArray(data.content)) {
      return data.content
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('')
    }
    return data.content || ''
  }

  // --- Anthropic (streaming) ---
  private async streamAnthropic(
    messages: AiMessage[],
    settings: AiSettings,
    window: BrowserWindow,
    streamId: string
  ): Promise<void> {
    const url = settings.apiUrl || 'https://api.anthropic.com/v1/messages'

    const systemMsg = messages.find(m => m.role === 'system')
    const chatMsgs = messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content
    }))

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': settings.apiKey || '',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: settings.model || 'claude-sonnet-4-20250514',
        max_tokens: settings.maxTokens ?? 4096,
        temperature: settings.temperature ?? 0.7,
        top_p: settings.topP ?? 1,
        system: systemMsg?.content || '',
        messages: chatMsgs,
        stream: true
      })
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Anthropic API error: ${response.status} - ${errorText}`)
    }

    if (!response.body) throw new Error('No response body')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data: ')) continue
          try {
            const data = JSON.parse(trimmed.slice(6))
            if (data.type === 'content_block_delta' && data.delta?.text) {
              window.webContents.send('ai:stream:delta', streamId, data.delta.text)
            }
            if (data.type === 'message_stop') {
              window.webContents.send('ai:stream:end', streamId)
              return
            }
          } catch { /* ignore */ }
        }
      }
      window.webContents.send('ai:stream:end', streamId)
    } catch (err: any) {
      window.webContents.send('ai:stream:error', streamId, err.message)
    }
  }

  // --- Ollama (non-streaming) ---
  private async chatOllama(messages: AiMessage[], settings: AiSettings): Promise<string> {
    const url = `${settings.ollamaUrl || 'http://localhost:11434'}/api/chat`

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.model || 'llama3',
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        stream: false
      })
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Ollama API error: ${response.status} - ${errorText}`)
    }

    const data = await response.json()
    return data.message?.content || ''
  }

  // --- Ollama (streaming) ---
  private async streamOllama(
    messages: AiMessage[],
    settings: AiSettings,
    window: BrowserWindow,
    streamId: string
  ): Promise<void> {
    const url = `${settings.ollamaUrl || 'http://localhost:11434'}/api/chat`

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.model || 'llama3',
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        stream: true
      })
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Ollama API error: ${response.status} - ${errorText}`)
    }

    if (!response.body) throw new Error('No response body')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const data = JSON.parse(line)
            if (data.message?.content) {
              window.webContents.send('ai:stream:delta', streamId, data.message.content)
            }
            if (data.done) {
              window.webContents.send('ai:stream:end', streamId)
              return
            }
          } catch { /* ignore */ }
        }
      }
      window.webContents.send('ai:stream:end', streamId)
    } catch (err: any) {
      window.webContents.send('ai:stream:error', streamId, err.message)
    }
  }
}
