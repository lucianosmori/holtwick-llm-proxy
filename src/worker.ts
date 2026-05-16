// Cloudflare Worker that proxies NPC chat requests from holtwick-voxel to
// Groq's Llama-3.1-8B-Instant. The Groq API key is held in Cloudflare's
// secret store (set via `wrangler secret put GROQ_API_KEY` or the API)
// and never appears in the public game bundle.
//
// Endpoint: POST /chat
// Body:    { npc: { id, name, role, barks_idle, barks_combat }, history, userMsg }
// Returns: text/event-stream of Groq SSE chunks (OpenAI-compatible format)

export interface Env {
  GROQ_API_KEY: string;
}

const GROQ_MODEL = "llama-3.1-8b-instant";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MAX_TOKENS = 200;
const TEMPERATURE = 0.8;
const HISTORY_TURN_CAP = 12;

const CORS_HEADERS: Record<string, string> = {
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

function corsJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
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
    if (url.pathname !== "/chat") {
      return corsJson(404, { error: "not found", paths: ["/chat", "/health"] });
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
    const messages = [
      { role: "system" as const, content: buildSystemPrompt(parsed.npc) },
      ...history.map((t) => ({ role: t.role, content: t.content })),
      { role: "user" as const, content: parsed.userMsg },
    ];

    const groqRes = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
        stream: true,
        temperature: TEMPERATURE,
        max_tokens: MAX_TOKENS,
      }),
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      return corsJson(groqRes.status, {
        error: "groq upstream error",
        upstream_status: groqRes.status,
        upstream_body: errText.slice(0, 400),
      });
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
};
