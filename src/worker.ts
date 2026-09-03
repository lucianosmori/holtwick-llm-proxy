// Cloudflare Worker that proxies NPC chat requests from holtwick-voxel to
// Groq. The Groq API key is held in Cloudflare's secret store (set via
// `wrangler secret put GROQ_API_KEY` or the API) and never appears in the
// public game bundle.
//
// Default model: openai/gpt-oss-20b — Groq's documented generally-available
// replacement for llama-3.1-8b-instant after the 2026-08-16 free/developer
// shutdown. Confirm current IDs at https://console.groq.com/docs/models and
// https://console.groq.com/docs/deprecations before swapping GROQ_MODEL.
//
// Endpoint: POST /chat
// Body:    { npc: { id, name, role, barks_idle, barks_combat }, history, userMsg }
// Returns: text/event-stream of Groq SSE chunks (OpenAI-compatible format)

export interface Env {
  GROQ_API_KEY: string;
}

// Production Groq chat model on the free/developer tier. Do not revert to
// llama-3.1-8b-instant: Groq returns 404 model_not_found for that id.
export const GROQ_MODEL = "openai/gpt-oss-20b";
export const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
export const MAX_TOKENS = 200;
export const TEMPERATURE = 0.8;
export const HISTORY_TURN_CAP = 12;
export const WARM_TIMEOUT_MS = 4000;
export const SCHEDULED_TIMEOUT_MS = 5000;
const UPSTREAM_BODY_CAP = 400;

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

interface NpcShape {
  id: string;
  name: string;
  role: string;
  barks_idle: string[];
  barks_combat: string[];
}

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

interface ChatRequest {
  npc: NpcShape;
  history?: ChatTurn[];
  userMsg: string;
}

type GroqMessage = { role: "system" | "user" | "assistant"; content: string };

function corsJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function groqHeaders(apiKey: string): HeadersInit {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

// reasoning_effort "low" keeps NPC replies fast; include_reasoning false so
// the voxel client only sees the spoken line in the OpenAI-compatible stream.
// GPT-OSS does not support reasoning_format (see Groq reasoning docs).
function groqChatBody(
  messages: GroqMessage[],
  opts: { stream?: boolean; max_completion_tokens?: number; temperature?: number } = {},
): Record<string, unknown> {
  return {
    model: GROQ_MODEL,
    messages,
    temperature: opts.temperature ?? TEMPERATURE,
    max_completion_tokens: opts.max_completion_tokens ?? MAX_TOKENS,
    reasoning_effort: "low",
    include_reasoning: false,
    ...(opts.stream ? { stream: true } : {}),
  };
}

export function isModelNotFound(status: number, body: string): boolean {
  if (status !== 404 && status !== 400) return false;
  return /model_not_found|does not exist or you do not have access/i.test(body);
}

export function groqUpstreamError(status: number, errText: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    error: "groq upstream error",
    model: GROQ_MODEL,
    upstream_status: status,
    upstream_body: errText.slice(0, UPSTREAM_BODY_CAP),
  };
  if (isModelNotFound(status, errText)) {
    payload.code = "model_not_found";
  }
  return payload;
}

function buildSystemPrompt(npc: NpcShape): string {
  const idle = (npc.barks_idle ?? []).slice(0, 6).map((b) => `- "${b}"`).join("\n");
  const combat = (npc.barks_combat ?? []).slice(0, 4).map((b) => `- "${b}"`).join("\n");
  const parts = [
    `You are ${npc.name}, ${npc.role}. You live in the small voxel fantasy village of Holtwick.`,
    "Stay in character. Never mention being an AI, a model, or a chatbot.",
    "Reply in 1-2 short sentences. Match the tone of the lines below.",
    "",
    "Lines you sometimes mutter when idle:",
    idle || "- (silence)",
  ];
  if (combat) {
    parts.push("", "Lines you cry out when threatened:", combat);
  }
  return parts.join("\n");
}

