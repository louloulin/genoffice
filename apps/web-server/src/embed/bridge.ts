/**
 * The iframe Embed bridge script — runs inside the iframe page after the
 * server-rendered HTML, before the editor bundle boots.
 *
 * The bridge has three responsibilities:
 *
 *   1. **Handshake nonce echo** — reads `<meta name="genoffice-nonce">`
 *      and posts a `{type:'ready', nonce}` event to `window.parent` so
 *      the host SDK can verify the iframe identity. Without this, an
 *      attacker could substitute a same-origin URL that mimics our
 *      postMessage protocol (sdk1.md §11.20).
 *
 *   2. **Server-side push relay** — subscribes to
 *      `/api/ipc/events?session=<sessionId>` so lifecycle events
 *      (`saved` / `dirtyChanged` / `selectionChange` / `error` /
 *      `closed`) emitted by the renderer's push hub flow through to
 *      `window.parent` for the host SDK to consume.
 *
 *   3. **Inbound command relay** — listens for postMessage commands
 *      from the host (`{kind:'command', ...}`) and re-dispatches them
 *      on `window` as `host.command` CustomEvents so the renderer's
 *      command channel picks them up.
 *
 * The script is split out from `embed/index.ts` so it can be unit
 * tested in isolation (see `tests/embed-bridge.test.ts`). The runtime
 * path is `embed/index.ts` → injects `<script>${BRIDGE_SCRIPT}</script>`
 * into the served HTML, then the browser executes it inside the
 * iframe.
 *
 * Bridge protocol version (informational, NOT part of the SDK contract):
 *   - EMBED_BRIDGE_VERSION = '1.0' — bumped if we add / remove fields
 *   - payload.v = '1.0' — enveloped postMessage payload version
 */
import { WEB_SERVER_VERSION } from '../common/version'

export const EMBED_BRIDGE_VERSION = '1.0' as const

/**
 * Source of the bridge as an evaluated string. Templates in the
 * `${version}` placeholder so the served HTML is a fully self-contained
 * JS expression (no template interpolation needed at runtime).
 *
 * Exported for tests so they can evaluate the script in a controlled
 * scope (a fake `window` / `document` / `EventSource`).
 */
export const EMBED_BRIDGE_SOURCE = `(function () {
  var ENVELOPE_VERSION = '1.0';
  function post(name, payload) {
    try {
      window.parent.postMessage({
        v: ENVELOPE_VERSION,
        dir: 'editor->host',
        kind: 'event',
        payload: { name: name, payload: payload }
      }, '*');
    } catch (e) { /* parent gone, swallow */ }
  }
  function sendReady() {
    var nonceMeta = document.querySelector('meta[name="genoffice-nonce"]');
    var nonce = nonceMeta ? nonceMeta.getAttribute('content') : null;
    var readyPayload = {
      type: 'ready',
      app: window.__GENOFFICE_EMBED__ && window.__GENOFFICE_EMBED__.app,
      version: '${WEB_SERVER_VERSION}'
    };
    if (nonce) readyPayload.nonce = nonce;
    post('ready', readyPayload);
  }
  function subscribePush() {
    var cfg = window.__GENOFFICE_EMBED__;
    if (!cfg || !cfg.sessionId) return;
    if (typeof EventSource === 'undefined') return;
    try {
      var es = new EventSource('/api/ipc/events?session=' + encodeURIComponent(cfg.sessionId));
      es.onmessage = function (ev) {
        var frame;
        try { frame = JSON.parse(ev.data); } catch (e) { return; }
        if (!frame || !frame.channel || !frame.args) return;
        var p = frame.args.length === 1 ? frame.args[0] : frame.args;
        post(frame.channel, p);
      };
      es.onerror = function () { /* SSE auto-reconnects; ignore transient */ };
      window.addEventListener('beforeunload', function () {
        try { es.close(); } catch (e) { /* ignore */ }
      });
    } catch (e) { /* EventSource construction failed, degrade to no-push */ }
  }
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.v !== ENVELOPE_VERSION) return;
    if (data.kind === 'command') {
      window.dispatchEvent(new CustomEvent('host.command', { detail: data }));
    }
  });
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(sendReady, 0);
    setTimeout(subscribePush, 0);
  } else {
    window.addEventListener('DOMContentLoaded', function () {
      setTimeout(sendReady, 0);
      setTimeout(subscribePush, 0);
    });
    window.addEventListener('load', function () {
      setTimeout(sendReady, 0);
      setTimeout(subscribePush, 0);
    });
  }
})();`
