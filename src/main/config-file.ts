import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import type { AppSettings } from './store'

/**
 * OpenTerm 配置文件管理
 * 路径: {userData}/openterm.jsonc
 * 双向同步: settings UI ↔ jsonc 文件
 */

// 获取配置文件路径
export function getConfigPath(): string {
  return join(app.getPath('userData'), 'openterm.jsonc')
}

// 去除 JSONC 注释后解析
function stripJsoncComments(text: string): string {
  let result = ''
  let inString = false
  let stringChar = ''
  let i = 0
  while (i < text.length) {
    if (inString) {
      if (text[i] === '\\') {
        result += text[i] + (text[i + 1] || '')
        i += 2
        continue
      }
      if (text[i] === stringChar) {
        inString = false
      }
      result += text[i]
      i++
    } else {
      if (text[i] === '"' || text[i] === "'") {
        inString = true
        stringChar = text[i]
        result += text[i]
        i++
      } else if (text[i] === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') i++
      } else if (text[i] === '/' && text[i + 1] === '*') {
        i += 2
        while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
        i += 2
      } else {
        result += text[i]
        i++
      }
    }
  }
  return result
}

function removeTrailingCommas(text: string): string {
  return text.replace(/,\s*([\]}])/g, '$1')
}

/**
 * 读取 openterm.jsonc → 返回 Partial<AppSettings>
 */
export function loadConfig(): Partial<AppSettings> {
  const configPath = getConfigPath()
  if (!existsSync(configPath)) return {}

  try {
    const raw = readFileSync(configPath, 'utf-8')
    const stripped = removeTrailingCommas(stripJsoncComments(raw))
    const data = JSON.parse(stripped)

    const result: Partial<AppSettings> = {}

    if (data.ai && typeof data.ai === 'object') {
      result.ai = {
        provider: data.ai.provider || 'openai',
        apiKey: data.ai.apiKey || '',
        apiUrl: data.ai.apiUrl || '',
        model: data.ai.model || '',
        ollamaUrl: data.ai.ollamaUrl || 'http://localhost:11434',
        customPrompt: data.ai.customPrompt,
        temperature: data.ai.temperature,
        maxTokens: data.ai.maxTokens,
        topP: data.ai.topP
      }

      // 加载 profiles
      if (data.ai.profiles && typeof data.ai.profiles === 'object') {
        result.ai.profiles = data.ai.profiles
      }
      if (typeof data.ai.activeProfile === 'string') {
        result.ai.activeProfile = data.ai.activeProfile
      }
    }

    if (typeof data.relaxedMode === 'boolean') result.relaxedMode = data.relaxedMode
    if (typeof data.termFontSize === 'number') result.termFontSize = data.termFontSize
    if (typeof data.termTheme === 'string') result.termTheme = data.termTheme
    if (typeof data.termCursorStyle === 'string') result.termCursorStyle = data.termCursorStyle as any
    if (typeof data.termCursorBlink === 'boolean') result.termCursorBlink = data.termCursorBlink
    if (typeof data.termLineHeight === 'number') result.termLineHeight = data.termLineHeight
    if (typeof data.termScrollback === 'number') result.termScrollback = data.termScrollback
    if (typeof data.termOpacity === 'number') result.termOpacity = data.termOpacity
    if (typeof data.termFontFamily === 'string') result.termFontFamily = data.termFontFamily
    if (typeof data.defaultDownloadPath === 'string') result.defaultDownloadPath = data.defaultDownloadPath

    return result
  } catch (err) {
    console.error('[config-file] Failed to load openterm.jsonc:', err)
    return {}
  }
}

/**
 * 序列化单个 profile 为 JSON 字符串块
 */
