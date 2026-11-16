// tokenfile 机器绑定加密 — unit tests, no engine needed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TOKEN_FILE_PREFIX,
  decryptToken,
  encryptToken,
  isEncryptedBlob,
  machineId,
  readTokenFile,
} from '../../src/tokenfile.ts'
import { resolveConfig } from '../../src/config.ts'

const UUID_A = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const UUID_B = '11111111-2222-3333-4444-555555555555'

// ---------- encrypt/decrypt roundtrip ----------

test('encryptToken/decryptToken: roundtrip with explicit uuid', () => {
  const blob = encryptToken('your-token', UUID_A)
  assert.ok(blob.startsWith(TOKEN_FILE_PREFIX))
  assert.equal(decryptToken(blob, UUID_A), 'your-token')
})

test('decryptToken: wrong machine uuid fails (GCM auth)', () => {
  const blob = encryptToken('secret-token', UUID_A)
  assert.equal(decryptToken(blob, UUID_B), undefined)
})

test('decryptToken: tampered ciphertext fails', () => {
  const blob = encryptToken('secret-token', UUID_A)
  const raw = Buffer.from(blob.slice(TOKEN_FILE_PREFIX.length), 'base64')
  raw[raw.length - 1] ^= 0xff // flip last ciphertext byte
  const tampered = TOKEN_FILE_PREFIX + raw.toString('base64')
  assert.equal(decryptToken(tampered, UUID_A), undefined)
})

test('decryptToken: non-prefixed input returns undefined', () => {
  assert.equal(decryptToken('plaintext-token', UUID_A), undefined)
  assert.equal(decryptToken('surfbird-v1:not-valid-base64!!!', UUID_A), undefined)
})

test('encryptToken: random nonce → different blobs for same token', () => {
  const a = encryptToken('same', UUID_A)
  const b = encryptToken('same', UUID_A)
  assert.notEqual(a, b)
  assert.equal(decryptToken(a, UUID_A), 'same')
  assert.equal(decryptToken(b, UUID_A), 'same')
})

// ---------- isEncryptedBlob ----------

test('isEncryptedBlob: prefix detection tolerant of whitespace', () => {
  assert.equal(isEncryptedBlob(TOKEN_FILE_PREFIX + 'abc'), true)
  assert.equal(isEncryptedBlob('  ' + TOKEN_FILE_PREFIX + 'abc'), true)
  assert.equal(isEncryptedBlob('plain-token'), false)
})

// ---------- readTokenFile ----------

test('readTokenFile: plaintext passthrough', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-tf-'))
  try {
    const f = join(dir, 'tok')
    writeFileSync(f, '  my-plain-token\n')
    const r = readTokenFile(f)
    assert.equal(r.token, 'my-plain-token')
    assert.equal(r.encrypted, false)
    assert.equal(r.error, undefined)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('readTokenFile: missing/empty file errors', () => {
  assert.deepEqual(readTokenFile('/nonexistent/path'), { error: 'unreadable' })
  const dir = mkdtempSync(join(tmpdir(), 'sf-tf-'))
  try {
    const f = join(dir, 'empty')
    writeFileSync(f, '   \n')
    assert.deepEqual(readTokenFile(f), { error: 'empty' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('readTokenFile: encrypted file roundtrip on this machine', { skip: !machineId() && 'no machine id on this platform' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-tf-'))
  try {
    const f = join(dir, 'tok.enc')
    writeFileSync(f, encryptToken('enc-token-123'))
    const r = readTokenFile(f)
    assert.equal(r.token, 'enc-token-123')
    assert.equal(r.encrypted, true)
    assert.equal(r.error, undefined)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---------- resolveConfig integration ----------

test('resolveConfig: encrypted tokenFile resolves token + reports encrypted', { skip: !machineId() && 'no machine id on this platform' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-tf-'))
  try {
    const f = join(dir, 'tok.enc')
    writeFileSync(f, encryptToken('file-wins'))
    const c = resolveConfig({ tokenFile: f, token: 'cfg-loses' })
    assert.equal(c.token, 'file-wins')
    assert.equal(c.tokenFileEncrypted, true)
    assert.equal(c.tokenFileError, undefined)
    assert.equal(c.configSource, 'default+tokenFile')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('resolveConfig: undecryptable tokenFile falls back + reports error', { skip: !machineId() && 'no machine id on this platform' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-tf-'))
  try {
    const f = join(dir, 'tok.enc')
    // 用一个假 UUID 加密 → 本机解不开（模拟换电脑后的文件）
    writeFileSync(f, encryptToken('other-machine-token', UUID_B))
    const c = resolveConfig({ tokenFile: f, token: 'cfg-fallback' })
    assert.equal(c.token, 'cfg-fallback') // 回退到 config token
    assert.equal(c.tokenFileEncrypted, true)
    assert.equal(c.tokenFileError, 'decrypt_failed')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
