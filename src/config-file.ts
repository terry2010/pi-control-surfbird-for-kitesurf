/**
 * src/config-file.ts — surfbird.json 的读取/合并/原子写（host 无关）。
 *
 * pi 的插件没有宿主 options 通道（settings.json 只管 pi 自己），所以
 * 配置放自己的 JSON 文件：
 *   - 全局：$PI_CODING_AGENT_DIR/surfbird.json，默认 ~/.pi/agent/surfbird.json
 *   - 项目：<cwd>/.pi/surfbird.json（仅项目受信任时读取/写入）
 * 合并顺序：项目 > 全局 > env > 默认（resolveConfig 再套 env/默认）。
 * 写盘 tmp+rename 原子替换，0600。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 与 pi 的 getAgentDir() 同款解析（PI_CODING_AGENT_DIR > ~/.pi/agent）。 */
export function agentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR
  if (envDir) {
    const v = envDir.trim()
    if (v) return v.startsWith('~') ? join(homedir(), v.slice(1)) : v
  }
  return join(homedir(), '.pi', 'agent')
}

export function globalConfigPath(): string {
  return join(agentDir(), 'surfbird.json')
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, '.pi', 'surfbird.json')
}

/** 读 JSON options；文件不存在/非法 JSON 返回 {}（非法不阻塞工具，设置页另报）。 */
export function readOptions(file: string): Record<string, unknown> {
  try {
    const text = readFileSync(file, 'utf8')
    const value: unknown = JSON.parse(text)
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  } catch { /* ENOENT / 非法 JSON 一律视为空 options */ }
  return {}
}

/** 合并 options：项目覆盖全局。值为 undefined 的键忽略。 */
export function loadOptions(cwd: string | undefined, trusted: boolean): Record<string, unknown> {
  const global = readOptions(globalConfigPath())
  if (!trusted || !cwd) return global
  return { ...global, ...readOptions(projectConfigPath(cwd)) }
}

/** 文件最后修改时间（设置页乐观并发用）；不存在返回 0。 */
export function fileMtime(file: string): number {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

export function configFileExists(file: string): boolean {
  try {
    return existsSync(file)
  } catch {
    return false
  }
}

/**
 * 把 patch 合并写回 options 文件：null 值删除该键（回落 env/默认）。
 * tmp+rename 原子写，0600；mtime 冲突（外部改动）抛错让设置页重读。
 */
export function writeOptions(file: string, patch: Record<string, unknown>, expectMtime?: number): void {
  if (expectMtime !== undefined && fileMtime(file) !== expectMtime) {
    throw new Error('config file changed externally — reopen settings')
  }
  const merged: Record<string, unknown> = { ...readOptions(file) }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key]
    else merged[key] = value
  }
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, file)
}
