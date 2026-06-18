# 📱 camera-broadcast → broadcast.mabelwallin.com

The **phone page** for a card-game tournament camera wall. Each table's phone
opens this site, taps **Go live**, and streams its camera over WebRTC to the
wall. Rear camera by default; keeps the screen awake while live.

The wall (and the WebRTC signaling) live in the companion repo
[`camera-feed`](https://github.com/maebowl/camera-feed) at
`live.mabelwallin.com`. This page connects its WebSocket to
`wss://live.mabelwallin.com/ws` — so **deploy `camera-feed` too** for this to do
anything.

> This is a static site (a Cloudflare Worker that just serves files). All the
> matchmaking happens on the wall side; video is peer-to-peer phone → wall.

## Deploy to Cloudflare

```bash
npm install
npx wrangler login        # once
npx wrangler deploy
```

`wrangler.toml` binds it to `broadcast.mabelwallin.com` (the `mabelwallin.com`
zone must be on this Cloudflare account). Delete the `routes = [...]` block to
use the free `*.workers.dev` URL, or set the domain in the dashboard. You can
also connect this repo for automatic deploys (**Workers & Pages → Connect to
Git**).

## Using it at the tournament

1. On each table's phone, open `broadcast.mabelwallin.com`.
2. Type the table name (or use `?table=3` to pre-fill).
3. Tap **Go live** and allow camera access. Prop the phone up facing the table.
4. The feed shows up on `live.mabelwallin.com` automatically.

**Flip camera** switches rear/front. Phones must be on **HTTPS** to use the
camera — your custom domain handles that automatically.

## Keep the feed alive

Phones pause the camera when the screen locks or you switch apps (iOS is strict
about this), which makes the feed go black on the wall (shown there as **"No
video — is the phone awake?"**). This page holds a screen **Wake Lock** while
live, but for long sessions also:

- Keep the broadcast page in the **foreground** (don't switch apps).
- Set the phone's **auto-lock** to a long interval (or Never).
- Keep the phone **plugged in**.

If feeds go black for some phones but not others, that's usually a *network*
issue (a direct connection is blocked) rather than the phone sleeping — the fix
is a TURN relay, configured on the wall side. See the
[`camera-feed`](https://github.com/maebowl/camera-feed) README → "Troubleshooting
black-screen feeds".

## Options

- Pre-fill a table name: `…?table=3`
- Separate event/walls: `…?room=finals` (must match the wall's `?room=finals`)
- Point at a different signaling host (e.g. local dev):
  `…?signal=http://localhost:8787`

## Tuning

Resolution, frame rate, and the per-feed bitrate cap (~1.2 Mbps) are set in
[`public/broadcast.js`](public/broadcast.js) — lower them if the wall machine
struggles with many feeds. Audio is off by default (set `audio: true` to enable).
