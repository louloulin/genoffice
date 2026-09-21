/**
 * Resolve a {@link StorageBackendConfig} into a concrete {@link StorageBackend}.
 *
 * The `backend` field picks the implementation; the rest of `config` is
 * forwarded. Unset `backend` defaults to `'local'` so legacy callers that
 * only supply `filesDir` keep working.
 *
 * `s3` and `rustfs` both resolve to the same {@link S3StorageBackend} class
 * (rustfs speaks the S3 wire protocol), with `rustfs` defaulting to
 * path-style addressing and an `endpoint` of `http://127.0.0.1:9000` when
 * neither env nor config overrides it.
 */
import { LocalStorageBackend } from './local'
import { MimoStorageBackend } from './mimo'
import { S3StorageBackend } from './s3'
import type { StorageBackend, StorageBackendConfig } from './backend'

const RUSTFS_DEFAULT_ENDPOINT = 'http://127.0.0.1:9000'

export function createStorageBackend(config: StorageBackendConfig): StorageBackend {
  const backend = config.backend ?? 'local'
  switch (backend) {
    case 'local':
      return new LocalStorageBackend(config)
    case 'mimo':
      return new MimoStorageBackend(config)
    case 's3':
      return new S3StorageBackend({ ...config, backend: 's3' })
    case 'rustfs': {
      /* rustfs defaults: same S3 protocol, but on the local cluster's default
       * port and force-path-style. An operator-supplied endpoint / credentials
       * always win over these defaults. The backend id is preserved as
       * 'rustfs' so logging/metrics can tell the two apart. */
      const withDefaults: StorageBackendConfig & {
        rustfs?: {
          endpoint?: string
          region?: string
          bucket?: string
          accessKeyId?: string
          secretAccessKey?: string
          forcePathStyle?: boolean
          timeoutMs?: number
        }
      } = {
        ...config,
        rustfs: {
          endpoint: RUSTFS_DEFAULT_ENDPOINT,
          forcePathStyle: true,
          region: 'us-east-1',
          bucket: 'genoffice',
          ...(config as { rustfs?: object }).rustfs,
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

export { LocalStorageBackend, MimoStorageBackend, S3StorageBackend }
export {
  StorageNotFoundError,
  type HeadResult,
  type ListEntry,
  type PutOptions,
  type SignedUrlOptions,
  type StorageBackend,
  type StorageBackendConfig,
} from './backend'
