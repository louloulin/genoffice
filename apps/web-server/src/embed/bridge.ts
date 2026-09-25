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
 * Inbound command dispatch (sdk1.md §11.36 follow-up to §11.34):
 * the bridge now actively dispatches inbound envelope commands from
 * the host page to the web-server IPC dispatcher via
 * `POST /api/ipc/<channel>`, then mirrors the IPC envelope back as a
 * `command-result` envelope so SDK's `editor.command()` round-trip
 * works in the iframe without renderer-side changes. This replaces
 * the §11.34 `host.command` CustomEvent dead path with a real IPC
 * round-trip; the SDK does not need to know the bridge exists.
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
      // Carry any nonce on the OUTER envelope so the SDK's handshake
      // guard (which inspects env.payload.nonce for the ready event)
      // matches the bridge's wire shape. Previously the nonce only
      // lived on env.payload.payload.nonce (the inner event body), so
      // the SDK always saw undefined !== expectedNonce and tore the
      // editor down with HANDSHAKE_FAILED before any ready listener
      // could run.
      var outer = {
        v: ENVELOPE_VERSION,
        dir: 'editor→host',
        kind: 'event',
        payload: { name: name, payload: payload }
      };
      if (payload && typeof payload === 'object' && typeof payload.nonce === 'string') {
        outer.payload.nonce = payload.nonce;
      }
      window.parent.postMessage(outer, '*');
    } catch (e) { /* parent gone, swallow */ }
  }
  function replyCommand(correlationId, ok, result, error) {
    try {
      var p = { ok: ok };
      if (result !== undefined) p.result = result;
      if (error) p.error = error;
      window.parent.postMessage({
        v: ENVELOPE_VERSION,
        dir: 'editor→host',
        kind: 'command-result',
        correlationId: correlationId,
        payload: p
      }, '*');
    } catch (e) { /* parent gone, swallow */ }
  }
  // Inbound envelope command dispatch. SDK editor.command(name, args)
  // sends {kind:'command', correlationId, payload:{name, args}}.
  //
  // Dispatch order (exactly ONE reply per command, never two):
  //   1. Renderer sink — if the editor bundle has registered
  //      window.__GENOFFICE_COMMAND_SINK__ = function(name, args), the
  //      bridge calls it and mirrors its resolved value / rejection.
  //      This is how renderer-owned commands (setContent, insertText,
  //      undo, mountSidebar, openFileDialog, …) get serviced once the
  //      renderer team wires them up.
  //   2. Server IPC — otherwise POST /api/ipc/sdk:command with
  //      {args:[{name, args, docId}]} + x-ipc-session. The web-server
  //      dispatcher services the server-backed subset (comments /
  //      versions / telemetry) and replies UNSUPPORTED for the rest, so
  //      the host sees a loud structured failure instead of a hang.
  //
  // Error codes from either side are preserved verbatim so hosts see a
  // stable shape regardless of who rejected the command.
  var SDK_COMMAND_CHANNEL = 'sdk:command';
  function dispatchCommand(env) {
    var name = env && env.payload && env.payload.name;
    var args = env && env.payload && env.payload.args;
    var correlationId = env && env.correlationId;
    if (typeof name !== 'string' || !name || !correlationId) return;

    var sink = window.__GENOFFICE_COMMAND_SINK__;
    if (typeof sink === 'function') {
      try {
        Promise.resolve(sink(name, args)).then(function (result) {
          replyCommand(correlationId, true, result);
        }, function (e) {
          replyCommand(correlationId, false, undefined, {
            code: (e && e.code) || 'RENDERER_ERROR',
            message: (e && e.message) || 'renderer rejected command'
          });
        });
      } catch (e) {
        replyCommand(correlationId, false, undefined, {
          code: (e && e.code) || 'RENDERER_ERROR',
          message: (e && e.message) || 'renderer threw synchronously'
        });
      }
      return;
    }

    var cfg = window.__GENOFFICE_EMBED__;
    var sessionId = cfg && cfg.sessionId;
    var docId = cfg && cfg.docId;
    var fetchFn = (typeof fetch !== 'undefined') ? fetch : null;
    if (!fetchFn) {
      replyCommand(correlationId, false, undefined, {
        code: 'IPC_DISPATCH_UNAVAILABLE',
        message: 'fetch is unavailable in this iframe'
      });
      return;
    }
    var envelope = { name: name, args: args === undefined ? {} : args };
    if (docId) envelope.docId = docId;
    var headers = { 'content-type': 'application/json' };
    if (sessionId) headers['x-ipc-session'] = sessionId;
    fetchFn('/api/ipc/' + encodeURIComponent(SDK_COMMAND_CHANNEL), {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ args: [envelope] })
    }).then(function (res) {
      return res.text().then(function (text) {
        var parsed;
        try { parsed = text ? JSON.parse(text) : null; } catch (e) { parsed = null; }
        if (res.ok && parsed && parsed.ok === true) {
          replyCommand(correlationId, true, parsed.result);
        } else {
          var err = (parsed && parsed.error) || { message: 'IPC ' + res.status, code: 'IPC_ERROR' };
          replyCommand(correlationId, false, undefined, {
            code: err.code || 'IPC_ERROR',
            message: err.message || ('IPC ' + res.status)
          });
        }
      });
    }).catch(function (e) {
      replyCommand(correlationId, false, undefined, {
        code: 'IPC_FETCH_FAILED',
        message: (e && e.message) || 'IPC fetch failed'
      });
    });
  }
  function onHostMessage(event) {
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.v !== ENVELOPE_VERSION) return;
    if (data.dir !== 'host→editor') return;
    if (data.kind === 'command') {
      try { dispatchCommand(data); } catch (e) {
        /* dispatch failures are best-effort; do not throw */
      }
    }
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
  // Inbound postMessages from the host are accepted on the envelope
  // version. Bridge-installed listener dispatches 'command' envelopes
  // to /api/ipc/<channel> via fetch (round-trip mirrors a renderer
  // IPC call). 'event' envelopes from the host are intentionally
  // ignored at the bridge level — the editor (loaded into the same
  // iframe after bridge boot) installs its own postMessage listener
  // (apps/sdk/src/editor.ts) and reacts to host events directly.
  window.addEventListener('message', onHostMessage);
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