function validate(body: unknown): ChatRequest | string {
  if (typeof body !== "object" || body === null) return "body must be an object";
  const b = body as Record<string, unknown>;
  if (typeof b.userMsg !== "string" || b.userMsg.length === 0) return "userMsg required";
  if (b.userMsg.length > 2000) return "userMsg too long";
  if (typeof b.npc !== "object" || b.npc === null) return "npc required";
  const n = b.npc as Record<string, unknown>;
  if (typeof n.id !== "string" || typeof n.name !== "string" || typeof n.role !== "string") {
    return "npc.{id,name,role} required";
  }
  if (!Array.isArray(n.barks_idle)) return "npc.barks_idle must be an array";
  return b as unknown as ChatRequest;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return corsJson(200, { ok: true, model: GROQ_MODEL });
    }
    // Warm path: fire a tiny non-streaming Groq request so the worker->Groq
    // TLS handshake + model selection is hot when the player sends their
    // first real /chat. Costs ~1 Groq request per warm (well inside free
    // tier). Returns 200 fast even if Groq is slow — never blocks dialog open.
    if (url.pathname === "/warm") {
      if (!env.GROQ_API_KEY) return corsJson(200, { ok: false, model: GROQ_MODEL, reason: "no key" });
      try {
        const r = await fetch(GROQ_URL, {
          method: "POST",
          headers: groqHeaders(env.GROQ_API_KEY),
          signal: AbortSignal.timeout(WARM_TIMEOUT_MS),
          body: JSON.stringify(
            groqChatBody([{ role: "user", content: "hi" }], {
              max_completion_tokens: 16,
              temperature: 0,
            }),
          ),
        });
        if (r.ok) return corsJson(200, { ok: true, model: GROQ_MODEL, upstream: r.status });
        const errText = await r.text();
        return corsJson(200, { ok: false, ...groqUpstreamError(r.status, errText) });
      } catch (e) {
        return corsJson(200, {
          ok: false,
          model: GROQ_MODEL,
          error: String((e as Error)?.message ?? e),
        });
      }
    }
    if (url.pathname !== "/chat") {
      return corsJson(404, { error: "not found", paths: ["/chat", "/health", "/warm"] });
    }
    if (request.method !== "POST") {
      return corsJson(405, { error: "POST only" });
    }
    if (!env.GROQ_API_KEY) {
      return corsJson(500, { error: "GROQ_API_KEY not configured" });
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return corsJson(400, { error: "invalid JSON" });
    }
    const parsed = validate(rawBody);
    if (typeof parsed === "string") {
      return corsJson(400, { error: parsed });
    }

    const history = (parsed.history ?? []).slice(-HISTORY_TURN_CAP);
    const messages: GroqMessage[] = [
      { role: "system", content: buildSystemPrompt(parsed.npc) },
      ...history.map((t) => ({ role: t.role, content: t.content })),
      { role: "user", content: parsed.userMsg },
    ];

    const groqRes = await fetch(GROQ_URL, {
      method: "POST",
      headers: groqHeaders(env.GROQ_API_KEY),
      body: JSON.stringify(groqChatBody(messages, { stream: true })),
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      return corsJson(groqRes.status, groqUpstreamError(groqRes.status, errText));
    }

    return new Response(groqRes.body, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  },

  // Cron-driven warmup. Runs every 5 minutes (see wrangler.toml [triggers]).
  // Fires a tiny Groq request so the worker->Groq TLS pipe stays hot
  // across isolate refreshes. ~12 Groq req/hour — well inside the free tier
  // (~1800 req/hour budget at 30 req/min).
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.GROQ_API_KEY) return;
    ctx.waitUntil(
      fetch(GROQ_URL, {
        method: "POST",
        headers: groqHeaders(env.GROQ_API_KEY),
        signal: AbortSignal.timeout(SCHEDULED_TIMEOUT_MS),
        body: JSON.stringify(
          groqChatBody([{ role: "user", content: "hi" }], {
            max_completion_tokens: 16,
            temperature: 0,
          }),
        ),
      }).catch(() => {}),
    );
  },
};
