/**
 * The iframe embed bridge — a port of `apps/web-server/src/embed/bridge.ts`,
 * served verbatim as `/embed/static/bridge.js` so the browser executes it
 * inside the editor iframe before the renderer bundle boots.
 *
 * It has three jobs:
 *
 *   1. **Handshake** — read `<meta name="genoffice-nonce">` and post a
 *      `{type:'ready', nonce}` event to `window.parent` so the host SDK can
 *      verify it is talking to the iframe it framed.
 *   2. **Push relay** — subscribe to `/api/ipc/events?session=<sessionId>` and
 *      re-post every frame to `window.parent`. The SSE `channel` string becomes
 *      the SDK event name verbatim, which is how `saved` / `dirtyChanged` /
 *      `slides:history-changed` reach a host that has no other channel.
 *   3. **Command dispatch** — route an inbound `kind:'command'` envelope to the
 *      renderer's `window.__GENOFFICE_COMMAND_SINK__`, falling back to
 *      `POST /api/ipc/sdk:command` when the sink rejects with `UNSUPPORTED`.
 *
 * The fallback is a *fallback*, not merely the no-sink path: the shipped
 * renderers register only a small sink map, so treating sink presence as
 * ownership would shadow the whole server-backed subset.
 *
 * One deliberate difference from the web-server original: the emitted script
 * must not depend on `${WEB_SERVER_VERSION}`, which lives in
 * `apps/web-server/src/common/version.ts` and is not reachable from a published
 * office-ai tarball. The version is baked at build time from the constant below.
 */

/** Reported in the `ready` event's `version` field. */
export const EMBED_BRIDGE_VERSION = '1.0' as const
/** Kept in step with packages/office-ai/package.json's `version`. */
export const OFFICE_AI_UI_VERSION = '0.1.0'

/** Where the bridge is served, relative to the host root. */
export const EMBED_BRIDGE_SCRIPT_PATH = '/embed/static/bridge.js'

/**
 * The same script, relative to the embed directory.
 *
 * The wrapper page sets `<base href="./">` (its own directory) so it survives a
 * reverse-proxy mount. A root-absolute `src` therefore asks the *mount root*
 * for the bridge — fine at `/`, a 404 under any `basePath`, which leaves the
 * iframe with no bridge: no `ready`, no command dispatch, and the host's
 * `whenReady()` hangs until its timeout. A bare relative path resolves to
 * `<mount>/embed/static/bridge.js` at `/` and under a prefix alike.
 */
