import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { classifyModelError, AutoModelRouter } from "../src/model-router.js";
import type { JevClient } from "../src/jev.js";
import type { JevEvaluationResponse } from "../src/types.js";

type TestModel = Model<"openai-completions">;

const POOL = ["glm-5.5-flash", "deepseek-v4-flash"];

const model = (id: string, extra: Partial<TestModel> = {}): TestModel =>
  ({
    id, provider: "test", name: id, api: "openai-completions", baseUrl: "", reasoning: false,
    input: ["text"], cost: { input: 1, output: 1 }, contextWindow: 128000, maxTokens: 4096, ...extra,
  }) as unknown as TestModel;

const stubPi = (onSetModel: () => void): ExtensionAPI =>
  ({ setModel: async () => onSetModel() }) as unknown as ExtensionAPI;

const stubCtx = (current: TestModel, available: TestModel[]): ExtensionContext =>
  ({
    model: current,
    modelRegistry: { getAvailable: () => available },
    getSystemPrompt: () => "",
  }) as unknown as ExtensionContext;

/** Jev client stub answering the strong_model noul question with a fixed probability; counts evaluate() calls. */
const stubJev = (answer: number | "fail" | "unconfigured"): { client: JevClient; calls: () => number } => {
  let count = 0;
  // SAFETY: fixture only shapes the two members the router touches.
  const client = {
    isConfigured: () => answer !== "unconfigured",
    evaluate: async (): Promise<JevEvaluationResponse> => {
      count++;
      if (answer === "fail") throw new Error("jev down");
      return { answers: { strong_model: { value: answer } } } as unknown as JevEvaluationResponse;
    },
  } as unknown as JevClient;
  return { client, calls: () => count };
};

test("classifies provider limit errors", () => {
  assert.equal(classifyModelError(new Error("429 rate limit")), "rate-limit");
  assert.equal(classifyModelError(new Error("context window exceeded")), "context-limit");
  assert.equal(classifyModelError(new Error("quota exceeded")), "quota");
});

test("tier thresholds sit exactly on HEAVY_P and LIGHT_P", async () => {
  const flash = model("glm-5.5-flash");
  const strong = model("deepseek-v4-flash", { reasoning: true });
  let selected = 0;
  const pi = stubPi(() => { selected++; });
  const ctx = stubCtx(flash, [flash, strong]);

  const atHeavy = new AutoModelRouter(pi, true, POOL, stubJev(0.6).client);
  assert.equal((await atHeavy.route("plan a migration", ctx)).tier, "heavy");

  const atLight = new AutoModelRouter(pi, true, POOL, stubJev(0.3).client);
  const light = await atLight.route("hi, list files", stubCtx(strong, [flash, strong]));
  assert.equal(light.tier, "light");
  assert.equal(selected, 2);

  const justAboveLight = new AutoModelRouter(pi, true, POOL, stubJev(0.31).client);
  const kept = await justAboveLight.route("hi, list files", ctx);
  assert.equal(kept.changed, false);
  assert.equal(kept.skipped, "no-judgment");
});

test("Jev probability routes heavy and light tiers to the pool", async () => {
  let selected = 0;
  const flash = model("glm-5.5-flash");
  const strong = model("deepseek-v4-flash", { reasoning: true });
  const { client: heavyJev } = stubJev(0.9);
  const router = new AutoModelRouter(stubPi(() => { selected++; }), true, POOL, heavyJev);
  const ctx = stubCtx(flash, [flash, strong]);

  const heavy = await router.route("plan a safe migration", ctx);
  assert.equal(heavy.tier, "heavy");
  assert.equal(heavy.model?.id, "deepseek-v4-flash");
  assert.equal(selected, 1);

  // Ambiguous probability (coin flip): keep the current model.
  const unsure = new AutoModelRouter(stubPi(() => { selected++; }), true, POOL, stubJev(0.4).client);
  const kept = await unsure.route("plan a safe migration", ctx);
  assert.equal(kept.changed, false);
  assert.equal(kept.skipped, "no-judgment");

  // Low probability: switch down to the light pool model.
  const down = new AutoModelRouter(stubPi(() => { selected++; }), true, POOL, stubJev(0.05).client);
  const light = await down.route("hi, list files", ctx);
  assert.equal(light.tier, "light");
  assert.equal(light.model?.id, "glm-5.5-flash");
});

