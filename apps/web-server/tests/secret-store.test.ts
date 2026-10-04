import { describe, expect, it } from 'vitest'
import {
  decryptSecret,
  encryptSecret,
  ENCRYPTED_PLACEHOLDER,
  isEncryptedSecret,
  isRedactedMarker,
  MASTER_KEY_ENV,
  PREVIOUS_KEY_ENV,
  redactSecret,
  resetMasterKeyCache,
} from '../src/common/secret-store'

const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)
const PASSPHRASE = 'correct horse battery staple'

const originalEnv: Record<string, string | undefined> = {}
function envSnapshot(name: string): string | undefined {
  if (!(name in originalEnv)) originalEnv[name] = process.env[name]
  return originalEnv[name]
}
function withEnv(entries: Record<string, string | undefined>, fn: () => void): void {
  for (const [k, v] of Object.entries(entries)) envSnapshot(k)
  const touched = Object.keys(entries)
  try {
    for (const k of touched) {
      const v = entries[k]
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    resetMasterKeyCache()
    fn()
  } finally {
    for (const k of touched) {
      const v = originalEnv[k]
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    resetMasterKeyCache()
  }
}

describe('secret-store round-trip', () => {
  it('encrypts and decrypts with a hex master key', () => {
    withEnv({ [MASTER_KEY_ENV]: KEY_A }, () => {
      const envelope = encryptSecret('sk-live-1234567890abcdef')
      expect(isEncryptedSecret(envelope)).toBe(true)
      expect(envelope).toMatch(/^v1:[0-9a-f]{8}:/)
      expect(envelope).not.toContain('sk-live')
      expect(decryptSecret(envelope)).toBe('sk-live-1234567890abcdef')
    })
  })

  it('derives a usable key from a non-hex passphrase too', () => {
    withEnv({ [MASTER_KEY_ENV]: PASSPHRASE }, () => {
      const envelope = encryptSecret('secret-value')
      expect(decryptSecret(envelope)).toBe('secret-value')
    })
  })

  it('produces a fresh IV per call (same plaintext → different envelopes)', () => {
    withEnv({ [MASTER_KEY_ENV]: KEY_A }, () => {
      expect(encryptSecret('same')).not.toBe(encryptSecret('same'))
    })
  })

  it('decrypts an envelope written under a previous key during rotation', () => {
    let oldEnvelope = ''
    withEnv({ [MASTER_KEY_ENV]: KEY_A }, () => {
      oldEnvelope = encryptSecret('rotate-me')
    })
    withEnv({ [MASTER_KEY_ENV]: KEY_B, [PREVIOUS_KEY_ENV]: KEY_A }, () => {
      expect(decryptSecret(oldEnvelope)).toBe('rotate-me')
      // new writes use the current key, not the previous one
      const fresh = encryptSecret('new-write')
      expect(fresh.split(':')[1]).not.toBe(oldEnvelope.split(':')[1])
    })
  })
})

describe('secret-store fail-closed', () => {
  it('refuses to encrypt without a master key', () => {
    withEnv({ [MASTER_KEY_ENV]: undefined }, () => {
      expect(() => encryptSecret('x')).toThrow(MASTER_KEY_ENV)
    })
  })

  it('refuses to decrypt an envelope when no key is configured', () => {
    let envelope = ''
    withEnv({ [MASTER_KEY_ENV]: KEY_A }, () => {
      envelope = encryptSecret('protected')
    })
    withEnv({ [MASTER_KEY_ENV]: undefined }, () => {
      expect(() => decryptSecret(envelope)).toThrow(/no matching master key/)
    })
  })

  it('refuses an envelope encrypted under an unknown key', () => {
    let envelope = ''
    withEnv({ [MASTER_KEY_ENV]: KEY_A }, () => {
      envelope = encryptSecret('protected')
    })
    withEnv({ [MASTER_KEY_ENV]: KEY_B }, () => {
      expect(() => decryptSecret(envelope)).toThrow(/key [0-9a-f]{8}/)
    })
  })

  it('refuses a tampered ciphertext (GCM auth)', () => {
    withEnv({ [MASTER_KEY_ENV]: KEY_A }, () => {
      const envelope = encryptSecret('protected')
      const parts = envelope.split(':')
      const data = Buffer.from(parts[3]!, 'base64')
      data[0] = data[0]! ^ 0xff
      parts[3] = data.toString('base64')
      expect(() => decryptSecret(parts.join(':'))).toThrow(/authentication/)
    })
  })

  it('rejects a malformed envelope', () => {
    expect(() => decryptSecret('plaintext-value')).toThrow(/envelope format/)
    expect(() => decryptSecret('v1:only:three')).toThrow(/envelope format/)
  })
})

describe('redaction', () => {
  it('redacts a long key keeping a recognizable head/tail', () => {
    expect(redactSecret('sk-proj-abcdefgh1234')).toBe('sk-***1234')
  })

  it('collapses short values to a bare marker', () => {
    expect(redactSecret('short')).toBe('***')
    expect(redactSecret('')).toBe('')
    expect(redactSecret(undefined)).toBeUndefined()
  })

  it('marks encrypted envelopes as unavailable rather than leaking them', () => {
    withEnv({ [MASTER_KEY_ENV]: KEY_A }, () => {
      const envelope = encryptSecret('sk-hidden')
      expect(redactSecret(envelope)).toBe(ENCRYPTED_PLACEHOLDER)
      expect(redactSecret(envelope)).not.toContain('v1:')
    })
  })

  it('detects redaction markers for the set-settings round-trip', () => {
    expect(isRedactedMarker('sk-***1234')).toBe(true)
    expect(isRedactedMarker(ENCRYPTED_PLACEHOLDER)).toBe(true)
    expect(isRedactedMarker('sk-real-key-without-markers')).toBe(false)
    expect(isRedactedMarker('')).toBe(false)
    expect(isRedactedMarker(undefined)).toBe(false)
  })
})
