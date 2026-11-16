/**
 * src/cdp/webmcp.ts — WebMCP（页面自注册工具）状态跟踪。
 *
 * 引擎事实（cloudflare/kitesurf packages/engine/src/cdp/webmcp.ts + e2e）：
 * - WebMCP.enable 按 CDP session 生效；工具列表只走 toolsAdded/toolsRemoved
 *   事件（enable 响应是 {}），toolsAdded 是增量 delta（可一页多事件）
 * - invokeTool {frameId,toolName,input} → {invocationId}；结果异步经
 *   toolResponded {invocationId,status:Completed|Error|Canceled,output?,errorText?}
 * - 页面侧 API：document.modelContext.registerTool({name,description,
 *   inputSchema,annotations,execute})；导航后工具随文档销毁，引擎会补
 *   toolsRemoved/toolsAdded
 * - output 形如 {content:[{type:'text',text}]}（MCP content blocks）
 *
 * 本模块只做 per-sessionId 状态记账；CDP 收发在 SessionBrowser。
 */

import type { JsonObject } from './types.ts'

export interface WebMcpTool {
  name: string
  description: string
  frameId: string
  inputSchema?: JsonObject
  annotations?: JsonObject
}

interface SessionState {
  /** 已向引擎发过 WebMCP.enable（引擎侧按 sessionId 记账，重复 enable 幂等但浪费）。 */
  enabled: boolean
  /** name → tool；toolsAdded 合并、toolsRemoved 删除。 */
  tools: Map<string, WebMcpTool>
}

export class WebMcpTracker {
  private sessions = new Map<string, SessionState>()

  private state(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId)
    if (!s) {
      s = { enabled: false, tools: new Map() }
      this.sessions.set(sessionId, s)
    }
    return s
  }

  markEnabled(sessionId: string): void {
    this.state(sessionId).enabled = true
  }

  isEnabled(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.enabled === true
  }

  /** toolsAdded 事件：params.tools[] 每项含 name/description/frameId/inputSchema/annotations。 */
  onToolsAdded(sessionId: string, tools: unknown): void {
    if (!sessionId || !Array.isArray(tools)) return
    const map = this.state(sessionId).tools
    for (const raw of tools) {
      if (typeof raw !== 'object' || raw === null) continue
      const t = raw as JsonObject
      const name = typeof t.name === 'string' ? t.name : ''
      const frameId = typeof t.frameId === 'string' ? t.frameId : ''
      if (!name || !frameId) continue
      const tool: WebMcpTool = { name, frameId, description: typeof t.description === 'string' ? t.description : '' }
      if (typeof t.inputSchema === 'object' && t.inputSchema !== null) tool.inputSchema = t.inputSchema as JsonObject
      if (typeof t.annotations === 'object' && t.annotations !== null) tool.annotations = t.annotations as JsonObject
      map.set(name, tool)
    }
  }

  /** toolsRemoved 事件：params.tools[] 每项含 name（frameId 可选）。 */
  onToolsRemoved(sessionId: string, tools: unknown): void {
    if (!sessionId || !Array.isArray(tools)) return
    const map = this.sessions.get(sessionId)?.tools
    if (!map) return
    for (const raw of tools) {
      if (typeof raw !== 'object' || raw === null) continue
      const name = (raw as JsonObject).name
      if (typeof name === 'string') map.delete(name)
    }
  }

  list(sessionId: string): WebMcpTool[] {
    return [...(this.sessions.get(sessionId)?.tools.values() ?? [])]
  }

  get(sessionId: string, name: string): WebMcpTool | undefined {
    return this.sessions.get(sessionId)?.tools.get(name)
  }

  /** session detach / 浏览器重连后丢弃（新 sessionId 需重新 enable）。 */
  drop(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  reset(): void {
    this.sessions.clear()
  }
}