test("image turns judge by prompt; capability filters the light pick", async () => {
  let selected = 0;
  const flash = model("glm-5.5-flash");
  const vision = model("vision-model", { input: ["text", "image"] });
  const { client: jev, calls } = stubJev(0.05); // says light
  const router = new AutoModelRouter(stubPi(() => { selected++; }), true, ["glm-5.5-flash", "vision-model"], jev);
  // Light entry cannot take images: no match, stay on the current model.
  const kept = await router.route("inspect this", stubCtx(flash, [flash, vision]), { hasImages: true });
  assert.equal(kept.changed, false);
  assert.equal(kept.skipped, "no-model");
  assert.equal(selected, 0);
  assert.equal(calls(), 1);

  // Multimodal light entry: the switch happens on the Jev verdict alone.
  const lite = model("vision-lite", { input: ["text", "image"] });
  const big = model("vision-heavy", { input: ["text", "image"] });
  const mmRouter = new AutoModelRouter(stubPi(() => { selected++; }), true, ["vision-lite", "vision-heavy"], stubJev(0.05).client);
  const down = await mmRouter.route("inspect this", stubCtx(big, [big, lite]), { hasImages: true });
  assert.equal(down.tier, "light");
  assert.equal(down.model?.id, "vision-lite");
  assert.equal(selected, 1);
});

test("every failure path keeps the current model", async () => {
  const flash = model("glm-5.5-flash");
  const strong = model("deepseek-v4-flash");
  const failing = new AutoModelRouter(stubPi(() => { throw new Error("must not switch"); }), true, POOL, stubJev("fail").client);
  const failed = await failing.route("plan a safe migration", stubCtx(flash, [flash, strong]));
  assert.equal(failed.changed, false);
  assert.equal(failed.skipped, "no-judgment");
  assert.ok(failed.reason.includes("Jev classification failed"));

  const unconfigured = new AutoModelRouter(stubPi(() => { throw new Error("must not switch"); }), true, POOL, stubJev("unconfigured").client);
  const off = await unconfigured.route("plan a safe migration", stubCtx(flash, [flash, strong]));
  assert.equal(off.skipped, "unconfigured");

  const absent = new AutoModelRouter(stubPi(() => { throw new Error("must not switch"); }), true, ["glm-5.5-flash", "missing-heavy"], stubJev(0.9).client);
  const noModel = await absent.route("plan a safe migration", stubCtx(flash, [flash]));
  assert.equal(noModel.changed, false);
  assert.equal(noModel.skipped, "no-model");
});

test("provider-prefixed entries never match another provider's same-named id", async () => {
  const cn = model("MiniMax-M3", { provider: "minimax-cn" });
  const hf = model("MiniMaxAI/MiniMax-M3", { provider: "huggingface" });
  const router = new AutoModelRouter(stubPi(() => { throw new Error("must not switch"); }), true, ["minimax-cn/MiniMax-M3", "zai-coding-cn/glm-5.3-flash"], stubJev(0.05).client);
  const result = await router.route("hi, list files", stubCtx(cn, [cn, hf]));
  assert.equal(result.model?.provider, "minimax-cn");
  assert.equal(result.changed, false); // already current; the HF lookalike must not be picked
});

test("provider-pinned entries match exactly, never a same-provider variant", async () => {
  const exact = model("glm-5.3-flash", { provider: "zai-coding-cn" });
  const plus = model("glm-5.3-flash-plus", { provider: "zai-coding-cn" });
  let selected = 0;
  const router = new AutoModelRouter(stubPi(() => { selected++; }), true, ["minimax-cn/MiniMax-M3", "zai-coding-cn/glm-5.3-flash"], stubJev(0.9).client);
  const result = await router.route("plan a refactor review", stubCtx(plus, [plus, exact]));
  assert.equal(result.model?.id, "glm-5.3-flash");
  assert.equal(selected, 1);
});
