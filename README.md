# Orca Bot Talent Market (`orca-bot-market`)

Lightweight catalog API (**Cloudflare Workers + D1**) and static CDN fallback mirror (**GitHub + jsDelivr**) powering the **Talent Market** inside [Bot Office](https://github.com/TornadoDai/orca-bot-office).

> **Zero Bot-package hosting**: Every Bot package itself is hosted and secret-scanned natively by Orca Cloud (`https://app.orca.dev/bots/share/<shareId>`). This service stores only public catalog metadata (name, pitch, tags, mascot/emoji, counts) and enforces strict `shareId` validation.

## Quick Deploy (Cloudflare Free Tier)

```bash
npx wrangler login
chmod +x deploy.sh
./deploy.sh
```

Optionally set an admin token (for granting `verified` / `featured` badges or removing listings):

```bash
npx wrangler secret put ADMIN_TOKEN
```

## API Endpoints

- `GET /api/bots?q=&category=&sort=hot|likes|newest|verified&limit=60` — List active Bots + stats + caller's liked state
- `POST /api/bots` — Publish a shared Orca Bot (validates `shareId`, probes liveness on `app.orca.dev`, IP rate-limited)
- `POST /api/bots/:id/like` — Idempotent toggle like per `X-Client-Id`
- `POST /api/bots/:id/hire` — Daily-deduped hire click counter
- `POST /api/bots/:id/report` — Report dead/spam listing (auto-hides at 3 distinct reports)
- `POST /api/admin/bots/:id` — Admin update (`Authorization: Bearer <ADMIN_TOKEN>`) for `trust`, `featured`, `status`

## Local Tests

```bash
npm test
```
