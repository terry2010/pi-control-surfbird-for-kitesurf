/**
 * tokenFile 密文支持：surfbird-v1: 机器绑定加密格式。
 *
 * 文件内容以 `surfbird-v1:` 前缀开头时按密文处理：
 *   surfbird-v1:<base64(nonce[12] || tag[16] || AES-256-GCM ciphertext)>
 *
 * 密钥由本机 machine UUID 推导（scrypt），不落盘：
 *   key = scryptSync(`${platform}:${uuid}`, KDF_SALT, 32)
 * 换电脑/换 UUID → key 不同 → GCM auth tag 校验失败 → 解不开。
 *
 * 安全边界（如实）：
 *   - 防文件拷到别的机器 ✅；防本机其他用户 ❌（UUID 人人可读）；
 *     防同用户恶意进程 ❌。要更强请用系统凭据存储（见 README）。
 *   - OS 重装可能换 UUID（Windows MachineGuid / Linux machine-id）→ 旧密文解不开，需重新 encrypt。
 *
 * 无前缀的文件按明文 token 处理（向后兼容）。
 *
 * @module tokenfile
 */

import { execFileSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const TOKEN_FILE_PREFIX = 'surfbird-v1:'
const KDF_SALT = 'dsh-control-surfbird/tokenfile/v1'
const NONCE_LEN = 12
const TAG_LEN = 16

export interface MachineId {
  id: string
  source: string
}

export type TokenFileError = 'unreadable' | 'empty' | 'no_machine_id' | 'decrypt_failed'

export interface TokenFileRead {
  token?: string
  encrypted?: boolean
  error?: TokenFileError
}

let cachedMachineId: MachineId | null | undefined

function probeDarwin(): MachineId | undefined {
  try {
    const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    })
    const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)
    return m ? { id: m[1], source: 'IOPlatformUUID' } : undefined
  } catch { return undefined }
}

function probeWin32(): MachineId | undefined {
  try {
    const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    })
    const m = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(out)
    return m ? { id: m[1], source: 'MachineGuid' } : undefined
  } catch { return undefined }
}

function probeLinux(): MachineId | undefined {
  const candidates: Array<[string, string]> = [
    ['/etc/machine-id', 'machine-id'],
    ['/var/lib/dbus/machine-id', 'dbus-machine-id'],
    ['/sys/class/dmi/id/product_uuid', 'product_uuid'],
  ]
  for (const [path, source] of candidates) {
    try {
      const id = readFileSync(path, 'utf8').trim()
      // 全零/过短的 product_uuid 在 VM/容器里很常见，不能当唯一 ID
      if (id.length >= 8 && !/^0+$/.test(id)) return { id, source }
    } catch { /* try next */ }
  }
  return undefined
}

/** 本机唯一标识；进程内缓存（UUID 运行期不变）。平台不支持时返回 undefined。 */
export function machineId(): MachineId | undefined {
  if (cachedMachineId !== undefined) return cachedMachineId ?? undefined
  let m: MachineId | undefined
  if (process.platform === 'darwin') m = probeDarwin()
  else if (process.platform === 'win32') m = probeWin32()
  else if (process.platform === 'linux') m = probeLinux()
  cachedMachineId = m ?? null
  return m
}

const keyCache = new Map<string, Buffer>()

function deriveKey(machine: MachineId): Buffer {
  const ck = `${process.platform}:${machine.id}`
  let k = keyCache.get(ck)
  if (!k) {
    k = scryptSync(ck, KDF_SALT, 32)
    keyCache.set(ck, k)
  }
  return k
}

function resolveUuid(uuid?: string): MachineId | undefined {
  if (uuid) return { id: uuid, source: 'override' }
  return machineId()
}

/** token → `surfbird-v1:<base64>` 密文。uuid 参数仅供测试注入。 */
export function encryptToken(token: string, uuid?: string): string {
  const m = resolveUuid(uuid)
  if (!m) throw new Error(`cannot detect a machine id on platform ${process.platform}`)
  const nonce = randomBytes(NONCE_LEN)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(m), nonce)
  const ct = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  return TOKEN_FILE_PREFIX + Buffer.concat([nonce, cipher.getAuthTag(), ct]).toString('base64')
}

/** `surfbird-v1:` 密文 → token；任何失败（格式/key/认证）返回 undefined。 */
export function decryptToken(blob: string, uuid?: string): string | undefined {
  const s = blob.trim()
  if (!s.startsWith(TOKEN_FILE_PREFIX)) return undefined
  const m = resolveUuid(uuid)
  if (!m) return undefined
  try {
    const raw = Buffer.from(s.slice(TOKEN_FILE_PREFIX.length), 'base64')
    if (raw.length <= NONCE_LEN + TAG_LEN) return undefined
    const nonce = raw.subarray(0, NONCE_LEN)
    const tag = raw.subarray(NONCE_LEN, NONCE_LEN + TAG_LEN)
    const ct = raw.subarray(NONCE_LEN + TAG_LEN)
    const d = createDecipheriv('aes-256-gcm', deriveKey(m), nonce)
    d.setAuthTag(tag)
    const token = Buffer.concat([d.update(ct), d.final()]).toString('utf8')
    return token || undefined
  } catch {
    return undefined
  }
}

export function isEncryptedBlob(s: string): boolean {
  return s.trimStart().startsWith(TOKEN_FILE_PREFIX)
}

/**
 * 读 tokenFile：明文直通；`surfbird-v1:` 前缀走机器绑定解密。
 * 加密文件解密失败时返回 error（调用方决定是否回退到其他 token 源）。
 */
export function readTokenFile(path: string | undefined): TokenFileRead {
  if (!path) return {}
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { error: 'unreadable' }
  }
  const t = raw.trim()
  if (!t) return { error: 'empty' }
  if (!isEncryptedBlob(t)) return { token: t, encrypted: false }
  if (!machineId()) return { encrypted: true, error: 'no_machine_id' }
  const token = decryptToken(t)
  if (token === undefined) return { encrypted: true, error: 'decrypt_failed' }
  return { token, encrypted: true }
}
