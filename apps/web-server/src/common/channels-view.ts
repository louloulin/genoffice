/**
 * View builder for `GET /api/channels` (sdk1 §B.10).
 *
 * The registry returns every channel the server has registered — 559 at last
 * count — and the full list is ~17 KB raw. A discovery client that only wants
 * one namespace (e.g. `ai:`) would otherwise download and parse all of them.
 *
 * Kept as a pure function, separate from the route handler in `src/index.ts`,
 * so the filtering, histogram, and payload cap are unit-testable without
 * booting the HTTP server.
 */

/** Hard ceiling on the serialized response body. */
export const CHANNELS_MAX_BYTES = 32 * 1024

export interface ChannelsViewOptions {
  /** Only include channels starting with this string. Empty = all. */
  prefix?: string
  /** Attach a per-namespace histogram plus the filtered total. */
  includeCounts?: boolean
}

export interface ChannelsView {
  status: number
  /** Serialized JSON body to write. */
  body: string
}

/**
 * Build the `/api/channels` response for a given channel list.
 *
 * Returns `413` when the serialized list exceeds {@link CHANNELS_MAX_BYTES};
 * the caller cannot raise the ceiling, only narrow `prefix`.
 */
export function buildChannelsView(
  all: readonly string[],
  options: ChannelsViewOptions = {},
): ChannelsView {
  const prefix = options.prefix ?? ''
  const channels = prefix ? all.filter((channel) => channel.startsWith(prefix)) : [...all]

  const payload: Record<string, unknown> = {
    protocolVersion: 1,
    minClientVersion: 1,
    channels,
  }
  if (prefix) payload.prefix = prefix
  if (options.includeCounts) {
    // Histogram keyed on the namespace segment (`ai`, `collab`, `files`, …)
    // so a client can render a collapsed tree in one round trip. Channels
    // without a `:` segment land under the empty-string bucket.
    const counts: Record<string, number> = {}
    for (const channel of channels) {
      const sep = channel.indexOf(':')
      const ns = sep >= 0 ? channel.slice(0, sep) : ''
      counts[ns] = (counts[ns] ?? 0) + 1
    }
    payload.counts = counts
    payload.total = channels.length
  }

  const body = JSON.stringify(payload)
  if (Buffer.byteLength(body) > CHANNELS_MAX_BYTES) {
    return {
      status: 413,
      body: JSON.stringify({
        error: {
          code: 'RESPONSE_TOO_LARGE',
          message: `channel list exceeds ${CHANNELS_MAX_BYTES} bytes; narrow it with ?prefix=`,
          channel: '/api/channels',
          bytes: Buffer.byteLength(body),
          maxBytes: CHANNELS_MAX_BYTES,
        },
      }),
    }
  }
  return { status: 200, body }
}
