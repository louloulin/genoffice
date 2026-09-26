/**
 * Generic version-history capability — `/api/v1/files/:id/versions[/:vid]`.
 *
 * Five routes per file id (see `apps/web-server/src/api/v1/versions.ts`):
 *   - GET    /api/v1/files/:id/versions              list   (scope `files:read`)
 *   - GET    /api/v1/files/:id/versions/:vid         get    (scope `files:read`)
 *   - POST   /api/v1/files/:id/versions              create (scope `files:write`)
 *   - POST   /api/v1/files/:id/versions/:vid/restore restore (scope `files:restore`)
 *   - DELETE /api/v1/files/:id/versions/:vid         delete (scope `files:restore`)
 *
 * `files:restore` is intentionally NOT implied by `files:write`. Hosts that
 * want a "commenter" role mint a token with `files:read + files:comment +
 * files:write` but no restore power.
 *
 * Zero dataflare coupling.
 */

import {
  RequestError,
  requestJson,
  requestVoid,
  type RequestConfig,
  type RequestOptions,
} from '../internal/request'

export interface VersionMeta {
  id: string
  docId: string
  index: number
  timestamp: number
  size: number
  sha256: string
  message?: string
}

export interface VersionWithBytes extends VersionMeta {
  /** Base64-encoded snapshot bytes. Server caps at 16 MiB. */
  bytes: string
}

export interface ListVersionsResult {
  fileId: string
  count: number
  versions: VersionMeta[]
}

export interface CreateVersionInput {
  fileId: string
  /** Free-form label (≤ 200 chars). Stored as `message` on the snapshot. */
  label?: string
}

export interface RestoreVersionResult {
  version: string
  fileId: string
}

export interface DeleteVersionResult {
  ok: true
  fileId: string
  versionId: string
}

export interface VersionsClientConfig extends RequestConfig {}

export class VersionsClient {
  readonly #config: VersionsClientConfig

  constructor(config: VersionsClientConfig) {
    if (!config || typeof config.baseUrl !== 'string' || !config.baseUrl) {
      throw new TypeError('VersionsClient: baseUrl is required')
    }
    this.#config = config
  }

  async list(fileId: string, options: RequestOptions = {}): Promise<ListVersionsResult> {
    assertFileId(fileId, 'versions:list')
    const raw = await requestJson<{ fileId?: unknown; count?: unknown; versions?: unknown }>(
      this.#config,
      'GET',
      `/api/v1/files/${encodeURIComponent(fileId)}/versions`,
      undefined,
      'files:versions:list',
      options,
    )
    if (
      !raw ||
      typeof raw.fileId !== 'string' ||
      typeof raw.count !== 'number' ||
      !Array.isArray(raw.versions)
    ) {
      throw new RequestError({
        code: 'UNKNOWN',
        message: 'VersionsClient.list: malformed response',
        status: 200,
        channel: 'files:versions:list',
        detail: raw,
      })
    }
    return {
      fileId: raw.fileId,
      count: raw.count,
      versions: raw.versions.filter(isVersionMeta).map(stripExtra),
    }
  }

  async get(
    fileId: string,
    versionId: string,
    options: RequestOptions = {},
  ): Promise<VersionWithBytes> {
    assertFileId(fileId, 'versions:get')
    assertVersionId(versionId, 'versions:get')
    const raw = await requestJson<Record<string, unknown>>(
      this.#config,
      'GET',
      `/api/v1/files/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(versionId)}`,
      undefined,
      'files:versions:get',
      options,
    )
    if (!isVersionMeta(raw) || typeof raw.bytes !== 'string') {
      throw new RequestError({
        code: 'UNKNOWN',
        message: 'VersionsClient.get: malformed response',
        status: 200,
        channel: 'files:versions:get',
        detail: raw,
      })
    }
    return { ...stripExtra(raw), bytes: raw.bytes }
  }

