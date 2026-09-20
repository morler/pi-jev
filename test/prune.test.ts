import test from "node:test";
import assert from "node:assert/strict";
import { applyPrune, cancelThresholdCompaction, contextCeiling, pairCalls, realContextBoundary, reconcilePressure } from "../src/prune.js";
import { scoreKeyOf } from "../src/messages.js";

const user = (text: string) => ({ role: "user", content: text });
const call = (id: string, name = "read") => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name, arguments: { q: id } }],
});
const result = (id: string, text: string, content?: any[]) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "read",
  content: content ?? [{ type: "text", text }],
  isError: false,
});

test("pairCalls pairs each call with its result and keys the score on the result", () => {
  const messages = [user("task"), call("c1"), result("c1", "output one")];

  const pairs = pairCalls(messages);

  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].callId, "c1");
  assert.equal(pairs[0].callIndex, 1);
  assert.equal(pairs[0].resultIndex, 2);
  assert.equal(pairs[0].scoreKey, scoreKeyOf(messages[2]), "the result is what bloats the context");
});

test("a dropped pair loses both the call block and the result message", () => {
  const messages = [user("task"), call("c1"), result("c1", "big output"), user("next")];

  const { messages: next, stats } = applyPrune(messages, new Map([["c1", "drop"]]), 300);

  assert.equal(stats.dropped, 1);
  assert.deepEqual(next.map((m) => m.role), ["user", "user"], "call and result both go");
  assert.ok(!JSON.stringify(next).includes("c1"), "no half of the pair survives");
});

test("dropping one call leaves the rest of its assistant message intact", () => {
  const assistant = {
    role: "assistant",
    content: [
      { type: "text", text: "reasoning about it" },
      { type: "toolCall", id: "c1", name: "read", arguments: {} },
      { type: "toolCall", id: "c2", name: "grep", arguments: {} },
    ],
  };
  const messages = [user("task"), assistant, result("c1", "one"), result("c2", "two")];

  const { messages: next } = applyPrune(messages, new Map([["c1", "drop"]]), 300);

  assert.equal(next.length, 3);
  assert.deepEqual(
    next[1].content.map((b: any) => b.id ?? b.text),
    ["reasoning about it", "c2"]
  );
  assert.ok(!JSON.stringify(next).includes("c1"));
});

test("an assistant message that loses every block is removed", () => {
  const messages = [user("task"), call("c1"), result("c1", "out")];

  const { messages: next, stats } = applyPrune(messages, new Map([["c1", "drop"]]), 300);

  assert.equal(stats.dropped, 1, "the pair is counted once, not once per side");
  assert.deepEqual(next.map((m) => m.role), ["user"]);
});

test("a truncated result keeps its head, a re-run marker, and its images", () => {
  const body = "x".repeat(1000);
  const messages = [user("task"), call("c1"), result("c1", body, [{ type: "text", text: body }, { type: "image", data: "abc" }])];

  const { messages: next, stats } = applyPrune(messages, new Map([["c1", "truncate"]]), 300);

  assert.equal(stats.truncated, 1);
  const content = next[2].content;
  assert.equal(content.length, 2, "one text block plus the untouched image");
  assert.equal(content[0].text.slice(0, 300), "x".repeat(300));
  assert.match(content[0].text, /re-run this tool/);
  assert.equal(content[1].type, "image");
  assert.ok(content[0].text.length < body.length);
});

test("a result shorter than the head is left alone rather than annotated", () => {
  const messages = [user("task"), call("c1"), result("c1", "tiny")];

  const { messages: next, stats } = applyPrune(messages, new Map([["c1", "truncate"]]), 300);

  assert.equal(stats.truncated, 0);
  assert.equal(next[2], messages[2], "an untouched message keeps its identity");
});