function serializeProfile(profile: any, indent: string): string {
  const lines: string[] = []
  lines.push(`${indent}  "provider": ${JSON.stringify(profile.provider || 'openai')},`)
  if (profile.apiKey) lines.push(`${indent}  "apiKey": ${JSON.stringify(profile.apiKey)},`)
  if (profile.apiUrl) lines.push(`${indent}  "apiUrl": ${JSON.stringify(profile.apiUrl)},`)
  if (profile.model) lines.push(`${indent}  "model": ${JSON.stringify(profile.model)},`)
  if (profile.models && profile.models.length > 0) lines.push(`${indent}  "models": ${JSON.stringify(profile.models)},`)
  if (profile.ollamaUrl && profile.provider === 'ollama') lines.push(`${indent}  "ollamaUrl": ${JSON.stringify(profile.ollamaUrl)},`)
  if (profile.temperature !== undefined) lines.push(`${indent}  "temperature": ${profile.temperature},`)
  if (profile.maxTokens !== undefined) lines.push(`${indent}  "maxTokens": ${profile.maxTokens},`)
  if (profile.topP !== undefined) lines.push(`${indent}  "topP": ${profile.topP},`)
  if (profile.customPrompt) lines.push(`${indent}  "customPrompt": ${JSON.stringify(profile.customPrompt)},`)
  // 去掉最后一行的尾逗号
  if (lines.length > 0) {
    lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, '')
  }
  return lines.join('\n')
}

/**
 * 将 AppSettings 写入 openterm.jsonc（带注释模板 + profiles 支持）
 */
export function saveConfig(settings: AppSettings): void {
  const configPath = getConfigPath()
  const profiles = settings.ai.profiles
  const hasProfiles = profiles && Object.keys(profiles).length > 0

  // 生成 profiles 块
  let profilesBlock = ''
  if (hasProfiles) {
    const profileEntries = Object.entries(profiles).map(([name, profile]) => {
      return `      ${JSON.stringify(name)}: {\n${serializeProfile(profile, '      ')}\n      }`
    })
    profilesBlock = `
    // 多 Profile 配置，可在设置面板或 AI 面板快速切换
    "profiles": {
${profileEntries.join(',\n')}
    },
    "activeProfile": ${JSON.stringify(settings.ai.activeProfile || '')},
`
  }

  const content = `{
  // OpenTerm 配置文件
  // 修改后重启生效，或在设置面板中保存

  // AI 提供商配置
  "ai": {
    // 可选值: openai | anthropic | deepseek | kimi | qwen | gemini | groq | xai | ollama | custom | custom-anthropic
    "provider": ${JSON.stringify(settings.ai.provider)},
    "apiKey": ${JSON.stringify(settings.ai.apiKey)},
    "apiUrl": ${JSON.stringify(settings.ai.apiUrl)},
    "model": ${JSON.stringify(settings.ai.model)},
    "ollamaUrl": ${JSON.stringify(settings.ai.ollamaUrl)},
${profilesBlock}
    // 模型参数
    "temperature": ${settings.ai.temperature ?? 0.7},         // 0-2, 数值越高越有创造性
    "maxTokens": ${settings.ai.maxTokens ?? 4096},            // 最大输出 token 数
    "topP": ${settings.ai.topP ?? 1},                         // 0-1, 核采样

    // 自定义系统提示词 (留空使用默认)
    "customPrompt": ${JSON.stringify(settings.ai.customPrompt || '')}
  },

  // 终端设置
  "termFontSize": ${settings.termFontSize ?? 13},
  "termTheme": ${JSON.stringify(settings.termTheme || 'github-dark')},
  "termCursorStyle": ${JSON.stringify(settings.termCursorStyle || 'block')},    // block | underline | bar
  "termCursorBlink": ${settings.termCursorBlink !== false},
  "termLineHeight": ${settings.termLineHeight ?? 1.2},
  "termFontFamily": ${JSON.stringify(settings.termFontFamily || "'JetBrains Mono', 'SF Mono', 'Menlo', monospace")},
  "termScrollback": ${settings.termScrollback ?? 5000},
  "termOpacity": ${settings.termOpacity ?? 100},

  // 其他
  "relaxedMode": ${settings.relaxedMode || false}${settings.defaultDownloadPath ? `,\n  "defaultDownloadPath": ${JSON.stringify(settings.defaultDownloadPath)}` : ''}
}
`

  try {
    writeFileSync(configPath, content, 'utf-8')
  } catch (err) {
    console.error('[config-file] Failed to save openterm.jsonc:', err)
  }
}
