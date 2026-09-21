/**
 * Resolve a {@link StorageBackendConfig} into a concrete {@link StorageBackend}.
 *
 * The `backend` field picks the implementation; the rest of `config` is
 * forwarded. Unset `backend` defaults to `'local'` so legacy callers that
 * only supply `filesDir` keep working.
 *
 * `s3`, `rustfs`, and `minio` all resolve to the same {@link S3StorageBackend}
 * class — they speak the same wire protocol. The factory distinguishes the
 * three by tagging the resulting instance with `id: 's3' | 'rustfs' | 'minio'`
 * so logs/metrics can tell them apart, and supplies sensible defaults for the
 * self-hosted `rustfs` and `minio` flavours (path-style, no SSL, default
 * port 9000) when the operator hasn't provided an endpoint.
 */
import { LocalStorageBackend } from './local'
import { S3StorageBackend } from './s3'
import type { StorageBackend, StorageBackendConfig } from './backend'

const SELF_HOSTED_DEFAULT_ENDPOINT = 'http://127.0.0.1:9000'
const SELF_HOSTED_DEFAULT_REGION = 'us-east-1'
const SELF_HOSTED_DEFAULT_BUCKET = 'genoffice'

export function createStorageBackend(config: StorageBackendConfig): StorageBackend {
  const backend = config.backend ?? 'local'
  switch (backend) {
    case 'local':
      return new LocalStorageBackend(config)
    case 's3':
      return new S3StorageBackend({ ...config, backend: 's3' })
    case 'rustfs': {
      /* rustfs defaults: same S3 protocol, but on the local cluster's default
       * port and force-path-style. An operator-supplied endpoint / credentials
       * always win over these defaults. The backend id is preserved as
       * 'rustfs' so logging/metrics can tell the two apart. */
      const withDefaults = {
        ...config,
        rustfs: {
          endpoint: SELF_HOSTED_DEFAULT_ENDPOINT,
          forcePathStyle: true,
          region: SELF_HOSTED_DEFAULT_REGION,
          bucket: SELF_HOSTED_DEFAULT_BUCKET,
          ...(config as { rustfs?: object }).rustfs,
        },
      }
      return new S3StorageBackend(withDefaults)
    }
    case 'minio': {
      /* MinIO defaults: same S3 protocol. Default to the canonical standalone
       * MinIO server address and path-style addressing (MinIO historically
       * serves paths rather than virtual-host buckets). Operator env/config
       * always wins over these defaults. */
      const withDefaults = {
        ...config,
        minio: {
          endpoint: SELF_HOSTED_DEFAULT_ENDPOINT,
          forcePathStyle: true,
          region: SELF_HOSTED_DEFAULT_REGION,
          bucket: SELF_HOSTED_DEFAULT_BUCKET,
          ...(config as { minio?: object }).minio,
        },
      }
      return new S3StorageBackend(withDefaults)
    }
    default: {
      const _exhaustive: never = backend
      throw new Error(`createStorageBackend: unknown backend "${String(_exhaustive)}"`)
    }
  }
}

export { LocalStorageBackend, S3StorageBackend }
export {
  StorageNotFoundError,
  type HeadResult,
  type ListEntry,
  type PutOptions,
  type SignedUrlOptions,
  type StorageBackend,
  type StorageBackendConfig,
} from './backend'