export const EMBED_BRIDGE_RELATIVE_PATH = EMBED_BRIDGE_SCRIPT_PATH.replace(/^\/embed\//, '')

export const EMBED_BRIDGE_SOURCE = `(function () {
  var ENVELOPE_VERSION = '1.0';
  var SDK_VERSION = '${OFFICE_AI_UI_VERSION}';
  // sendReady() can fire from BOTH the DOMContentLoaded listener and the load
  // listener (the bridge script runs while the parser is still going, so both
  // events dispatch after it is installed). Without this flag the host sees two
  // ready envelopes; the SDK's handshakeDone gate makes the second harmless,
  // but hosts that listen with a plain addEventListener count two mounts.
  var readySent = false;
  // subscribePush() is registered from the same two listeners and needs the
  // same guard for a worse reason: it holds an *open connection*, not a
  // message. Two calls meant two EventSource streams per embed page, each
  // holding a server-side session registration open for the page's lifetime.
  var pushSubscribed = false;
  // Prefix-independent API resolution. A host reverse-proxy that mounts this
  // server under a path prefix (Dataflarework: /office-engine, with
  // strip-path-prefix) erases the prefix before the request reaches us, so the
  // server cannot tell us what it was and a root-relative '/api/...' gets
  // asked of the *host*, which forwards only its own mount path — the call
  // silently fails and the embed loses its push channel and its command
  // round-trip. The bridge is always served from <prefix>${EMBED_BRIDGE_SCRIPT_PATH},
  // so walking two levels up from this script's own URL lands on the mount root
  // under any prefix (and at '/').
  var BRIDGE_SRC = (function () {
    try {
      var cur = document.currentScript;
      if (cur && cur.src) return cur.src;
      if (typeof document.getElementsByTagName !== 'function') return null;
      var scripts = document.getElementsByTagName('script');
      for (var i = scripts.length - 1; i >= 0; i--) {
        if (scripts[i].src && scripts[i].src.indexOf('${EMBED_BRIDGE_SCRIPT_PATH}') !== -1) {
          return scripts[i].src;
        }
      }
    } catch (e) { /* fall through to the document-relative anchor */ }
    return null;
  })();
  // What the host baked into this page for this request. It arrives as the
  // meta tag named genoffice-embed-config, with the session id mirrored in
  // genoffice-session. A host may still override via window.__GENOFFICE_EMBED__.
  function readEmbedConfig() {
    var cfg = {};
    try {
      var el = document.querySelector('meta[name="genoffice-embed-config"]');
      var raw = el ? el.getAttribute('content') : null;
      if (raw) cfg = JSON.parse(raw);
    } catch (e) { cfg = {}; }
    if (!cfg || typeof cfg !== 'object') cfg = {};
    try {
      var override = window.__GENOFFICE_EMBED__;
      if (override && typeof override === 'object') {
        var keys = Object.keys(override);
        for (var i = 0; i < keys.length; i++) cfg[keys[i]] = override[keys[i]];
      }
    } catch (e) { /* no host override */ }
    if (!cfg.sessionId) {
      try {
        var s = document.querySelector('meta[name="genoffice-session"]');
        var sid = s ? s.getAttribute('content') : null;
        if (sid) cfg.sessionId = sid;
      } catch (e) { /* no session meta */ }
    }
    return cfg;
  }
  function apiUrl(relPath) {
    if (BRIDGE_SRC) {
      try { return new URL('../../' + relPath, BRIDGE_SRC).toString(); } catch (e) { /* fall through */ }
    }
    // The embed document always sits one level below the mount root (it is
    // served at <prefix>/embed/<docId>), so '../' reaches the API root under a
    // prefix and at '/' alike.
    try { return new URL('../' + relPath, document.baseURI).toString(); } catch (e) { /* fall through */ }
    return '/' + relPath;
  }
  // The loopback host token, when the serving host injected one. Sent as
  // x-genoffice-token on the fetch (a custom header the EventSource API cannot
  // carry) and as ?token= on the SSE stream.
  function readEmbedToken() {
    try {
      var m = document.querySelector('meta[name="genoffice-token"]');
      var v = m ? m.getAttribute('content') : null;
      return v || null;
    } catch (e) { return null; }
  }
  function post(name, payload) {
    try {
      // Carry any nonce on the OUTER envelope as well as the inner body: the
      // SDK's handshake guard inspects env.payload.nonce, so a nonce that only
      // lived at env.payload.payload.nonce reads as undefined and tears the
      // editor down with HANDSHAKE_FAILED before any ready listener runs.
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
  var SDK_COMMAND_CHANNEL = 'sdk:command';
  // readEmbedConfig() — not the raw global — so docId/sessionId come from the
  // meta tag the host always injects. It also means x-ipc-session is sent,
  // which the IPC dispatcher needs to route the reply's push events.
  function dispatchViaServerIpc(correlationId, name, args) {
    var cfg = readEmbedConfig();
    var sessionId = cfg.sessionId;
    var docId = cfg.docId;
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
    var token = readEmbedToken();
    if (token) headers['x-genoffice-token'] = token;
    fetchFn(apiUrl('api/ipc/' + encodeURIComponent(SDK_COMMAND_CHANNEL)), {
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
          if (e && e.code === 'UNSUPPORTED') {
            dispatchViaServerIpc(correlationId, name, args);
            return;
          }
          replyCommand(correlationId, false, undefined, {
            code: (e && e.code) || 'RENDERER_ERROR',
            message: (e && e.message) || 'renderer rejected command'
          });
        });
      } catch (e) {
        if (e && e.code === 'UNSUPPORTED') {
          dispatchViaServerIpc(correlationId, name, args);
          return;
        }
        replyCommand(correlationId, false, undefined, {
          code: (e && e.code) || 'RENDERER_ERROR',
          message: (e && e.message) || 'renderer threw synchronously'
        });
      }
      return;
    }

    dispatchViaServerIpc(correlationId, name, args);
  }
  function onHostMessage(event) {
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.v !== ENVELOPE_VERSION) return;
    if (data.dir !== 'host→editor') return;
    if (data.kind === 'command') {
      try { dispatchCommand(data); } catch (e) { /* best-effort; do not throw */ }
    }
  }
  function sendReady() {
    if (readySent) return;
    readySent = true;
    var nonceMeta = document.querySelector('meta[name="genoffice-nonce"]');
    var nonce = nonceMeta ? nonceMeta.getAttribute('content') : null;
    var readyPayload = {
      type: 'ready',
      app: readEmbedConfig().app,
      version: SDK_VERSION
    };
    if (nonce) readyPayload.nonce = nonce;
    post('ready', readyPayload);
  }
  function subscribePush() {
    if (pushSubscribed) return;
    var cfg = readEmbedConfig();
    if (!cfg.sessionId) return;
    if (typeof EventSource === 'undefined') return;
    pushSubscribed = true;
    try {
      var esUrl = apiUrl('api/ipc/events') + '?session=' + encodeURIComponent(cfg.sessionId);
      var token = readEmbedToken();
      if (token) esUrl += '&token=' + encodeURIComponent(token);
      var es = new EventSource(esUrl);
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
