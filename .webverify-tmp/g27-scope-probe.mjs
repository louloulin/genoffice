// G2.7 measurement: drive a real embed session with the EXACT guest scope
// Dataflare mints (["files:read"], EmbedSessionController.kt:142) and record
// every non-2xx the guest makes. The set of blocked calls is what the guest
// JWT scope set has to cover — measuring beats guessing.
import { chromium } from 'playwright'

const WT = process.env.G27_WEB_TOKEN
const BASE = process.env.G27_BASE ?? 'http://127.0.0.1:19099'
const DOC = 'doc-b.docx'
if (!WT) throw new Error('G27_WEB_TOKEN unset')

// The literal Dataflare mints today. Widening this list IS the G2.7 change.
const GUEST_SCOPE = JSON.parse(process.env.G27_SCOPE ?? '["files:read"]')

async function mintJwt(scope) {
  const r = await fetch(`${BASE}/api/v1/auth/jwt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${WT}` },
    body: JSON.stringify({ sub: 'verify', scope, ttl: 600 }),
  })
  const j = await r.json()
  if (!j.token) throw new Error(`mint failed: ${JSON.stringify(j)}`)
  return j.token
}

function hostHtml() {
  return `<!doctype html><meta charset="utf-8"><body>
<iframe id="f" style="width:1100px;height:760px"></iframe>
<script>
window.__state = { events: [], results: [] };
const pending = new Map();
let n = 0;
window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || typeof d !== 'object' || d.v !== '1.0' || d.dir !== 'editor→host') return;
  if (d.kind === 'command-result') { window.__state.results.push(d); const r = pending.get(d.correlationId); if (r) { pending.delete(d.correlationId); r(d); } }
  else if (d.kind === 'event') window.__state.events.push(d.payload && d.payload.name);
});
window.__host = {
  send(name, args) {
    return new Promise((res, rej) => {
      const cid = 'c' + (++n);
      const t = setTimeout(() => { pending.delete(cid); rej(new Error('timeout ' + name)); }, 20000);
      pending.set(cid, (d) => { clearTimeout(t); res(d); });
      document.getElementById('f').contentWindow.postMessage({ v: '1.0', dir: 'host→editor', kind: 'command', correlationId: cid, payload: { name, args } }, '*');
    });
  },
};
</script></body>`
}

async function run() {
  const token = await mintJwt(GUEST_SCOPE)
  const hostUrl = `${BASE}/__g27_host__`
  const embedUrl = `${BASE}/embed/${encodeURIComponent(DOC)}?token=${encodeURIComponent(token)}&app=docs`

  let browser
  try { browser = await chromium.launch({ channel: 'chrome' }) } catch { browser = await chromium.launch() }
  const ctx = await browser.newContext()
  const page = await ctx.newPage()

  // Every guest-originated request, with status. The auth_token cookie rides
  // all of them, so this IS the JWT-authorized surface.
  const seen = []
  page.on('response', async (res) => {
    const u = new URL(res.url())
    if (!u.pathname.includes('/api/') && !u.pathname.includes('/embed/')) return
    seen.push({ status: res.status(), method: res.request().method(), path: u.pathname + u.search })
  })
  await ctx.route(hostUrl, (r) => r.fulfill({ contentType: 'text/html', body: hostHtml() }))
  await page.goto(hostUrl)
  await page.evaluate((u) => { document.getElementById('f').src = u }, embedUrl)

  // 1. handshake
  let ready = false
  for (let i = 0; i < 160 && !ready; i++) {
    ready = await page.evaluate(() => window.__state.events.includes('ready'))
    if (!ready) await new Promise((r) => setTimeout(r, 250))
  }
  // 2. let the doc load and the SSE subscribe settle
  await new Promise((r) => setTimeout(r, 4000))
  // 3. a real edit + save, which is the Cmd+S path the host relies on
  let save = null
  try {
    const frame = page.frames().find((f) => f.url().includes('/embed/'))
    if (frame) {
      await frame.click('body', { position: { x: 300, y: 200 } }).catch(() => {})
      await page.keyboard.type('g27 probe ')
      await page.waitForTimeout(800)
      save = await page.evaluate(() => window.__host.send('createSnapshot', { label: 'g27 probe' }).then((d) => d.payload).catch((e) => ({ thrown: String(e) })))
      await page.waitForTimeout(1500)
    }
  } catch (e) { save = { thrown: String(e) } }

  await browser.close()

  const bad = seen.filter((s) => s.status >= 400)
  const byPath = new Map()
  for (const s of bad) {
    const k = `${s.status} ${s.method} ${s.path.split('?')[0]}`
    byPath.set(k, (byPath.get(k) ?? 0) + 1)
  }
  console.log(`\n=== guest scope ${JSON.stringify(GUEST_SCOPE)} on ${BASE} ===`)
  console.log(`  ready handshake : ${ready}`)
  console.log(`  createSnapshot  : ${JSON.stringify(save)}`)
  console.log(`  total /api|/embed requests: ${seen.length}, non-2xx: ${bad.length}`)
  console.log('  --- non-2xx detail ---')
  if (byPath.size === 0) console.log('    (none)')
  for (const [k, n] of [...byPath.entries()].sort()) console.log(`    ${k}  x${n}`)
  return bad
}

const bad = await run()
process.exit(bad.length ? 0 : 0)
