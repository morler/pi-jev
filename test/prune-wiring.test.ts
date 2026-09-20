import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import register from "../extensions/index.js";
import { scoreKeyOf } from "../src/messages.js";
import { goalKey } from "../src/compact.js";

/**
 * End-to-end checks of the pruning contract: the extension's own wiring, not the pure helpers.
 * The context hook never talks to Jev, so a sidecar written by hand drives it, and a compaction
 * event with an empty preparation never reaches the summary path either.
 */
function loadExtension(cwd: string) {
  const handlers = new Map<string, any[]>();
  const pi: any = {
    registerFlag: () => {},
    getFlag: (name: string) => name === "jev-compact", // compaction on, everything else off
    registerTool: () => {},
    registerCommand: () => {},
    on: (event: string, handler: any) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    sendMessage: () => {},
    events: { on: () => () => {}, emit: () => {} },
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
  };
  register(pi);

  const ctx: any = { cwd, ui: { setStatus: () => {} }, sessionManager: {}, signal: undefined };
  const fire = (event: string, payload: any) => Promise.all((handlers.get(event) ?? []).map((h) => h(payload, ctx)));
  /** The messages array a context hook returned, if it rewrote anything. */
  const view = async (messages: any[]) => {
    const out = await fire("context", { messages });
    return (out.find((r: any) => r?.messages) as any)?.messages as any[] | undefined;
  };
  return { fire, view, ctx };
}

const user = (text: string) => ({ role: "user", content: text });
const call = (id: string) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { q: id } }] });
const result = (id: string, text: string) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError: false });

// The compactor keys a frozen score by its goal as well as its message, so every hand-written
// score names the same goal and the extension is told to judge under it.
const GOAL = "wiring test goal";
process.env.JEV_COMPACT_GOAL = GOAL;

const writeScores = (cwd: string, scores: Record<string, number>) =>
  fs.writeFileSync(
    path.join(cwd, ".pi", "pi-jev.compact.json"),
    JSON.stringify({
      scores: Object.fromEntries(
        Object.entries(scores).map(([key, keep]) => [key, { keep, at: new Date().toISOString(), goal: goalKey(GOAL) }])
      ),
    })
  );

const tempCwd = (prefix: string) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  return cwd;
};

/** A usage stub far enough from the ceiling that no settings file can change the answer. */
const usage = (tokens: number) => ({ tokens, contextWindow: 1_000_000, percent: 0 });

function withKey<T>(body: () => Promise<T>): Promise<T> {
  const previous = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "test-key";
  return body().finally(() => {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  });
}

test("the context hook prunes at a cold checkpoint and freezes the view until the next one", async () => {
  const cwd = tempCwd("pi-jev-wiring-");
  const messages = [user("task"), call("c1"), result("c1", "x".repeat(500)), call("c2"), result("c2", "keep"), call("c3"), result("c3", "recent")];

  const previous = process.env.JEV_COMPACT_RECENT;
  process.env.JEV_COMPACT_RECENT = "2";
  await withKey(async () => {
    const { fire, view } = loadExtension(cwd);
    writeScores(cwd, { [scoreKeyOf(messages[2])]: 0.05, [scoreKeyOf(messages[4])]: 0.9 });

    // Nothing has answered yet, so the cache is cold and the first context call is a checkpoint.
    const pruned = await view(messages);
    assert.ok(pruned, "the context hook rewrote the message array");
    assert.deepEqual(
      pruned!.map((m) => m.role),
      ["user", "assistant", "toolResult", "assistant", "toolResult"],
      "c1's pair is gone, the recent c3 pair is untouched"
    );
    assert.ok(!JSON.stringify(pruned).includes("c1"), "both halves of the dropped pair went");

    // A warm turn must not refresh: the same decisions come back byte for byte, even with new scores.
    await fire("after_provider_response", { status: 200, headers: {} });
    writeScores(cwd, { [scoreKeyOf(messages[2])]: 0.05, [scoreKeyOf(messages[4])]: 0.05 });
    assert.deepEqual(await view(messages), pruned, "frozen between checkpoints");

    // Three turns with no cache write at all mean pruning is free, so the next call refreshes.
    for (let i = 0; i < 3; i++) await fire("turn_end", { message: { usage: { cacheRead: 0, cacheWrite: 0 } } });
    const refreshed = await view(messages);
    assert.deepEqual(refreshed!.map((m) => m.role), ["user", "assistant", "toolResult"], "c2's pair goes too");
    assert.ok(!JSON.stringify(refreshed).includes("c2"));
  }).finally(() => {
    if (previous === undefined) delete process.env.JEV_COMPACT_RECENT;
    else process.env.JEV_COMPACT_RECENT = previous;
  });
});

