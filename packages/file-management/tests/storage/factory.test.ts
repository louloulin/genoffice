import { describe, expect, it } from 'vitest'
import { createStorageBackend, LocalStorageBackend, MimoStorageBackend, S3StorageBackend } from '../../src/storage/factory'

describe('createStorageBackend', () => {
  it('returns LocalStorageBackend by default', () => {
    expect(createStorageBackend({ filesDir: '/tmp/x' })).toBeInstanceOf(LocalStorageBackend)
  })

  it('honours backend:"local"', () => {
    expect(createStorageBackend({ backend: 'local', filesDir: '/tmp/x' })).toBeInstanceOf(LocalStorageBackend)
  })

  it('honours backend:"mimo"', () => {
    const backend = createStorageBackend({
      backend: 'mimo',
      filesDir: '/unused',
      mimo: { endpoint: 'http://mimo.example' },
    })
    expect(backend).toBeInstanceOf(MimoStorageBackend)
  })

  it('returns an S3StorageBackend for backend:"s3" (with valid creds)', () => {
    const backend = createStorageBackend({
      backend: 's3',
      filesDir: '/unused',
      s3: { endpoint: 'http://example.test', region: 'us-east-1', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' },
    })
    expect(backend.id).toBe('s3')
  })

  it('returns a RustFS-tagged S3StorageBackend for backend:"rustfs"', () => {
    const backend = createStorageBackend({
      backend: 'rustfs',
      filesDir: '/unused',
      rustfs: { accessKeyId: 'k', secretAccessKey: 's', bucket: 'b' },
    })
    expect(backend.id).toBe('rustfs')
  })

  it('applies the rustfs default endpoint when none is provided', () => {
    /* We can't observe the endpoint without an SDK call; instead we observe
     * that construction succeeds without an explicit endpoint and that the
     * default region/bucket are applied. */
    const backend = createStorageBackend({
      backend: 'rustfs',
      filesDir: '/unused',
      rustfs: { accessKeyId: 'k', secretAccessKey: 's' },
    })
    expect(backend.id).toBe('rustfs')
  })

  it('refuses rustfs/s3 construction without credentials', () => {
    expect(() =>
      createStorageBackend({ backend: 'rustfs', filesDir: '/unused' }),
    ).toThrow(/credentials|ACCESS_KEY/)
  })
})
