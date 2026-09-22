/**
 * The iframe Embed bridge script — runs inside the iframe page after the
 * server-rendered HTML, before the editor bundle boots.
 *
 * The bridge has two responsibilities:
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
 * The script is split out from `embed/index.ts` so it can be unit
 * tested in isolation (see `tests/embed-bridge.test.ts`). The runtime
 * path is `embed/index.ts` → injects `<script>${BRIDGE_SCRIPT}</script>`
 * into the served HTML, then the browser executes it inside the
 * iframe.
 *
 * Note (sdk1.md §11.34): an earlier iteration of this bridge also
 * relayed inbound postMessage commands from the host onto `window` as
 * `host.command` CustomEvents, intended for a renderer-side command
 * listener. That listener was never implemented in the renderer and
 * no shipped code consumes `host.command`, so the relay has been
 * removed. The bridge still *receives* inbound postMessages for
 * envelope-version validation, but it no longer re-dispatches them.
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
        dir: 'editor→host',
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
  // Inbound postMessages from the host are accepted on the envelope
  // version (so legacy senders are dropped at the source) but the
  // editor currently consumes them via its own postMessage listener
  // registered after bridge boot — no relay is needed here. See the
  // top-of-file note (sdk1.md §11.34) for why the previous
  // host.command CustomEvent relay was removed.
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
