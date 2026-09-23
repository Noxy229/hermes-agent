/* Hermes Desktop renderer → plain-browser shim ("desktop-web").
 *
 * Fakes the Electron preload surface (`window.hermesDesktop`) against the
 * same-origin `hermes dashboard` backend. Two auth paths (proven against
 * web_server_chat.py on v0.21.4):
 *   A) cookie session → POST /api/auth/ws-ticket → /api/ws?ticket=<single-use>
 *   B) /api/pty/shell-token (same-origin + same-site Origin) → /api/internal/ws?internal=<bearer>
 * (B exists for the noVNC PTY bridge; kept as a WS fallback.)
 * REST rides fetch with credentials:'include' (session cookie).
 */
(function () {
  'use strict'

  var params = new URLSearchParams(location.search)
  var PROFILE = params.get('profile') || 'default'
  var WS_PROTO = location.protocol === 'https:' ? 'wss' : 'ws'
  var BASE = location.origin

  // ── REST: window.hermesDesktop.api(request) → same-origin fetch ──────────
  async function api(request) {
    request = request || {}
    var path = request.path || '/'
    var method = (request.method || 'GET').toUpperCase()
    // Electron routed profiles via IPC metadata; the server understands ?profile=.
    if (request.profile && !/[?&]profile=/.test(path)) {
      path += (path.indexOf('?') === -1 ? '?' : '&') + 'profile=' + encodeURIComponent(request.profile)
    }
    var controller = new AbortController()
    var timer = setTimeout(function () { controller.abort() }, request.timeoutMs || 15000)
    try {
      var init = { method: method, credentials: 'include', signal: controller.signal, headers: {} }
      if (request.body !== undefined) {
        init.headers['Content-Type'] = 'application/json'
        init.body = JSON.stringify(request.body)
      }
      var res = await fetch(path, init)
      var text = await res.text()
      if (!res.ok) {
        var err = new Error(res.status + ': ' + text.slice(0, 400))
        err.statusCode = res.status
        throw err
      }
      return text ? JSON.parse(text) : null
    } finally {
      clearTimeout(timer)
    }
  }

  // ── WS URL: ticket (gated primary) or internal bearer (fallback) ────────
  async function mintWsResult() {
    try {
      var t = await api({ path: '/api/auth/ws-ticket', method: 'POST' })
      return { ok: true, wsUrl: WS_PROTO + '://' + location.host + '/api/ws?ticket=' + encodeURIComponent(t.ticket) }
    } catch (e) {
      // pass through to internal-token fallback
    }
    try {
      var r = await fetch(BASE + '/api/pty/shell-token', { credentials: 'include' })
      if (r.ok) {
        var j = await r.json()
        var bearer = j.internal_token || j.token || j.bearer
        if (bearer) {
          return { ok: true, wsUrl: WS_PROTO + '://' + location.host + '/api/internal/ws?internal=' + encodeURIComponent(bearer) }
        }
      }
    } catch (e) { /* fall through */ }
    return { ok: false, error: 'no gateway websocket credential (not logged in?)', needsOauthLogin: true }
  }

  var NOOP_UNSUB = function () {}

  function connection(profile) {
    return {
      baseUrl: BASE,
      customWindowControls: false,
      isFullscreen: false,
      isMaximized: false,
      nativeOverlayWidth: 0,
      windowButtonPosition: null,
      logs: [],
      mode: 'local',
      // authMode 'oauth' forces the renderer through getGatewayWsUrl() before
      // every dial — required because tickets are single-use and a cached
      // ?token= URL is rejected in gated mode.
      authMode: 'oauth',
      token: null,
      wsUrl: '',
      profile: profile || PROFILE,
      connectionId: null,
      registryScoped: false,
      sharedPrimary: false
    }
  }

  var desktop = {
    // sync capability flags (read unguarded; "no native chrome here")
    glassSupported: false,
    translucencySupported: false,
    localModelsEnabled: false,
    guestOnboardingEnabled: false,
    skipIntro: true,
    windowControls: { custom: false },
    hud: { nativeDrag: false, windowing: false },

    // ── REQUIRED for boot ──────────────────────────────────────────────────
    getConnection: function (profile) { return Promise.resolve(connection(profile)) },
    getConnectionFor: function (payload) { return Promise.resolve(connection(payload && payload.profile)) },
    getGatewayWsUrl: function () { return mintWsResult() },
    getGatewayWsUrlFor: function () { return mintWsResult() },
    getBootProgress: function () {
      return Promise.resolve({
        error: null, fakeMode: false, message: '', phase: 'ready',
        progress: 100, running: false, timestamp: Date.now()
      })
    },
    onBootProgress: function (cb) {
      try {
        cb({ error: null, fakeMode: false, message: '', phase: 'ready', progress: 100, running: false, timestamp: Date.now() })
      } catch (e) { /* ignore */ }
      return NOOP_UNSUB
    },
    onBackendExit: function () { return NOOP_UNSUB },
    onPreviewFileChanged: function () { return NOOP_UNSUB },
    api: api,

    // ── hot but guarded: cheap honest stubs ────────────────────────────────
    setActiveConnectionRoute: function () { return Promise.resolve() },
    revalidateConnection: function () { return Promise.resolve({ ok: true, rebuilt: false }) },
    touchBackend: function () { return Promise.resolve({ ok: true }) },
    getPoolLimits: function () { return Promise.resolve({}) },
    sanitizeWorkspaceCwd: function (cwd) { return Promise.resolve(cwd) },
    notify: function () { return Promise.resolve(false) },
    openExternal: function (url) { window.open(url, '_blank', 'noopener'); return Promise.resolve(true) },
    writeClipboard: function (text) {
      try { return navigator.clipboard.writeText(text) } catch (e) { return Promise.resolve() }
    },
    onWindowStateChanged: function () { return NOOP_UNSUB },
    onPowerResume: function () { return NOOP_UNSUB },
    onConnectionApplied: function () { return NOOP_UNSUB },
    onPoolBackendRetiring: function () { return NOOP_UNSUB },
    connections: { onChanged: function () { return NOOP_UNSUB } },
    profile: {
      get: function () { return Promise.resolve({ profile: PROFILE }) },
      getDefault: function () { return Promise.resolve(null) },
      setDefault: function () { return Promise.resolve() },
      set: function () { return Promise.resolve() },
      remember: function () { return Promise.resolve() },
      onDefaultChanged: function () { return NOOP_UNSUB }
    },
    settings: {
      getDefaultProjectDir: function () { return Promise.resolve('') }
    }
  }

  Object.defineProperty(window, 'hermesDesktop', { value: desktop, configurable: false })

  // ── login hint overlay: static /desktop/ is unauthenticated, API is gated ─
  api({ path: '/api/auth/me' }).catch(function (e) {
    if (!e || e.statusCode !== 401) return
    var show = function () {
      var box = document.createElement('div')
      box.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;' +
        'align-items:center;justify-content:center;background:rgba(0,0,0,.85);color:#fff;' +
        'font:15px/1.5 system-ui;text-align:center'
      box.innerHTML = '<div><p style="font-size:18px;margin:0 0 10px">Dashboard-Login fehlt</p>' +
        '<p style="margin:0 0 16px;opacity:.75">Bitte einmal im Dashboard anmelden — die Session gilt auch hier.</p>' +
        '<a href="/login?next=%2Fdesktop%2F" style="color:#7aa2ff;font-weight:600">Jetzt anmelden →</a></div>'
      document.body.appendChild(box)
    }
    if (document.body) show()
    else document.addEventListener('DOMContentLoaded', show)
  })
})()
