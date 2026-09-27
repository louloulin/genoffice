import { describe, expect, it } from 'vitest'

describe('probe', () => {
  it('what does handleEmbed return for docs', async () => {
    const mod = await import('../src/embed/index')
    const chunks: Buffer[] = []
    let status = 0
    const res: any = {
      writeHead(s: number) { status = s; return res },
      end(c?: any) { if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); return res },
      setHeader() {},
    }
    mod.handleEmbed({} as any, res, new URL('http://x/embed/doc_abc?token=jwt-xyz&app=docs'))
    const body = chunks.join('')
    console.log('STATUS =', status, '| BODY LEN =', body.length, '| HAS_EventSource =', body.includes('EventSource'), '| HAS_ipc =', body.includes('ipc/events'))
    if (status === 200) console.log('BODY_HEAD =', JSON.stringify(body.slice(0, 400)))
    expect(true).toBe(true)
  })
})
