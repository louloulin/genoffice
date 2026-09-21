/**
 * S3-compatible {@link StorageBackend}.
 *
 * Three backends share this implementation because rustfs and MinIO are both
 * wire-compatible with AWS S3 — the only thing that changes between
 * `s3` / `rustfs` / `minio` is the default endpoint, the default addressing
 * style, and the env-var prefix operators use to configure them. The factory
 * picks this class for all three ids and applies a small set of defaults
 * keyed on `backend.id`; everything operator-configurable wins over the
 * defaults.
 *
 * The package depends on `@aws-sdk/client-s3` and
 * `@aws-sdk/s3-request-presigner` rather than the bare SigV4 spec because
 *   - the AWS SDK already handles path-style addressing for rustfs/MinIO,
 *   - it already handles SigV4 streaming uploads and multipart,
 *   - we already depend on a slice of `@aws-sdk/*` transitively for Bedrock.
 *
 * The implementation intentionally does not call any AWS-only APIs
 * (`BucketLifecycleConfiguration`, `AccessControlPolicy`, etc.) so it stays
 * portable against rustfs and MinIO.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import {
  StorageNotFoundError,
  type HeadResult,
  type ListEntry,
  type PutOptions,
  type SignedUrlOptions,
  type StorageBackend,
  type StorageBackendConfig,
} from './backend'

type S3Kind = 's3' | 'rustfs' | 'minio'

interface ResolvedS3Config {
  endpoint?: string
  region: string
  bucket: string
  accessKeyId?: string
  secretAccessKey?: string
  forcePathStyle: boolean
  timeoutMs: number
}

function kindFromBackend(b: StorageBackendConfig['backend']): S3Kind {
  return b === 'rustfs' ? 'rustfs' : b === 'minio' ? 'minio' : 's3'
}

function defaultEndpoint(kind: S3Kind): string | undefined {
  /* rustfs and minio both default to a locally-running, unsigned HTTP server
   * on port 9000 with path-style addressing. Pure AWS S3 has no useful
   * default endpoint — the SDK derives one from the region. */
  return kind === 's3' ? undefined : 'http://127.0.0.1:9000'
}

function defaultAccessKeyEnvPrefix(kind: S3Kind): { key: string; secret: string } {
  /* rustfs and minio historically expect the same env-var names as the AWS
   * CLI when pointing at themselves, but to keep the configuration self-
   * documenting we use MINIO_* for minio. */
  if (kind === 'minio') return { key: 'MINIO_ACCESS_KEY', secret: 'MINIO_SECRET_KEY' }
  if (kind === 'rustfs') return { key: 'RUSTFS_ACCESS_KEY_ID', secret: 'RUSTFS_SECRET_ACCESS_KEY' }
  return { key: 'S3_ACCESS_KEY_ID', secret: 'S3_SECRET_ACCESS_KEY' }
}

function resolveS3Config(raw: StorageBackendConfig): ResolvedS3Config {
  const kind = kindFromBackend(raw.backend)
  const s = raw.s3
  const r = raw.rustfs
  const m = raw.minio
  const isSelfHosted = kind !== 's3'
  /* The factory populates the matching config block (`minio` / `rustfs` /
   * `s3`), but we accept any of the three here so the same code path works
   * whether the operator passed the config inline or set it via env. */
  const merged: ResolvedS3Config = {
    endpoint:
      m?.endpoint ?? r?.endpoint ?? s?.endpoint ??
      process.env[`${kind === 'minio' ? 'MINIO' : kind === 'rustfs' ? 'RUSTFS' : 'S3'}_ENDPOINT`] ??
      defaultEndpoint(kind),
    region:
      m?.region ?? r?.region ?? s?.region ??
      process.env[`${kind === 'minio' ? 'MINIO' : kind === 'rustfs' ? 'RUSTFS' : 'S3'}_REGION`] ??
      'us-east-1',
    bucket:
      m?.bucket ?? r?.bucket ?? s?.bucket ??
      process.env[`${kind === 'minio' ? 'MINIO' : kind === 'rustfs' ? 'RUSTFS' : 'S3'}_BUCKET`] ??
      'genoffice',
    accessKeyId:
      m?.accessKeyId ?? r?.accessKeyId ?? s?.accessKeyId ??
      process.env[defaultAccessKeyEnvPrefix(kind).key],
    secretAccessKey:
      m?.secretAccessKey ?? r?.secretAccessKey ?? s?.secretAccessKey ??
      process.env[defaultAccessKeyEnvPrefix(kind).secret],
    forcePathStyle:
      m?.forcePathStyle ?? r?.forcePathStyle ?? s?.forcePathStyle ?? isSelfHosted,
    timeoutMs:
      m?.timeoutMs ?? r?.timeoutMs ?? s?.timeoutMs ?? 30_000,
  }
  if (!merged.bucket) {
    throw new Error(
      `S3StorageBackend (${kind}): bucket is required ` +
        `(set ${kind === 'minio' ? 'MINIO_BUCKET' : kind === 'rustfs' ? 'RUSTFS_BUCKET' : 'S3_BUCKET'} or pass it via config)`,
    )
  }
  if (!merged.accessKeyId || !merged.secretAccessKey) {
    const envNames = defaultAccessKeyEnvPrefix(kind)
    throw new Error(
      `S3StorageBackend (${kind}): accessKeyId and secretAccessKey are required ` +
        `(set ${envNames.key}/${envNames.secret})`,
    )
  }
  return merged as ResolvedS3Config
}

function notFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const anyErr = err as { name?: string; $metadata?: { httpStatusCode?: number } }
  return anyErr.name === 'NoSuchKey' || anyErr.name === 'NotFound' || anyErr.$metadata?.httpStatusCode === 404
}

export class S3StorageBackend implements StorageBackend {
  readonly id: S3Kind
  private readonly cfg: ResolvedS3Config
  private readonly client: S3Client
  private readonly kindLabel: string

  constructor(config: StorageBackendConfig) {
    this.id = kindFromBackend(config.backend)
    this.kindLabel = this.id
    this.cfg = resolveS3Config(config)
    const clientConfig: S3ClientConfig = {
      region: this.cfg.region,
      forcePathStyle: this.cfg.forcePathStyle,
      credentials: {
        accessKeyId: this.cfg.accessKeyId!,
        secretAccessKey: this.cfg.secretAccessKey!,
      },
      requestHandler: { requestTimeout: this.cfg.timeoutMs } as S3ClientConfig['requestHandler'],
    }
    if (this.cfg.endpoint) clientConfig.endpoint = this.cfg.endpoint
    this.client = new S3Client(clientConfig)
  }

  async exists(key: string): Promise<boolean> {
    const res = await this.head(key)
    return res.exists
  }

  async get(key: string): Promise<Uint8Array> {
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
      )
      const body = out.Body
      if (!body) throw new StorageNotFoundError(this.id, key)
      const chunks: Uint8Array[] = []
      const reader = body.transformToWebStream().getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
      }
      let total = 0
      for (const c of chunks) total += c.byteLength
      const merged = new Uint8Array(total)
      let off = 0
      for (const c of chunks) { merged.set(c, off); off += c.byteLength }
      return merged
    } catch (err) {
      if (notFound(err)) throw new StorageNotFoundError(this.id, key)
      throw err
    }
  }

  async head(key: string): Promise<HeadResult> {
    try {
      const out = await this.client.send(
        new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
      )
      return {
        exists: true,
        size: Number(out.ContentLength ?? 0),
        contentType: out.ContentType ?? undefined,
        modifiedAt: out.LastModified ? new Date(out.LastModified).toISOString() : undefined,
        meta: out.Metadata,
      }
    } catch (err) {
      if (notFound(err)) return { exists: false, size: 0 }
      throw err
    }
  }

  async put(
    key: string,
    bytes: Uint8Array,
    opts: PutOptions = {},
  ): Promise<{ key: string; size: number }> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        Body: bytes,
        ContentType: opts.contentType,
        Metadata: opts.meta,
      }),
    )
    return { key, size: bytes.byteLength }
  }

  async delete(key: string): Promise<void> {
    /* S3 DELETE is idempotent: a missing key is a successful no-op. */
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
    )
  }

  async list(prefix = ''): Promise<ListEntry[]> {
    const out = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.cfg.bucket,
        Prefix: prefix || undefined,
        MaxKeys: 1000,
      }),
    )
    const contents = out.Contents ?? []
    return contents
      .filter((c): c is { Key: string; Size: number; LastModified?: Date } => typeof c.Key === 'string' && typeof c.Size === 'number')
      .map((c) => ({
        key: c.Key,
        size: c.Size,
        modifiedAt: c.LastModified ? new Date(c.LastModified).toISOString() : undefined,
      }))
  }

  async getSignedUrl(key: string, opts: SignedUrlOptions = {}): Promise<string> {
    const expiresIn = opts.expiresInSeconds ?? 3600
    const cmd = new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key })
    return await getSignedUrl(this.client, cmd, { expiresIn })
  }
}