test("usage past Pi's ceiling refreshes the decision set even with a warm cache", async () => {
  const cwd = tempCwd("pi-jev-pressure-");
  const messages = [user("task"), call("c1"), result("c1", "one"), call("c2"), result("c2", "two"), call("c3"), result("c3", "recent")];

  const previous = process.env.JEV_COMPACT_RECENT;
  process.env.JEV_COMPACT_RECENT = "2";
  await withKey(async () => {
    const { fire, view, ctx } = loadExtension(cwd);
    ctx.getContextUsage = () => usage(1);
    writeScores(cwd, { [scoreKeyOf(messages[2])]: 0.05, [scoreKeyOf(messages[4])]: 0.9 });

    const first = await view(messages);
    assert.equal(first!.length, 5, "c1's pair is gone");

    // Warm cache, inside the ceiling: a new low score for c2 must not change anything yet.
    await fire("after_provider_response", { status: 200, headers: {} });
    writeScores(cwd, { [scoreKeyOf(messages[2])]: 0.05, [scoreKeyOf(messages[4])]: 0.05 });
    assert.deepEqual(await view(messages), first, "frozen while inside Pi's ceiling");

    // Past the ceiling the next request misses the cache anyway, so one refresh pass is free.
    ctx.getContextUsage = () => usage(2_000_000);
    const bypassed = await view(messages);
    assert.equal(bypassed!.length, first!.length - 2, "c2's pair is dropped on the pressure pass");
  }).finally(() => {
    if (previous === undefined) delete process.env.JEV_COMPACT_RECENT;
    else process.env.JEV_COMPACT_RECENT = previous;
  });
});


test("a failed provider response does not count as a served one", async () => {
  const cwd = tempCwd("pi-jev-failure-");
  const messages = [user("task"), call("c1"), result("c1", "one"), call("c2"), result("c2", "two"), call("c3"), result("c3", "recent")];

  const previous = process.env.JEV_COMPACT_RECENT;
  process.env.JEV_COMPACT_RECENT = "2";
  await withKey(async () => {
    const { fire, view } = loadExtension(cwd);
    writeScores(cwd, { [scoreKeyOf(messages[2])]: 0.05, [scoreKeyOf(messages[4])]: 0.9 });
    const first = await view(messages);
    assert.equal(first!.length, 5, "c1's pair is gone");

    // A 500 was never served, so its prefix was never re-cached: the cache stays cold.
    await fire("after_provider_response", { status: 500, headers: {} });
    writeScores(cwd, { [scoreKeyOf(messages[2])]: 0.05, [scoreKeyOf(messages[4])]: 0.05 });
    const afterFailure = await view(messages);

    assert.equal(afterFailure!.length, first!.length - 2, "the failed response left the cold checkpoint intact");
  }).finally(() => {
    if (previous === undefined) delete process.env.JEV_COMPACT_RECENT;
    else process.env.JEV_COMPACT_RECENT = previous;
  });
});

test("the context hook survives a getContextUsage that throws", async () => {
  const cwd = tempCwd("pi-jev-usage-");

  await withKey(async () => {
    const { fire, ctx } = loadExtension(cwd);
    ctx.getContextUsage = () => {
      throw new Error("usage unavailable");
    };

    // An exception here would reject the handler and surface as a broken request instead of fail-open.
    const out = await fire("context", { messages: [user("task")] });
    assert.ok(Array.isArray(out), "the context handler resolved");
    await fire("turn_end", { message: { usage: { cacheRead: 1, cacheWrite: 1 } } });
  });
});

test("threshold compaction is cancelled inside the ceiling, and only for threshold", async () => {
  const cwd = tempCwd("pi-jev-cancel-");

  await withKey(async () => {
    const { fire, ctx } = loadExtension(cwd);

    // Inside the ceiling with pruning on: Pi's early compaction is not needed yet.
    ctx.getContextUsage = () => usage(1);
    const threshold = await fire("session_before_compact", { reason: "threshold", preparation: {} });
    assert.deepEqual(threshold.filter((r: any) => r?.cancel), [{ cancel: true }]);

    // Over the ceiling: let Pi compact.
    ctx.getContextUsage = () => usage(2_000_000);
    const over = await fire("session_before_compact", { reason: "threshold", preparation: {} });
    assert.equal(over.filter((r: any) => r?.cancel).length, 0, "over the ceiling Pi's compaction wins");

    // Manual compaction passes through whatever the usage says.
    ctx.getContextUsage = () => usage(1);
    const manual = await fire("session_before_compact", { reason: "manual", preparation: {} });
    assert.equal(manual.filter((r: any) => r?.cancel).length, 0, "a user-asked compaction is never cancelled");
  });
});
