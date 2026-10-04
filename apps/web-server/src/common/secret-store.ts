import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/**
 * AES-256-GCM envelope encryption for secrets at rest (A36).
 *
 * Ciphertext format: `v1:<keyId>:<iv-b64>:<ciphertext-b64>:<tag-b64>`
 *   - keyId lets multiple master keys coexist (rotation); it is the first
 *     8 hex chars of sha256(key material), so a stored record names the key
 *     that encrypted it without leaking key material.
 *   - The master key comes from GENOFFICE_MASTER_KEY: 64 hex chars (raw
 *     32 bytes) or any other passphrase (stretched through a domain-separated
 *     sha256 KDF — the key material is itself deployment-secret, so a constant
 *     salt is acceptable). A previous key can be supplied via
 *     GENOFFICE_MASTER_KEY_PREVIOUS so records written under it still decrypt
 *     while new writes use the current key.
 *
 * Fail-closed rules (A37):
 *   - Encrypted data present but no master key configured → decrypt refuses
 *     with a clear error; there is no silent plaintext fallback.
 *   - A record's keyId matches neither the current nor the previous key → refuse.
 */

const VERSION = 'v1'
export const MASTER_KEY_ENV = 'GENOFFICE_MASTER_KEY'
export const PREVIOUS_KEY_ENV = 'GENOFFICE_MASTER_KEY_PREVIOUS'

export interface LoadedMasterKey {
  keyId: string
  key: Buffer
}

interface KeyCache {
  current?: LoadedMasterKey
  previous?: LoadedMasterKey
}

const cache: KeyCache = {}

function keyIdFor(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8)
}

function deriveKey(material: string): LoadedMasterKey {
  let key: Buffer
  if (/^[0-9a-fA-F]{64}$/.test(material)) {
    key = Buffer.from(material, 'hex')
  } else {
    // Non-hex passphrases are domain-separated and stretched; the salt is a
    // constant because the key material itself is already deployment-secret.
    key = Buffer.from(createHash('sha256').update(`genoffice:master-key:${material}`).digest())
  }
  return { key, keyId: keyIdFor(key) }
}

function loadFromEnv(name: string): LoadedMasterKey | undefined {
  const raw = process.env[name]?.trim()
  if (!raw) return undefined
  return deriveKey(raw)
}

/** Current master key, or undefined when none is configured. Memoized per process. */
export function getMasterKey(): LoadedMasterKey | undefined {
  if (!cache.current) cache.current = loadFromEnv(MASTER_KEY_ENV)
  return cache.current
}

/** Previous-generation key for rotation, or undefined. */
export function getPreviousMasterKey(): LoadedMasterKey | undefined {
  if (cache.previous === undefined) cache.previous = loadFromEnv(PREVIOUS_KEY_ENV)
  return cache.previous
}

/** Test seam: drop memoized keys (call after mutating process.env). */
export function resetMasterKeyCache(): void {
  cache.current = undefined
  cache.previous = undefined
}

/** True when the string is a secret-store envelope (as opposed to legacy plaintext). */
export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(`${VERSION}:`)
}

export function encryptSecret(plaintext: string): string {
  const master = getMasterKey()
  if (!master) {
    throw new Error(
      `${MASTER_KEY_ENV} is not configured: cannot encrypt secrets. Set it to a 64-char hex key (or a passphrase) before storing API keys.`,
    )
  }
  return encryptWithKey(master, plaintext)
}

function encryptWithKey(master: LoadedMasterKey, plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', master.key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, master.keyId, iv.toString('base64'), ciphertext.toString('base64'), tag.toString('base64')].join(':')
}

/** Decrypt an envelope written by encryptSecret. Throws on any mismatch (fail-closed). */
export function decryptSecret(envelope: string): string {
  const parts = envelope.split(':')
  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new Error(`Unrecognized secret envelope format (expected ${VERSION}:<keyId>:...)`)
  }
  const [, keyId, ivB64, dataB64, tagB64] = parts as [string, string, string, string, string]
  const candidate = [getMasterKey(), getPreviousMasterKey()].find((k) => k && k.keyId === keyId)
  if (!candidate) {
    throw new Error(
      `Secret was encrypted with key ${keyId} but no matching master key is configured (${MASTER_KEY_ENV}${getPreviousMasterKey() ? ` or ${PREVIOUS_KEY_ENV}` : ''}). Restore the original key or re-enter the API keys.`,
    )
  }
  let iv: Buffer
  let data: Buffer
  let tag: Buffer
  try {
    iv = Buffer.from(ivB64, 'base64')
    data = Buffer.from(dataB64, 'base64')
    tag = Buffer.from(tagB64, 'base64')
  } catch {
    throw new Error('Secret envelope contains malformed base64')
  }
  const decipher = createDecipheriv('aes-256-gcm', candidate.key, iv)
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  } catch {
    throw new Error(`Secret envelope failed authentication (key ${keyId})`)
  }
}

/** `sk-abcd...wxyz` → `sk-***wxyz`-style display form; non-secrets pass through unchanged. */
export function redactSecret(value: string | undefined): string | undefined {
  if (!value) return value
  if (isEncryptedSecret(value)) return ENCRYPTED_PLACEHOLDER
  if (value.length <= 8) return '***'
  return `${value.slice(0, 3)}***${value.slice(-4)}`
}

/** Marker stored in place of a real key when an API returns redacted values. */
export const ENCRYPTED_PLACEHOLDER = '***'

/** True when a settings value is a redaction marker (caller re-sent what it got from a read API). */
export function isRedactedMarker(value: string | undefined): boolean {
  if (!value) return false
  return value.includes('***')
}
