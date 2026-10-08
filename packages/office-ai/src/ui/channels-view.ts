/**
 * View builder for `GET /api/channels` — ported from
 * apps/web-server/src/common/channels-view.ts. The registry lists every
 * channel the host registered; a discovery client can narrow with ?prefix=
 * and request a per-namespace histogram with ?counts=1.
 */
export const CHANNELS_MAX_BYTES = 32 * 1024

export interface ChannelsViewOptions {
  prefix?: string
  includeCounts?: boolean
}

export interface ChannelsView {
  status: number
  body: string
}

export function buildChannelsView(all: readonly string[], options: ChannelsViewOptions = {}): ChannelsView {
  const prefix = options.prefix ?? ''
  const channels = prefix ? all.filter((channel) => channel.startsWith(prefix)) : [...all]

  const payload: Record<string, unknown> = {
    protocolVersion: 1,
    minClientVersion: 1,
    channels,
  }
  if (prefix) payload.prefix = prefix
  if (options.includeCounts) {
    const counts: Record<string, number> = {}
    for (const channel of channels) {
      const sepIndex = channel.indexOf(':')
      const ns = sepIndex >= 0 ? channel.slice(0, sepIndex) : ''
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