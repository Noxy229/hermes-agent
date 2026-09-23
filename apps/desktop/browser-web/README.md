# Hermes Desktop UI in the browser (`desktop-web`)

Runs the **native desktop app's React UI** in a plain web browser, served by
the existing `hermes dashboard` — no Electron, no separate product.

The desktop renderer hard-requires `window.hermesDesktop` (Electron preload's
IPC bridge). This folder provides that bridge as a plain-JS shim against the
same-origin dashboard backend, which already speaks the exact HTTP/WS surface
(`hermes serve` and `hermes dashboard` are the same code path in 0.21.4):

- REST (`hermesDesktop.api`) → `fetch(path, {credentials:'include'})` with the dashboard session cookie
- Gateway WS → `POST /api/auth/ws-ticket` (single-use, 30 s TTL) → `wss://<host>/api/ws?ticket=…`, re-minted on every connect (the renderer does this via `getGatewayWsUrl()` because we advertise `authMode:'oauth'`)
- Everything else → honest stubs; the renderer `?.`-guards those paths ("plain-browser mode" per its own code comments)

## Deploy (works with this repo install + nginx)

```bash
# 1. Build the renderer statically (from a full npm install checkout — the
#    runtime install's root node_modules may be partial; a copy works):
cd apps/desktop && node ../../node_modules/vite/bin/vite.js build --base=/desktop/
#    (gotchas: NODE_ENV=development for npm ci; ELECTRON_SKIP_BINARY_DOWNLOAD=1)

# 2. Serve: point an nginx location at the built dist, before `location /`:
#    location /desktop/ { alias <dist>/; index index.html; }
#    (HashRouter → no history fallback needed; keep the trailing slash —
#     emojibase data is fetched via relative ./emojibase/ paths.)

# 3. Inject the shim into <dist>/index.html BEFORE the module entry:
#    <script src="/desktop/desktop-shim.js"></script>
```

Then sign in to the dashboard once and open `https://<host>/desktop/`.

## Verified (2026-09-23, Hermes 0.21.4)

Behind nginx + Cloudflare Tunnel: login 200, UI boots, `wss://…/api/ws`
connects with `gateway.ready`, session list + full transcript render live
(real sessions), zero pageerrors.

## Status / limits

- Attachments upload over the WS RPC (`image.attach` etc.) — untested UI flows like drag-drop files may hit stubbed bridge calls.
- Native-only surfaces (tray, HUD, pet overlay, window translucency, auto-update) are stub `false`/no-ops by design.
- The shim is auth-mode `oauth` on purpose: gated mode rejects cached `?token=` URLs, and tickets must be fresh per dial.
