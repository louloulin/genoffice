/**
 * S3-compatible {@link StorageBackend}.
 *
 * Two backends share this implementation because rustfs is wire-compatible
 * with S3 (https://github.com/rustfs/rustfs) and minio is too — the only
 * thing that changes between `s3` and `rustfs` is the default endpoint and a
 * few opinionated settings. The factory picks this class for both ids and
 * applies a small set of defaults keyed on `backend.id`; everything operator-
 * configurable wins over the defaults.
 *
 * The package depends on `@aws-sdk/client-s3` and
 * `@aws-sdk/s3-request-presigner` rather than the bare SigV4 spec because
 *   - the AWS SDK already handles path-style addressing for rustfs/minio,
 *   - it already handles SigV4 streaming uploads and multipart,
 *   - we already depend on a slice of `@aws-sdk/*` transitively for Bedrock.
 *
 * The implementation intentionally does not call any AWS-only APIs
 * (`BucketLifecycleConfiguration`, `AccessControlPolicy`, etc.) so it stays
 * portable against rustfs.
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

interface ResolvedS3Config {
  endpoint?: string
  region: string
  bucket: string
  accessKeyId?: string
  secretAccessKey?: string
  forcePathStyle: boolean
  timeoutMs: number
}

function resolveS3Config(raw: StorageBackendConfig & { s3?: Partial<ResolvedS3Config>; rustfs?: Partial<ResolvedS3Config> }): ResolvedS3Config {
  /* `raw.s3` and `raw.rustfs` are both accepted — the factory already
   * populates the right one based on the requested id, but we accept both
   * keys so an operator can pass either through `process.env` indirection. */
  const isRust = raw.backend === 'rustfs'
  const s = raw.s3
  const r = raw.rustfs
  const envPrefix = isRust ? 'RUSTFS' : 'S3'
  const merged: ResolvedS3Config = {
    endpoint: r?.endpoint ?? s?.endpoint ?? process.env[`${envPrefix}_ENDPOINT`],
    region: r?.region ?? s?.region ?? process.env[`${envPrefix}_REGION`] ?? 'us-east-1',
    bucket: r?.bucket ?? s?.bucket ?? process.env[`${envPrefix}_BUCKET`] ?? 'genoffice',
    accessKeyId: r?.accessKeyId ?? s?.accessKeyId ?? process.env[`${envPrefix}_ACCESS_KEY_ID`],
    secretAccessKey: r?.secretAccessKey ?? s?.secretAccessKey ?? process.env[`${envPrefix}_SECRET_ACCESS_KEY`],
    forcePathStyle: r?.forcePathStyle ?? s?.forcePathStyle ?? isRust,
    timeoutMs: r?.timeoutMs ?? s?.timeoutMs ?? 30_000,
  }
  if (!merged.bucket) {
    throw new Error(
      `S3StorageBackend (${isRust ? 'rustfs' : 's3'}): bucket is required ` +
        `(set ${isRust ? 'RUSTFS_BUCKET' : 'S3_BUCKET'} or pass it via config)`,
    )
  }
  if (!merged.accessKeyId || !merged.secretAccessKey) {
    throw new Error(
      `S3StorageBackend (${isRust ? 'rustfs' : 's3'}): accessKeyId and secretAccessKey are required ` +
        `(set ${isRust ? 'RUSTFS_ACCESS_KEY_ID/RUSTFS_SECRET_ACCESS_KEY' : 'S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY'})`,
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
  readonly id: 's3' | 'rustfs'
  private readonly cfg: ResolvedS3Config
  private readonly client: S3Client

  constructor(config: StorageBackendConfig) {
    this.cfg = resolveS3Config(config)
    this.id = (config.backend === 'rustfs' ? 'rustfs' : 's3') as 's3' | 'rustfs'
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
