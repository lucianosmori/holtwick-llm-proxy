import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import worker, {
  CORS_HEADERS,
  GROQ_MODEL,
  GROQ_URL,
  WARM_TIMEOUT_MS,
  SCHEDULED_TIMEOUT_MS,
  groqUpstreamError,
  isModelNotFound,
} from "../src/worker.ts";

const RETIRED_GROQ_MODELS = [
  "llama-3.1-8b-instant",
  "llama-3.3-70b-versatile",
  "llama3-8b-8192",
  "llama3-70b-8192",
  "gemma2-9b-it",
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "qwen/qwen3-32b",
];

const MODEL_NOT_FOUND_BODY = JSON.stringify({
  error: {
    message: `The model \`${GROQ_MODEL}\` does not exist or you do not have access to it.`,
    type: "invalid_request_error",
    code: "model_not_found",
  },
});

const CHAT_BODY = {
  npc: {
    id: "edda",
    name: "Edda the Innkeeper",
    role: "innkeeper of the Holtwick tavern",
    barks_idle: ["Welcome to the Holtwick tavern, traveler."],
    barks_combat: ["Out of my tavern!"],
  },
  userMsg: "what's on tap tonight?",
};

const env = { GROQ_API_KEY: "test-key-not-a-secret" };

let originalFetch: typeof fetch;
let groqCalls: Array<{ url: string; init?: RequestInit }>;
let groqHandler: (url: string, init?: RequestInit) => Promise<Response>;

beforeEach(() => {
  groqCalls = [];
  originalFetch = globalThis.fetch;
  groqHandler = async () => new Response("unexpected", { status: 500 });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    groqCalls.push({ url, init });
    return groqHandler(url, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function corsOk(res: Response) {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    assert.equal(res.headers.get(key), value, `missing CORS header ${key}`);
  }
}

test("GROQ_MODEL is Groq's GA llama-3.1-8b-instant replacement, not a retired id", () => {
  assert.equal(GROQ_MODEL, "openai/gpt-oss-20b");
  assert.equal(RETIRED_GROQ_MODELS.includes(GROQ_MODEL), false);
});

test("isModelNotFound recognizes Groq's retirement 404 payload", () => {
  assert.equal(isModelNotFound(404, MODEL_NOT_FOUND_BODY), true);
  assert.equal(isModelNotFound(200, MODEL_NOT_FOUND_BODY), false);
  assert.equal(isModelNotFound(502, "bad gateway"), false);
});

test("GET /health reports the configured model and CORS", async () => {
  const res = await worker.fetch(new Request("https://worker.test/health"), env);
  assert.equal(res.status, 200);
  corsOk(res);
  assert.deepEqual(await res.json(), { ok: true, model: GROQ_MODEL });
  assert.equal(groqCalls.length, 0);
});

test("OPTIONS preflight preserves CORS and does not call Groq", async () => {
  const res = await worker.fetch(
    new Request("https://worker.test/chat", { method: "OPTIONS" }),
    env,
  );
  assert.equal(res.status, 204);
  corsOk(res);
  assert.equal(groqCalls.length, 0);
});

test("GET /warm on Groq model_not_found stays HTTP 200 but surfaces model + code", async () => {
  groqHandler = async () =>
    new Response(MODEL_NOT_FOUND_BODY, { status: 404, headers: { "Content-Type": "application/json" } });

  const res = await worker.fetch(new Request("https://worker.test/warm"), env);
  assert.equal(res.status, 200);
  corsOk(res);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.ok, false);
  assert.equal(body.model, GROQ_MODEL);
  assert.equal(body.upstream_status, 404);
  assert.equal(body.code, "model_not_found");
  assert.match(String(body.upstream_body), /model_not_found/);
  assert.equal(groqCalls.length, 1);
  assert.equal(groqCalls[0].url, GROQ_URL);
  const sent = JSON.parse(String(groqCalls[0].init?.body));
  assert.equal(sent.model, GROQ_MODEL);
  assert.equal(sent.reasoning_effort, "low");
  assert.equal(sent.include_reasoning, false);
});

test("GET /warm uses a 4s AbortSignal timeout", async () => {
  groqHandler = async (_url, init) => {
    assert.ok(init?.signal, "warm request must pass an AbortSignal");
    return new Response("{}", { status: 200 });
  };
  const origTimeout = AbortSignal.timeout;
  const seen: number[] = [];
  AbortSignal.timeout = ((ms: number) => {
    seen.push(ms);
    return origTimeout(ms);
  }) as typeof AbortSignal.timeout;
  try {
    const res = await worker.fetch(new Request("https://worker.test/warm"), env);
    assert.equal(res.status, 200);
    assert.deepEqual(seen, [WARM_TIMEOUT_MS]);
  } finally {
    AbortSignal.timeout = origTimeout;
  }
});

test("GET /warm timeout/network errors stay HTTP 200 with model and CORS", async () => {
  groqHandler = async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  };
  const res = await worker.fetch(new Request("https://worker.test/warm"), env);
  assert.equal(res.status, 200);
  corsOk(res);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.ok, false);
  assert.equal(body.model, GROQ_MODEL);
  assert.match(String(body.error), /timeout|aborted/i);
});

test("POST /chat on Groq model_not_found returns upstream 404 with diagnostic fields", async () => {
  groqHandler = async () =>
    new Response(MODEL_NOT_FOUND_BODY, { status: 404, headers: { "Content-Type": "application/json" } });

  const res = await worker.fetch(
    new Request("https://worker.test/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(CHAT_BODY),
    }),
    env,
  );
  assert.equal(res.status, 404);
  corsOk(res);
  assert.equal(res.headers.get("Content-Type"), "application/json");
  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(body, groqUpstreamError(404, MODEL_NOT_FOUND_BODY));
  assert.equal(body.code, "model_not_found");
  assert.equal(body.model, GROQ_MODEL);
  const sent = JSON.parse(String(groqCalls[0].init?.body));
  assert.equal(sent.model, GROQ_MODEL);
  assert.equal(sent.stream, true);
  assert.equal(sent.reasoning_effort, "low");
});

test("POST /chat success streams Groq SSE and preserves CORS", async () => {
  groqHandler = async () =>
    new Response("data: {\"choices\":[{\"delta\":{\"content\":\"Stew's hot.\"}}]}\n\n", {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  const res = await worker.fetch(
    new Request("https://worker.test/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(CHAT_BODY),
    }),
    env,
  );
  assert.equal(res.status, 200);
  corsOk(res);
  assert.equal(res.headers.get("Content-Type"), "text/event-stream");
  assert.match(await res.text(), /Stew's hot/);
});

test("scheduled warmup uses the configured model and 5s timeout", async () => {
  const origTimeout = AbortSignal.timeout;
  const seen: number[] = [];
  AbortSignal.timeout = ((ms: number) => {
    seen.push(ms);
    return origTimeout(ms);
  }) as typeof AbortSignal.timeout;
  groqHandler = async () => new Response("{}", { status: 200 });
  const pending: Promise<unknown>[] = [];
  try {
    await worker.scheduled(
      {} as ScheduledEvent,
      env,
      {
        waitUntil(p: Promise<unknown>) {
          pending.push(p);
        },
        passThroughOnException() {},
      } as ExecutionContext,
    );
    await Promise.all(pending);
    assert.deepEqual(seen, [SCHEDULED_TIMEOUT_MS]);
    assert.equal(groqCalls.length, 1);
    const sent = JSON.parse(String(groqCalls[0].init?.body));
    assert.equal(sent.model, GROQ_MODEL);
  } finally {
    AbortSignal.timeout = origTimeout;
  }
});
