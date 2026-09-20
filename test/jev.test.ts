import test from "node:test";
import assert from "node:assert/strict";
import { JevClient, noulProbability } from "../src/jev.js";

function setEnv(patch: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(patch)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test("noulProbability reads the provider's own answer and nothing else", () => {
  assert.equal(noulProbability({ noul: 0.8 }), 0.8);
  assert.equal(noulProbability({ probability: 0.6 }), 0.6);
  assert.equal(noulProbability({ value: 0.4 }), 0.4);
  assert.equal(noulProbability({ noul: "0.7" }), 0.7, "a numeric string still counts");
  assert.equal(noulProbability({ noul: 0 }), 0, "a real zero is a real answer");

  for (const junk of [null, undefined, "", [], false, {}, { noul: null }, { noul: "no" }, { noul: Number.NaN }]) {
    assert.equal(noulProbability(junk), null, `${JSON.stringify(junk)} is not an answer`);
  }
});

test("an answer the provider omitted reports 0, but stays distinguishable through raw", async () => {
  const originalFetch = globalThis.fetch;
  const restoreEnv = setEnv({ JEV_PLATFORM: "openrouter", OPENROUTER_API_KEY: "sk-or-test" });
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ answers: { keep_x: { type: "noul" } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  try {
    const res = await new JevClient().evaluate({
      state: "s",
      questions: { keep_x: { type: "noul", instructions: "Keep?" } },
    });

    assert.equal(res.answers.keep_x.value, 0, "the reporting value falls back to 0");
    assert.equal(noulProbability(res.answers.keep_x.raw), null, "the distinction survives in raw");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});
