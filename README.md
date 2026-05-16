# holtwick-llm-proxy

Tiny Cloudflare Worker that proxies NPC chat requests from [holtwick-voxel](https://github.com/lucianosmori/holtwick-voxel) (and any other poc-fiesta game) to Groq's `llama-3.1-8b-instant`. The Groq API key lives in Cloudflare's secret store — never in the public game bundle.

**Live:** https://holtwick-llm.lucianosmori.workers.dev

## Why

The browser-side WebLLM path in holtwick-voxel needs WebGPU, which most mobile browsers and Firefox don't support yet. This worker is the cross-browser fallback: same OpenAI-compatible chat surface, no client-side model download, runs on Cloudflare's free tier (100k req/day) using Groq's free tier (rate-limited but plenty for hobby).

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

### `GET /health`

Returns `{ ok: true, model: "llama-3.1-8b-instant" }`. Useful for uptime monitoring.

## Deploy

Prereqs:
- `CLOUDFLARE_API_TOKEN` env var (or `~/.cloudflare-token` and `export CLOUDFLARE_API_TOKEN=$(cat ~/.cloudflare-token)`)
- Groq API key from https://console.groq.com (free tier; saved as `~/.groq-token` matching the `~/.pixellab-token` pattern)

```bash
npm install
npm run deploy

# Set the Groq key as a Cloudflare secret (one-time):
echo "$(cat ~/.groq-token)" | npx wrangler secret put GROQ_API_KEY
```

## Reusing for other POCs

The Worker is generic — any NPC chat using the OpenAI-compatible message shape works. To reuse for `calles-de-alberdi` or another game: point that game's chat module at `https://holtwick-llm.lucianosmori.workers.dev/chat` and POST the same body shape with that game's NPCs.

To swap the model (e.g. Groq drops a faster Llama version, or you switch to Anthropic): change `GROQ_MODEL` + `GROQ_URL` in `src/worker.ts` and re-deploy. Or fork the worker per POC if needs diverge.

## Cost

| Layer | Plan | Free quota |
|---|---|---|
| Cloudflare Workers | Free | 100k req/day, 10ms CPU per req |
| Groq inference | Free | Rate-limited (~30 req/min) but generous for hobby |

Personal demo traffic (a few hundred chats/day max) sits well inside both free tiers. Total monthly cost: **$0**.

## License

MIT.
