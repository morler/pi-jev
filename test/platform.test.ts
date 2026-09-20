import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { callJev, resolveCredential, resolvePlatform } from "../src/platform.js";
import { JevClient } from "../src/jev.js";
import type { QuestionConfig } from "../src/types.js";

const QUESTIONS: Record<string, QuestionConfig> = {
  is_billing: { type: "noul", instructions: "Billing?" },
};

/** Capture the request and answer with `payload` instead of hitting the network. */
function stubFetch(payload: unknown, capture: { url?: string; init?: any }): typeof fetch {
  return (async (url: any, init: any) => {
    capture.url = String(url);
    capture.init = init;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function setEnv(values: Record<string, string | undefined>): () => void {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test("resolvePlatform reads JEV_PLATFORM and falls back to typesafe", () => {
  const restore = setEnv({ JEV_PLATFORM: "openrouter" });
  try {
    assert.equal(resolvePlatform(), "openrouter");
    process.env.JEV_PLATFORM = "nonsense";
    assert.equal(resolvePlatform(), "typesafe");
  } finally {
    restore();
  }
  assert.equal(resolvePlatform(), "typesafe");
});

test("resolveCredential prefers the platform env var, then its secret file", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jev-home-"));
  const restore = setEnv({ HOME: home, OPENROUTER_API_KEY: undefined });
  try {
    assert.equal(resolveCredential("openrouter"), null);

    const secrets = path.join(home, ".pi", "agent", "secrets");
    fs.mkdirSync(secrets, { recursive: true });
    fs.writeFileSync(path.join(secrets, "openrouter_api_key"), "sk-or-file\n");

    const fromFile = resolveCredential("openrouter");
    assert.equal(fromFile?.key, "sk-or-file");
    assert.equal(fromFile?.source, "file");
    assert.equal(fromFile?.origin, "~/.pi/agent/secrets/openrouter_api_key");

    process.env.OPENROUTER_API_KEY = "sk-or-env";
    assert.equal(resolveCredential("openrouter")?.key, "sk-or-env");
  } finally {
    restore();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("openrouter posts the direct systemone body", async () => {
  const capture: { url?: string; init?: any } = {};
  const fetchImpl = stubFetch(
    {
      model: "typesafe/jev-1.13",
      answers: { is_billing: { type: "noul", noul: 0.9 } },
      usage: { input_tokens: 5, output_tokens: 2 },
    },
    capture
  );

  const res = await callJev("openrouter", "sk-or", {
    state: { text: "hi" },
    questions: QUESTIONS,
    model: "typesafe/jev-1.13",
    fetch: fetchImpl,
  });

  assert.equal(capture.url, "https://openrouter.ai/api/alpha/decisions");
  assert.equal(capture.init.headers.authorization, "Bearer sk-or");
  assert.deepEqual(JSON.parse(capture.init.body), {
    model: "typesafe/jev-1.13",
    state: { text: "hi" },
    questions: QUESTIONS,
  });
  assert.equal((res.answers.is_billing as any).noul, 0.9);
  assert.equal(res.usage?.totalTokens, 7);
});

test("cloudflare unwraps the AI Gateway envelope and sends gateway headers", async () => {
  const accountId = "a".repeat(32);
  const restore = setEnv({ CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_GATEWAY_ID: "gw" });
  try {
    const capture: { url?: string; init?: any } = {};
    const fetchImpl = stubFetch(
      {
        success: true,
        result: { state: "Completed", result: { answers: { is_billing: { type: "noul", noul: 0.4 } } } },
      },
      capture
    );

    const res = await callJev("cloudflare", "cf-token", {
      state: "hi",
      questions: QUESTIONS,
      model: "typesafe/jev",
      fetch: fetchImpl,
    });

    assert.equal(
      capture.url,
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`
    );
    assert.equal(capture.init.headers["cf-aig-gateway-id"], "gw");
    assert.equal(capture.init.headers["cf-aig-skip-cache"], "true");
    assert.deepEqual(JSON.parse(capture.init.body), {
      model: "typesafe/jev",
      input: { state: "hi", questions: QUESTIONS },
    });
    assert.equal((res.answers.is_billing as any).noul, 0.4);
  } finally {
    restore();
  }
});

test("cloudflare reports missing account or gateway configuration", async () => {
  const restore = setEnv({ CLOUDFLARE_ACCOUNT_ID: undefined, CLOUDFLARE_GATEWAY_ID: undefined });
  try {
    await assert.rejects(
      callJev("cloudflare", "cf-token", {
        state: "hi",
        questions: QUESTIONS,
        model: "typesafe/jev",
        fetch: stubFetch({}, {}),
      }),
      /CLOUDFLARE_ACCOUNT_ID/
    );
  } finally {
    restore();
  }
});

test("vercel posts to the gateway evaluation endpoint", async () => {
  const capture: { url?: string; init?: any } = {};
  const fetchImpl = stubFetch(
    {
      answers: { is_billing: { type: "boolean", probability: 0.75 } },
      usage: { inputTokens: 11, outputTokens: 3 },
      providerMetadata: { typesafe: { confidence: { is_billing: 0.81 } } },
    },
    capture
  );

  const res = await callJev("vercel", "gw-key", {
    state: "hi",
    questions: QUESTIONS,
    model: "typesafe-ai/jev",
    fetch: fetchImpl,
  });

  assert.equal(capture.url, "https://ai-gateway.vercel.sh/v4/ai/evaluation-model");
  assert.equal(capture.init.headers.authorization, "Bearer gw-key");
  assert.equal(capture.init.headers["ai-model-id"], "typesafe-ai/jev");
  assert.equal(capture.init.headers["ai-gateway-protocol-version"], "0.0.1");
  assert.equal(capture.init.headers["ai-gateway-auth-method"], "api-key");
  // The gateway rejects TypeSafe's "noul" question type; it expects "boolean".
  assert.equal(JSON.parse(capture.init.body).questions.is_billing.type, "boolean");
  assert.equal(capture.init.headers["ai-evaluation-model-specification-version"], "4");
  assert.equal((res.answers.is_billing as any).probability, 0.75);
  assert.equal(res.usage?.totalTokens, 14);
  assert.equal(res.confidence?.is_billing, 0.81);
});

test("JevClient routes evaluate through the selected platform and maps gateway answers", async () => {
  const restoreEnv = setEnv({
    JEV_PLATFORM: "vercel",
    AI_GATEWAY_API_KEY: "gw-key",
    JEV_MODEL: undefined,
  });
  const originalFetch = globalThis.fetch;
  const capture: { url?: string; init?: any } = {};
  globalThis.fetch = stubFetch(
    {
      answers: {
        is_billing: { type: "boolean", probability: 0.62 },
        category: { type: "choice", choice: "billing", probabilities: { billing: 0.7, bug: 0.3 } },
      },
      usage: { inputTokens: 9, outputTokens: 4 },
      providerMetadata: { typesafe: { confidence: { is_billing: 0.5, category: 0.55 } } },
    },
    capture
  );

  try {
    const client = new JevClient();
    assert.equal(client.platform, "vercel");
    assert.equal(client.isConfigured(), true);

    const res = await client.evaluate({
      state: "Payment failed: card expired",
      questions: {
        is_billing: { type: "noul", instructions: "Billing issue?" },
        category: {
          type: "choice",
          instructions: "Which category?",
          criteria: { billing: "Card issues", bug: "Software bug" },
        },
      },
    });

    assert.equal(capture.url, "https://ai-gateway.vercel.sh/v4/ai/evaluation-model");
    const sentQuestions = JSON.parse(capture.init.body).questions;
    assert.equal(sentQuestions.is_billing.type, "boolean");
    assert.equal(sentQuestions.category.type, "choice");
    assert.equal(res.answers.is_billing.value, 0.62);
    assert.equal(res.answers.category.value, "billing");
    assert.equal(res.answers.category.confidence, 0.55);
    assert.deepEqual(res.answers.category.distribution, { billing: 0.7, bug: 0.3 });
    assert.equal(res.model, "typesafe-ai/jev");
    assert.equal(client.stats.requestsCount, 1);
    assert.equal(client.stats.totalTokens, 13);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test("JevClient fails clearly when the platform has no credential", async () => {
  const restore = setEnv({ JEV_PLATFORM: "openrouter", OPENROUTER_API_KEY: undefined, HOME: os.tmpdir() });
  try {
    const client = new JevClient();
    assert.equal(client.isConfigured(), false);
    await assert.rejects(() => client.evaluate({ state: "x", questions: QUESTIONS }), /openrouter/);
  } finally {
    restore();
  }
});
