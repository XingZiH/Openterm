/**
 * Agent Manager — 移植自 OpenCode 的 Agent 执行机制
 *
 * 核心功能：
 * 1. 多 Agent 模式：ops / diagnose / script / custom
 * 2. 每个 Agent 有独立的 system prompt
 * 3. 支持自定义 Agent
 *
 * 对应 OpenCode 源码：agent/agent.ts
 */

export interface AgentConfig {
  id: string
  name: string
  description: string
  systemPrompt: string
  icon: string           // emoji icon
  color: string          // CSS color for UI
  temperature?: number
  maxTokens?: number
  hidden?: boolean       // 是否在 UI 中隐藏
  builtin: boolean       // 是否为内置 Agent
}

// 内置 Agent 定义（移植自 OpenCode 的 Agent 架构思想）
const BUILTIN_AGENTS: AgentConfig[] = [
  {
    id: 'smart',
    name: '智能',
    description: '全能极客：能够处理运维排障、全栈代码编写、系统文件处理等全方位请求',
    icon: '💡',
    color: '#a6e22e',
    temperature: 0.5,
    builtin: true,
    systemPrompt: `你是 OpenTerm 的智能核心 Agent，一个已经内置运行在本服务器环境内的资深全栈极客与系统管理员助手。

【绝对禁忌：拒绝网页版客服废话】
1. 绝对不要像网页端客服那样啰嗦讲话！绝不要说“好的，我来帮你”、“你可以运行以下命令”、“脚本已生成”等任何过渡性废话。
2. 你的回答必须极其简短、克制、冷酷、专业。就像真正的 Linux 原生工具一样。
3. 任何代码或命令，直接用 \`\`\`bash 给出，千万不要在代码块前后加啰嗦的解释。

【交互范例】
当用户说：“帮我在/opt新建一个采集脚本”
❌ 错误回答：“好的！这里是为你准备的脚本内容，你可以执行以下命令来创建并赋权：\`\`\`bash...”
✅ 正确回答：
正在为您位于 /opt 的目录生成系统采集脚本...
\`\`\`bash
cat > /opt/sysinfo.sh <<'EOF'
...内容...
EOF
chmod +x /opt/sysinfo.sh
\`\`\`
生成完毕。

【响应格式与思考】
如果面对极其复杂的问题，你可以在 <thinking>...</thinking> 块中展现思考过程，但不要把这段心跳发散给主要对话区。将最终指令放在 <response>...</response> 块中即可（通常只需输出代码块和极短的状态说明）。

【附加文件内容处理 (Drag-to-Chat)】
检测到 \`<attached_file path="...">...\` 时，你可以直接读取并给出修改指令。如果涉及直接覆盖或替换，利用命令生成目标效果。

【基准原则】
- 对于危险命令（如 rm -rf, mkfs），必须用红色高亮（加 ⚠️危险 标记）提醒！
- 用最少的字符传达最精确的信息。`
  },
  {
    id: 'diagnose',
    name: '诊断专家',
    description: '分析终端输出和日志，诊断系统问题，给出解决方案',
    icon: '🔍',
    color: '#f0883e',
    temperature: 0.5,
    builtin: true,
    systemPrompt: `你是一个 Linux 系统诊断专家。你的职责是分析用户提供的终端输出、日志、错误信息，找出问题根因并给出解决方案。

规则：
1. 仔细分析用户提供的终端输出和错误信息
2. 按照以下结构组织回复：
   - 🔍 **问题分析**：描述观察到的异常
   - 🧠 **可能原因**：列出可能的原因（按可能性排序）
   - ✅ **解决方案**：给出具体的修复命令（用 \`\`\`bash 代码块包裹）
   - ⚠️ **预防建议**：如何避免类似问题
3. 如果信息不足，先给出诊断命令来收集更多信息
4. 对于复杂问题，建议分步排查
5. 回复使用中文`
  },
  {
    id: 'script',
    name: '脚本生成',
    description: '生成完整的 Shell 脚本，适合复杂自动化任务',
    icon: '📝',
    color: '#a371f7',
    temperature: 0.3,
    builtin: true,
    systemPrompt: `你是一个 Shell 脚本开发专家。你的职责是根据用户需求生成完整的、可直接运行的 Shell 脚本。

规则：
1. 生成完整的 Shell 脚本，包含：
   - 适当的 shebang 行（#!/bin/bash）
   - 错误处理（set -euo pipefail）
   - 参数验证
   - 详细的注释
   - 日志输出
2. 脚本用 \`\`\`bash 代码块包裹
3. 在脚本前后给出：
   - 📋 **功能说明**：脚本做什么
   - 📌 **使用方法**：如何运行和传参
   - ⚠️ **注意事项**：权限要求、依赖等
4. 遵循 Shell 脚本最佳实践（引用变量、避免 eval 等）
5. 对于复杂脚本提供测试建议
6. 回复使用中文`
  },
  {
    id: 'monitor',
    name: '监控告警',
    description: '服务器性能监控、资源分析和告警处理',
    icon: '📊',
    color: '#3fb950',
    temperature: 0.5,
    builtin: true,
    systemPrompt: `你是一个服务器监控和性能优化专家。你的职责是帮助用户监控服务器状态、分析性能瓶颈、处理告警。

规则：
1. 帮助用户设置和解读监控命令（top、htop、iostat、vmstat、netstat 等）
2. 分析性能数据时使用结构化输出：
   - 📊 **当前状态**：关键指标概览
   - ⚡ **瓶颈分析**：资源瓶颈在哪里
   - 🛠 **优化建议**：具体的优化命令
3. 命令用 \`\`\`bash 代码块包裹
4. 提供长期监控建议（如 cron 定时检查）
5. 及时提醒危险指标（磁盘满、内存不足等）
6. 回复使用中文`
  },
  {
    // 隐藏 Agent：用于对话压缩，不显示在 UI 中
    id: 'compaction',
    name: '压缩助手',
    description: '内部使用：生成对话摘要',
    icon: '📋',
    color: '#8b949e',
    temperature: 0.3,
    builtin: true,
    hidden: true,
    systemPrompt: `你是一个对话摘要生成助手。你会收到一段对话历史，你需要生成一份结构化的摘要，让另一个 AI 助手能够基于这份摘要继续之前的工作。摘要必须准确、完整、有条理。`
  }
]