test("kept messages pass through by identity and the savings are counted", () => {
  const messages = [user("task"), call("c1"), result("c1", "x".repeat(1000)), call("c2"), result("c2", "keep me")];

  const { messages: next, stats } = applyPrune(messages, new Map([["c1", "drop"], ["c2", "keep"]]), 300);

  assert.equal(next[0], messages[0]);
  assert.equal(next[1], messages[3], "the c2 call message is untouched");
  assert.equal(stats.dropped, 1);
  assert.equal(stats.truncated, 0);
  assert.ok(stats.charsAfter < stats.charsBefore);
  assert.ok(JSON.stringify(next).includes("keep me"));
});

test("a decision for a call that is not in the array changes nothing", () => {
  const messages = [user("task"), call("c1"), result("c1", "out")];

  const { messages: next, stats } = applyPrune(messages, new Map([["gone", "drop"]]), 300);

  assert.equal(stats.dropped, 0);
  assert.deepEqual(next, messages);
});

test("no decisions means the array comes back unchanged", () => {
  const messages = [user("task"), call("c1"), result("c1", "out")];

  const { messages: next, stats } = applyPrune(messages, new Map(), 300);

  assert.deepEqual(next, messages);
  assert.equal(stats.charsBefore, stats.charsAfter);
});

test("contextCeiling subtracts the reserve and never goes negative", () => {
  assert.equal(contextCeiling(200_000, 20_000), 180_000);
  assert.equal(contextCeiling(10_000, 20_000), 0);
  assert.equal(contextCeiling(0, 100), 0);
  assert.equal(contextCeiling(Number.NaN, 100), 0);
});

test("realContextBoundary reports overCeiling, and null when usage is unknown", () => {
  const window = 200_000;
  assert.equal(realContextBoundary({ tokens: 190_000, contextWindow: window, reserveTokens: 20_000 }).overCeiling, true);
  assert.equal(realContextBoundary({ tokens: 100_000, contextWindow: window, reserveTokens: 20_000 }).overCeiling, false);
  assert.equal(
    realContextBoundary({ tokens: null, contextWindow: window, reserveTokens: 20_000 }).overCeiling,
    null,
    "unknown usage must not read as inside the ceiling"
  );
  assert.equal(realContextBoundary({ tokens: 100, contextWindow: undefined, reserveTokens: 0 }).overCeiling, null);
});

test("a pressure pass is validated once and not repeated when it did not help", () => {
  assert.equal(reconcilePressure("armed", true), "armed", "an armed state waits for its checkpoint");
  assert.equal(reconcilePressure("awaiting_validation", false), "armed", "back inside the ceiling: the pass worked");
  assert.equal(reconcilePressure("awaiting_validation", true), "exhausted", "still over: stop, Pi compacts");
  assert.equal(reconcilePressure("awaiting_validation", null), "exhausted");
  assert.equal(reconcilePressure("exhausted", false), "armed", "recovered");
  assert.equal(reconcilePressure("exhausted", true), "exhausted");
});

test("threshold compaction is cancelled only while pruning can cover it", () => {
  assert.equal(cancelThresholdCompaction({ pruning: false, pressure: "armed", overCeiling: false }), false, "pruning off: never cancel");
  assert.equal(
    cancelThresholdCompaction({ pruning: true, pressure: "awaiting_validation", overCeiling: true }),
    true,
    "one turn validates the pruned prompt"
  );
  assert.equal(
    cancelThresholdCompaction({ pruning: true, pressure: "armed", overCeiling: false }),
    true,
    "inside the ceiling: Pi's early compaction is not needed yet"
  );
  assert.equal(cancelThresholdCompaction({ pruning: true, pressure: "armed", overCeiling: true }), false, "over the ceiling: let Pi compact");
  assert.equal(cancelThresholdCompaction({ pruning: true, pressure: "exhausted", overCeiling: true }), false);
  assert.equal(cancelThresholdCompaction({ pruning: true, pressure: "armed", overCeiling: null }), false, "unknown boundary: let Pi compact");
  assert.equal(
    cancelThresholdCompaction({ pruning: true, pressure: "awaiting_validation", overCeiling: null }),
    false,
    "an unknown boundary is never a reason to cancel, not even mid-episode"
  );
});