  async create(input: CreateVersionInput, options: RequestOptions = {}): Promise<VersionMeta> {
    assertFileId(input?.fileId, 'versions:create')
    const body: Record<string, string> = {}
    if (input.label !== undefined) {
      if (typeof input.label !== 'string' || input.label.length === 0) {
        throw new RequestError({
          code: 'INVALID_ARGUMENT',
          message: 'VersionsClient.create: label must be a non-empty string',
          status: 0,
          channel: 'files:versions:create',
        })
      }
      if (input.label.length > 200) {
        throw new RequestError({
          code: 'INVALID_ARGUMENT',
          message: 'VersionsClient.create: label exceeds 200 chars',
          status: 0,
          channel: 'files:versions:create',
        })
      }
      body.label = input.label
    }
    const raw = await requestJson<Record<string, unknown>>(
      this.#config,
      'POST',
      `/api/v1/files/${encodeURIComponent(input.fileId)}/versions`,
      body,
      'files:versions:create',
      options,
    )
    if (!isVersionMeta(raw)) {
      throw new RequestError({
        code: 'UNKNOWN',
        message: 'VersionsClient.create: malformed response',
        status: 201,
        channel: 'files:versions:create',
        detail: raw,
      })
    }
    return stripExtra(raw)
  }

  async restore(
    fileId: string,
    versionId: string,
    options: RequestOptions = {},
  ): Promise<RestoreVersionResult> {
    assertFileId(fileId, 'versions:restore')
    assertVersionId(versionId, 'versions:restore')
    const raw = await requestJson<{ version?: unknown; fileId?: unknown }>(
      this.#config,
      'POST',
      `/api/v1/files/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(versionId)}/restore`,
      {},
      'files:versions:restore',
      options,
    )
    if (!raw || typeof raw.version !== 'string' || typeof raw.fileId !== 'string') {
      throw new RequestError({
        code: 'UNKNOWN',
        message: 'VersionsClient.restore: malformed response',
        status: 200,
        channel: 'files:versions:restore',
        detail: raw,
      })
    }
    return { version: raw.version, fileId: raw.fileId }
  }

  async delete(
    fileId: string,
    versionId: string,
    options: RequestOptions = {},
  ): Promise<DeleteVersionResult> {
    assertFileId(fileId, 'versions:delete')
    assertVersionId(versionId, 'versions:delete')
    await requestVoid(
      this.#config,
      'DELETE',
      `/api/v1/files/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(versionId)}`,
      undefined,
      'files:versions:delete',
      options,
    )
    return { ok: true, fileId, versionId }
  }
}

// ── Module-local helpers ────────────────────────────────────────────────────

function assertFileId(fileId: unknown, op: string): asserts fileId is string {
  if (typeof fileId !== 'string' || fileId.length === 0 || fileId.includes('\0')) {
    throw new RequestError({
      code: 'INVALID_ARGUMENT',
      message: `VersionsClient: fileId must be a non-empty path segment (op=${op})`,
      status: 0,
      channel: `files:${op}`,
    })
  }
}

function assertVersionId(versionId: unknown, op: string): asserts versionId is string {
  if (typeof versionId !== 'string' || versionId.length === 0 || versionId.includes('\0')) {
    throw new RequestError({
      code: 'INVALID_ARGUMENT',
      message: `VersionsClient: versionId must be a non-empty path segment (op=${op})`,
      status: 0,
      channel: `files:${op}`,
    })
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isVersionMeta(v: unknown): v is VersionMeta & { message?: string } {
  if (!isObject(v)) return false
  return (
    typeof v.id === 'string' &&
    typeof v.docId === 'string' &&
    typeof v.index === 'number' &&
    typeof v.timestamp === 'number' &&
    typeof v.size === 'number' &&
    typeof v.sha256 === 'string'
  )
}

function stripExtra(v: VersionMeta & { message?: string }): VersionMeta {
  return {
    id: v.id,
    docId: v.docId,
    index: v.index,
    timestamp: v.timestamp,
    size: v.size,
    sha256: v.sha256,
    ...(v.message !== undefined ? { message: v.message } : {}),
  }
}