export class AgentManager {
  private agents: Map<string, AgentConfig> = new Map()

  constructor() {
    // 加载内置 Agent
    for (const agent of BUILTIN_AGENTS) {
      this.agents.set(agent.id, agent)
    }
  }

  /**
   * 获取所有可见 Agent（UI 显示用）
   */
  getVisibleAgents(): AgentConfig[] {
    return Array.from(this.agents.values()).filter(a => !a.hidden)
  }

  /**
   * 获取所有 Agent（包括隐藏的）
   */
  getAllAgents(): AgentConfig[] {
    return Array.from(this.agents.values())
  }

  /**
   * 获取指定 Agent
   */
  getAgent(id: string): AgentConfig | undefined {
    return this.agents.get(id)
  }

  /**
   * 获取默认 Agent
   */
  getDefaultAgent(): AgentConfig {
    return this.agents.get('smart') || BUILTIN_AGENTS[0]
  }

  /**
   * 添加/更新自定义 Agent
   */
  setCustomAgent(agent: AgentConfig): void {
    this.agents.set(agent.id, { ...agent, builtin: false })
  }

  /**
   * 删除自定义 Agent（不能删除内置 Agent）
   */
  removeCustomAgent(id: string): boolean {
    const agent = this.agents.get(id)
    if (!agent || agent.builtin) return false
    this.agents.delete(id)
    return true
  }

  /**
   * 从持久化数据加载自定义 Agent
   */
  loadCustomAgents(agents: AgentConfig[]): void {
    for (const agent of agents) {
      if (!agent.builtin) {
        this.agents.set(agent.id, agent)
      }
    }
  }

  /**
   * 获取需要持久化的自定义 Agent 列表
   */
  getCustomAgents(): AgentConfig[] {
    return Array.from(this.agents.values()).filter(a => !a.builtin)
  }

  /**
   * 根据 Agent 构建 system prompt
   * 可以附加终端上下文
   */
  buildSystemPrompt(
    agentId: string, 
    terminalContext?: string, 
    sessionId?: string,
    customPrompt?: string
  ): string {
    const agent = this.getAgent(agentId) || this.getDefaultAgent()
    let prompt = customPrompt || agent.systemPrompt

    if (sessionId?.startsWith('local-')) {
      const isWin = process.platform === 'win32'
      const osName = isWin ? 'Windows (PowerShell 环境)' : (process.platform === 'darwin' ? 'macOS 本地终端' : 'Linux 本地终端')
      prompt += `\n\n【！！！最高优先级运行环境约束！！！】\n当前并不是 SSH 远程服务器，而是用户的 ${osName}！前面的任何默认规范（如强制输出 bash 块等）在这里必须被推翻！\n`
      if (isWin) {
        prompt += `- 这是纯洁的 Windows PowerShell 环境！绝不可使用 \`2>/dev/null\`、\`&&\` 串联、或者 Linux 专属的如 \`find\`, \`strings\`, \`xxd\`, \`head\`, \`grep\`, \`ls -lah\` 等原生命令。\n- 即使你看到传入的文件路径是类似 \`/PythonProject\` 这样的格式，在此时的 Node 环境下它实际上等同于 \`C:\\PythonProject\`，绝对不可以因此误以为这是 Linux 系统！\n- 如果你需要生成供用户执行的脚本或指令，绝对必须用 \`\`\`powershell 包裹代码块！！绝不能再用 \`\`\`bash ！！\n- PowerShell 内置命令参考：列出文件必须用 \`Get-ChildItem\` (可以直接用 \`ls\`，但**决不能带 -lah 等 Linux 参数**); 读取文件用 \`Get-Content\` (或cat); 搜索用 \`Select-String\`。`
      }
    }

    if (terminalContext) {
      prompt += `\n\n[当前终端最近输出]\n${terminalContext}\n[终端输出结束]`
    }

    return prompt
  }
}
