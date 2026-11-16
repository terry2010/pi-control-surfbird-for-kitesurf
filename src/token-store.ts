/**
 * src/token-store.ts — token 内容 → tokenFile 落盘（GUI main 与 TUI 设置页共用）。
 *
 * 明文用本机 UUID 加密为 surfbird-v1: 密文；无 machine-id 时明文 0600 兜底
 * 并如实返回 encrypted:false（UI 据此提示）。已是密文的内容原样写入。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { encryptToken, isEncryptedBlob } from './tokenfile.ts'

export function storeToken(content: string, target: string): { path: string; encrypted: boolean } {
  const trimmed = content.trim()
  if (!trimmed) throw new Error('empty token')
  if (trimmed.length > 64 * 1024) throw new Error('token too large')
  mkdirSync(path.dirname(target), { recursive: true })
  if (isEncryptedBlob(trimmed)) {
    writeFileSync(target, trimmed + '\n', { mode: 0o600 })
    return { path: target, encrypted: true }
  }
  try {
    writeFileSync(target, encryptToken(trimmed) + '\n', { mode: 0o600 })
    return { path: target, encrypted: true }
  } catch {
    // 本机无 machine id → 明文落盘（0600），如实返回 encrypted:false
    writeFileSync(target, trimmed + '\n', { mode: 0o600 })
    return { path: target, encrypted: false }
  }
}
