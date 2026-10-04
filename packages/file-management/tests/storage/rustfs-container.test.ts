/**
 * RustFS container round-trip (A24 / A71).
 *
 * `s3.test.ts` and `rustfs-live.test.ts` drive the backend against an
 * in-process HTTP stub. That proves the wire shape, but a stub is written by
 * the same person who wrote the client, so it cannot catch a shared
 * misunderstanding of the S3 protocol (signature v4, path-style addressing,
 * chunked uploads, XML list parsing). This suite boots the real RustFS server
 * in a container and drives upload → download → delete through it, which is
 * what the acceptance item asks for.
 *
 * The suite skips when Docker is unavailable, and fails loudly (with the
 * container log) when Docker is present but RustFS never comes up — a silent
 * skip there would make the acceptance claim vacuous.
 *
 * Override the image with `GENOFFICE_RUSTFS_IMAGE`. Without it the suite walks
 * a candidate list (ghcr.io first, then Docker Hub) and uses the first image
 * it finds locally or can pull, because a rate-limited or geo-restricted
 * registry is an environment problem, not a backend one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3'
import { S3StorageBackend } from '../../src/storage/s3'
import { StorageNotFoundError } from '../../src/storage/backend'

const execFileAsync = promisify(execFile)

const IMAGE_CANDIDATES = process.env.GENOFFICE_RUSTFS_IMAGE?.trim()
  ? [process.env.GENOFFICE_RUSTFS_IMAGE.trim()]
  : ['ghcr.io/rustfs/rustfs:latest', 'rustfs/rustfs:latest']
const ACCESS_KEY = 'genoffice-container'
const SECRET_KEY = 'genoffice-container-secret'
const BUCKET = 'genoffice-container-test'

interface DockerResult {
  stdout: string
  stderr: string
}

function docker(args: string[], timeoutMs = 120_000): Promise<DockerResult> {
  return execFileAsync('docker', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 })
}

function failureLine(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr
  const message = stderr?.trim() || (error as Error)?.message || String(error)
  return message.split('\n').filter(Boolean).slice(-1)[0] ?? 'unknown error'
}

/** Locally present, or pullable from one of the candidate registries. */
async function resolveImage(): Promise<string> {
  for (const image of IMAGE_CANDIDATES) {
    try {
      await docker(['image', 'inspect', image], 20_000)
      return image
    } catch {
      /* not cached — try the next */
    }
  }
  const failures: string[] = []
  for (const image of IMAGE_CANDIDATES) {
    try {
      await docker(['pull', image], 900_000)
      return image
    } catch (error) {
      failures.push(`  ${image} — ${failureLine(error)}`)
    }
  }
  throw new Error(`no RustFS image available for the container test:\n${failures.join('\n')}`)
}

/* Probed synchronously so `describe.skipIf` can see the answer at collection
 * time; `docker version` fails fast (ENOENT / connection refused) on a machine
 * with no CLI or no running daemon. */
const dockerUsable = (() => {
  const probe = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    timeout: 20_000,
    encoding: 'utf8',
  })
  return probe.status === 0
})()

let containerName = ''
let endpoint = ''
let image = ''

async function waitForHealth(container: string, url: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`)
      if (res.ok) return
    } catch {
      /* RustFS is still starting */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  const logs = await docker(['logs', '--tail', '40', container]).catch(() => ({
    stdout: '',
    stderr: '',
  }))
  throw new Error(`RustFS never became healthy at ${url}\n${logs.stdout}${logs.stderr}`)
}

function backend(): S3StorageBackend {
  return new S3StorageBackend({
    filesDir: '/unused',
    backend: 'rustfs',
    rustfs: {
      endpoint,
      bucket: BUCKET,
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
    },
  })
}

describe.skipIf(!dockerUsable)('RustFS container round-trip (A24 / A71)', () => {
  beforeAll(async () => {
    image = await resolveImage()
    containerName = `genoffice-rustfs-${process.pid}-${Date.now().toString(36)}`
    await docker(
      [
        'run',
        '-d',
        '--rm',
        '--name',
        containerName,
        '-p',
        '127.0.0.1::9000',
        '-e',
        `RUSTFS_ACCESS_KEY=${ACCESS_KEY}`,
        '-e',
        `RUSTFS_SECRET_KEY=${SECRET_KEY}`,
        image,
      ],
      120_000,
    )

    const { stdout } = await docker(['port', containerName, '9000'])
    const published = /127\.0\.0\.1:(\d+)/.exec(stdout)
    if (!published) {
      throw new Error(`could not read RustFS's published port from "docker port": ${stdout.trim()}`)
    }
    endpoint = `http://127.0.0.1:${published[1]}`
    await waitForHealth(containerName, endpoint)

    const client = new S3Client({
      region: 'us-east-1',
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
    })
    try {
      await client.send(new CreateBucketCommand({ Bucket: BUCKET }))
    } finally {
      client.destroy()
    }
  }, 900_000)

  afterAll(async () => {
    if (containerName) await docker(['rm', '-f', containerName], 60_000).catch(() => {})
  })

  it('uploads, downloads and deletes an object through the real server', async () => {
    const store = backend()
    expect(store.id).toBe('rustfs')

    const bytes = new TextEncoder().encode(`genoffice rustfs roundtrip ${Date.now()}`)
    const { key, size } = await store.put('roundtrip/greeting.txt', bytes, {
      contentType: 'text/plain',
    })
    expect(key).toBe('roundtrip/greeting.txt')
    expect(size).toBe(bytes.byteLength)

    const downloaded = await store.get(key)
    expect(new TextDecoder().decode(downloaded)).toBe(new TextDecoder().decode(bytes))

    const head = await store.head(key)
    expect(head.exists).toBe(true)
    expect(head.size).toBe(bytes.byteLength)
    expect(head.contentType).toBe('text/plain')
    expect(await store.exists(key)).toBe(true)

    const listed = await store.list('roundtrip/')
    expect(listed.map((entry) => entry.key)).toContain(key)

    await store.delete(key)
    expect(await store.exists(key)).toBe(false)
    expect((await store.list('roundtrip/')).map((entry) => entry.key)).not.toContain(key)

    // Deleting a gone object is a no-op, not an error.
    await expect(store.delete(key)).resolves.toBeUndefined()

    const signed = await store.getSignedUrl(key, { expiresInSeconds: 60 })
    expect(signed).toContain(BUCKET)
    expect(signed).toMatch(/X-Amz-Signature=/)
  }, 60_000)

  it('reports a missing object as not-found without throwing from head()', async () => {
    const store = backend()
    expect((await store.head('roundtrip/never-written.txt')).exists).toBe(false)
    await expect(store.get('roundtrip/never-written.txt')).rejects.toBeInstanceOf(
      StorageNotFoundError,
    )
  }, 60_000)
})
