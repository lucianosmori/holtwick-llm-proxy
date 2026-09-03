# holtwick-llm-proxy

Tiny Cloudflare Worker that proxies NPC chat requests from [holtwick-voxel](https://github.com/lucianosmori/holtwick-voxel) (and any other poc-fiesta game) to Groq's `openai/gpt-oss-20b`. The Groq API key lives in Cloudflare's secret store — never in the public game bundle.

**Live:** https://holtwick-llm.lucianosmori.workers.dev

## Why

The browser-side WebLLM path in holtwick-voxel needs WebGPU, which most mobile browsers and Firefox don't support yet. This worker is the cross-browser fallback: same OpenAI-compatible chat surface, no client-side model download, runs on Cloudflare's free tier (100k req/day) using Groq's free tier (rate-limited but plenty for hobby).

`openai/gpt-oss-20b` is Groq's documented generally-available replacement for `llama-3.1-8b-instant` after that model's 2026-08-16 shutdown on the free/developer tier. Confirm current production IDs at [Supported Models](https://console.groq.com/docs/models) and [Deprecations](https://console.groq.com/docs/deprecations) before changing `GROQ_MODEL` in `src/worker.ts`.

## Endpoints

### `POST /chat`

Streams a Server-Sent-Events response back to the browser in the OpenAI delta format Groq already emits.

**Request body:**
```json
{
  "npc": {
    "id": "edda",
    "name": "Edda the Innkeeper",
    "role": "innkeeper of the Holtwick tavern",
    "barks_idle": ["Welcome to the Holtwick tavern, traveler.", "..."],
    "barks_combat": ["Out of my tavern!"]
  },
  "history": [
    { "role": "user", "content": "hi" },
    { "role": "assistant", "content": "Stew's hot." }
  ],
  "userMsg": "what's on tap tonight?"
}
```

Validation: `userMsg` required (≤2000 chars), `npc.{id,name,role,barks_idle}` required. History capped at last 12 turns server-side regardless of what the client sends.

If Groq rejects the configured model (HTTP 404 `model_not_found`), `/chat` returns that upstream status as JSON with `error`, `model`, `upstream_status`, `upstream_body`, and `code: "model_not_found"` so a future retirement is obvious. CORS headers are always present.

### `GET /health`

Returns `{ ok: true, model: "openai/gpt-oss-20b" }`. Worker liveness only — it does not call Groq. Useful for uptime monitoring.

### `GET /warm`

Fires a tiny Groq completion so the worker→Groq TLS pipe is hot before the first `/chat`. Always returns HTTP 200 (so dialog open is never blocked) within a 4s timeout:

- success: `{ ok: true, model, upstream }`
- Groq error: `{ ok: false, error, model, upstream_status, upstream_body, code? }`
- timeout / network: `{ ok: false, model, error }`

A Groq model retirement shows up here as `ok: false` + `code: "model_not_found"` even though the HTTP status stays 200.

## Deploy

Prereqs:
- `CLOUDFLARE_API_TOKEN` env var (or `~/.cloudflare-token` and `export CLOUDFLARE_API_TOKEN=$(cat ~/.cloudflare-token)`)
- Groq API key from https://console.groq.com (free tier; saved as `~/.groq-token` matching the `~/.pixellab-token` pattern)

```bash
npm install
npm test
npm run typecheck
npm run deploy

# Set the Groq key as a Cloudflare secret (one-time):
echo "$(cat ~/.groq-token)" | npx wrangler secret put GROQ_API_KEY
```

The existing `GROQ_API_KEY` secret does not need to be rotated for a model ID change. After merging, deploy this worker (`npm run deploy`) so live `/warm` and `/chat` pick up `openai/gpt-oss-20b`.

## Reusing for other POCs

The Worker is generic — any NPC chat using the OpenAI-compatible message shape works. To reuse for `calles-de-alberdi` or another game: point that game's chat module at `https://holtwick-llm.lucianosmori.workers.dev/chat` and POST the same body shape with that game's NPCs.

To swap the model (e.g. Groq drops a faster production chat model, or you switch to Anthropic): change `GROQ_MODEL` + `GROQ_URL` in `src/worker.ts` and re-deploy. Or fork the worker per POC if needs diverge. `npm test` fails if `GROQ_MODEL` is set back to a known-retired Groq id.

## Cost

| Layer | Plan | Free quota |
|---|---|---|
| Cloudflare Workers | Free | 100k req/day, 10ms CPU per req |
| Groq inference | Free | Rate-limited (~30 req/min on `openai/gpt-oss-20b`) but generous for hobby |

Personal demo traffic (a few hundred chats/day max) sits well inside both free tiers. Total monthly cost: **$0**.

## License

MIT.
