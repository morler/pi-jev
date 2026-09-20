import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JevCompactor, goalKey, pruneSchedule } from "../src/compact.js";
import type { JevClient } from "../src/jev.js";
import { scoreKeyOf } from "../src/messages.js";

// The score cache is written under ctx.cwd, so a temp dir keeps tests out of the real .pi/.
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jev-compact-"));
const ctx = { cwd } as any;
const SIDECAR = path.join(cwd, ".pi", "pi-jev.compact.json");

/**
 * One score per JUDGED message, in order — the question ids are content hashes the fixture cannot
 * know, and user prose is never judged. A missing score defaults to 0, i.e. the drop band.
 */
function scoringClient(...scores: number[]) {
  const calls: any[] = [];
  const client = {
    isConfigured: () => true,
    evaluate: async (request: any) => {
      calls.push(request);
      const ids = Object.keys(request.questions);
      // Shaped like JevClient's output: `value` falls back to 0 for reporting while `raw` keeps the
      // provider's own answer. Reading only `value` would hide a missing answer behind that 0.
      return {
        answers: Object.fromEntries(
          ids.map((id, i) => [id, { type: "noul", value: scores[i] ?? 0, raw: { noul: scores[i] ?? 0 } }])
        ),
      };
    },
  } as unknown as JevClient;
  return { client, calls };
}

/** Real pi-ai shapes: toolCallId lives on the toolResult MESSAGE; content is text/toolCall blocks. */
function compactEvent(messages: any[], customInstructions?: string) {
  return { preparation: { messagesToSummarize: messages }, customInstructions, signal: undefined };
}

const user = (text: string) => ({ role: "user", content: text });
const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name, arguments: args }],
});
const result = (id: string, text: string) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "read",
  content: [{ type: "text", text }],
});
/** Long enough to cross the 300-char truncate head. */
const long = (marker: string) => `${marker} ${"x".repeat(400)}`;

/** The goal the planPrune fixture freezes its scores under, so the keys line up. */
const GOAL = "judge the parser fix";

test("JevCompactor keeps judged tool history in the custom summary", async () => {
  const { client, calls } = scoringClient(0.9, 0.9);
  const outcome = await new JevCompactor(client, true).compact(
    compactEvent(
      [user("Fix auth bug"), call("c1", "read", { path: "auth.ts" }), result("c1", "token compare failed at auth.ts:12")],
      "Fix auth bug"
    ),
    ctx
  );

  assert.equal(calls.length, 1);
  assert.equal(outcome.kept, 3);
  assert.equal(outcome.considered, 3);
  assert.match(outcome.summary, /auth.ts:12/);
  assert.match(outcome.summary, /tool call read/);
});

test("JevCompactor judges the whole discard range, not just the oldest 24 messages", async () => {
  const { client, calls } = scoringClient(...Array(30).fill(0.9));
  const messages: any[] = [user("Long task")];
  for (let i = 1; i <= 30; i++) messages.push(result(`c${i}`, `tool output ${i}`));

  const outcome = await new JevCompactor(client, true).compact(compactEvent(messages), ctx);

  assert.equal(outcome.considered, 31);
  assert.equal(Object.keys(calls[0].questions).length, 30, "every tool result past the 24th is judged");
  assert.match(outcome.summary, /tool output 30/);
});

test("JevCompactor splits scores into keep / truncate / drop at the thresholds", async () => {
  const saved = { keep: process.env.JEV_COMPACT_KEEP, drop: process.env.JEV_COMPACT_DROP };
  process.env.JEV_COMPACT_KEEP = "0.55";
  process.env.JEV_COMPACT_DROP = "0.25";
  try {
    const { client } = scoringClient(0.55, 0.25, 0.24);
    const outcome = await new JevCompactor(client, true).compact(
      compactEvent([result("c1", long("KEEP-MARK")), result("c2", long("TRUNCATE-MARK")), result("c3", long("DROP-MARK"))]),
      ctx
    );

    assert.deepEqual([outcome.kept, outcome.truncated, outcome.dropped], [1, 1, 1]);
    assert.equal(outcome.considered, 3);
    assert.match(outcome.summary, /KEEP-MARK/);
    assert.match(outcome.summary, /TRUNCATE-MARK/);
    assert.match(outcome.summary, /re-run this tool/);
    assert.doesNotMatch(outcome.summary, /DROP-MARK/);
  } finally {
    for (const [name, value] of [["JEV_COMPACT_KEEP", saved.keep], ["JEV_COMPACT_DROP", saved.drop]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("JevCompactor judges an unchanged message once and re-judges a changed one", async () => {
  const { client, calls } = scoringClient(0.9);
  const compactor = new JevCompactor(client, true);
  const stable = () => [user("Task"), result("c1", "stable output")];

  const first = await compactor.compact(compactEvent(stable()), ctx);
  const second = await compactor.compact(compactEvent(stable()), ctx);

  assert.equal(calls.length, 1, "the frozen score is reused, so no second request");
  assert.equal(second.summary, first.summary);
  assert.ok(fs.existsSync(SIDECAR), "scores are persisted for the next session");

  const changed = await compactor.compact(compactEvent([user("Task"), result("c1", "changed output")]), ctx);
  assert.equal(calls.length, 2, "a changed message is judged again");
  assert.match(changed.summary, /changed output/);
});

test("JevCompactor fails open when Jev is unavailable", async () => {
  const client = { isConfigured: () => false } as unknown as JevClient;
  const outcome = await new JevCompactor(client, true).compact(compactEvent([result("c1", "x")]), ctx);
  assert.equal(outcome.skipped, "unconfigured");
  assert.equal(outcome.summary, "");
});

test("JevCompactor does nothing while disabled", async () => {
  const client = { isConfigured: () => true } as unknown as JevClient;
  const outcome = await new JevCompactor(client, false).compact(compactEvent([result("c1", "x")]), ctx);
  assert.equal(outcome.skipped, "disabled");
});
test("JevCompactor batches questions across requests without losing or repeating any", async () => {
  const saved = { maxState: process.env.JEV_COMPACT_MAXSTATE, maxReq: process.env.JEV_COMPACT_MAXREQ };
  // Both budgets are set: a request budget below the state budget is clamped up, so the split has to
  // come from a state that fits the whole window while the request leaves little room for questions.
  process.env.JEV_COMPACT_MAXSTATE = "2000";
  process.env.JEV_COMPACT_MAXREQ = "3000";
  try {
    const { client, calls } = scoringClient(...Array(40).fill(0.9));
    const messages = Array.from({ length: 40 }, (_, i) => result(`c${i}`, `batch output ${i}`));

    const outcome = await new JevCompactor(client, true).compact(compactEvent(messages), ctx);

    const asked = calls.flatMap((request) => Object.keys(request.questions));
    assert.ok(calls.length > 1, "a small request budget splits the questions into batches");
    assert.equal(asked.length, 40, "every message is asked exactly once");
    assert.equal(new Set(asked).size, 40, "no batch repeats another batch's question");
    assert.equal(outcome.kept, 40);
    assert.equal(outcome.dropped, 0);
  } finally {
    for (const [name, value] of [["JEV_COMPACT_MAXSTATE", saved.maxState], ["JEV_COMPACT_MAXREQ", saved.maxReq]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("the state shrinks to fit its budget while every message is still decided", async () => {
  const saved = process.env.JEV_COMPACT_MAXSTATE;
  const messages = Array.from({ length: 20 }, (_, i) => result(`c${i}`, long(`OUT-${i}`)));
  /** A fresh cwd per run: the shared score cache would otherwise turn the second run into a no-op. */
  const run = async (maxState: string) => {
    process.env.JEV_COMPACT_MAXSTATE = maxState;
    const { client, calls } = scoringClient(...Array(20).fill(0.9));
    const outcome = await new JevCompactor(client, true).compact(compactEvent(messages), {
      cwd: fs.mkdtempSync(path.join(os.tmpdir(), "pi-jev-state-")),
    } as any);
    return { stateSize: JSON.stringify(calls[0].state).length, outcome };
  };

  try {
    const roomy = await run("100000");
    const tight = await run("600");

    assert.ok(tight.stateSize < roomy.stateSize, "a smaller budget sends a smaller state");
    assert.equal(tight.outcome.considered, 20, "every message is still decided");
    assert.equal(tight.outcome.kept, 20);
  } finally {
    if (saved === undefined) delete process.env.JEV_COMPACT_MAXSTATE;
    else process.env.JEV_COMPACT_MAXSTATE = saved;
  }
});

test("a request that never answers is abandoned at the configured timeout", async () => {
  const saved = process.env.JEV_COMPACT_TIMEOUT;
  process.env.JEV_COMPACT_TIMEOUT = "20";
  try {
    const client = {
      isConfigured: () => true,
      evaluate: (_request: any, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    } as unknown as JevClient;

    const started = Date.now();
    const outcome = await new JevCompactor(client, true).compact(compactEvent([result("c1", "slow")]), ctx);

    assert.equal(outcome.skipped, "error", "a hung request fails open to Pi's built-in summary");
    assert.equal(outcome.summary, "");
    assert.ok(Date.now() - started >= 20, "it waited for the timeout before giving up");
  } finally {
    if (saved === undefined) delete process.env.JEV_COMPACT_TIMEOUT;
    else process.env.JEV_COMPACT_TIMEOUT = saved;
  }
});

test("the breaker stops asking Jev after two consecutive failures", async () => {
  const calls: any[] = [];
  let down = true;
  const client = {
    isConfigured: () => true,
    evaluate: async (request: any) => {
      calls.push(request);
      if (down) throw new Error("jev down");
      return {
        answers: Object.fromEntries(
          Object.keys(request.questions).map((id) => [id, { type: "noul", value: 0.9, raw: { noul: 0.9 } }])
        ),
      };
    },
  } as unknown as JevClient;

  const compactor = new JevCompactor(client, true);
  const event = compactEvent([result("c1", "flaky output")]);

  assert.equal((await compactor.compact(event, ctx)).skipped, "error");
  assert.equal((await compactor.compact(event, ctx)).skipped, "error");
  assert.equal(calls.length, 2);

  down = false;
  const third = await compactor.compact(event, ctx);

  assert.equal(calls.length, 2, "the open breaker skips the request");
  assert.equal(third.skipped, undefined);
  assert.equal(third.kept, 1, "an unscored message is kept verbatim, never dropped");
  assert.match(third.summary, /flaky output/);
});
test("planPrune turns scores into changes, skipping the first message and the recent window", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jev-plan-"));
  const messages: any[] = [
    call("c0", "read"),
    result("c0", "first message"),
    user("task"),
    call("c1", "read"),
    result("c1", "drop me"),
    call("c2", "read"),
    result("c2", "truncate me"),
    call("c3", "read"),
    result("c3", "never scored"),
    call("c4", "read"),
    result("c4", "too recent"),
  ];
  const sidecar = path.join(dir, ".pi", "pi-jev.compact.json");
  fs.mkdirSync(path.dirname(sidecar), { recursive: true });
  /** A frozen score, keyed exactly the way the compactor keys it: by message AND by goal. */
  const frozen = (message: any, keep: number) => ({
    [scoreKeyOf(message)]: { keep, at: new Date().toISOString(), goal: goalKey(GOAL) },
  });
  fs.writeFileSync(
    sidecar,
    JSON.stringify({ scores: { ...frozen(messages[4], 0.05), ...frozen(messages[6], 0.3), ...frozen(messages[10], 0.05) } })
  );

  const compactor = new JevCompactor({ isConfigured: () => true } as unknown as JevClient, true);
  process.env.JEV_COMPACT_RECENT = "2";
  process.env.JEV_COMPACT_GOAL = GOAL;
  try {
    assert.deepEqual(
      [...compactor.planPrune(messages, dir, false)],
      [["c1", "drop"], ["c2", "truncate"]],
      "c0 is the first message, c3 is unscored, c4 is inside the recent window"
    );

    assert.deepEqual(
      [...compactor.planPrune(messages, dir, true)],
      [["c1", "truncate"], ["c2", "truncate"]],
      "while an agent run is live a drop waits as a truncated breadcrumb"
    );
  } finally {
    delete process.env.JEV_COMPACT_RECENT;
    delete process.env.JEV_COMPACT_GOAL;
  }
});

test("judge scores the prunable window into the sidecar and sends the task as the goal", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jev-judge-"));
  // c2 gets its own arguments: two calls rendered identically share one question and one score.
  const messages = [user("fix the parser"), call("c1", "read"), result("c1", "one"), call("c2", "read", { q: "two" }), result("c2", "two")];

  process.env.JEV_COMPACT_RECENT = "1";
  try {
    const { client, calls } = scoringClient(0.9, 0.9, 0.9);
    await new JevCompactor(client, true).judge(messages, dir);

    assert.equal(calls.length, 1);
    assert.equal(Object.keys(calls[0].questions).length, 3, "the window holds c1, its result, and c2");
    assert.equal((calls[0].state as any).goal, "fix the parser", "the goal carries the task, so the state can be the window");
    assert.ok(fs.existsSync(path.join(dir, ".pi", "pi-jev.compact.json")), "scores land in the sidecar");
  } finally {
    delete process.env.JEV_COMPACT_RECENT;
  }
});

test("judge does nothing while compaction is off", async () => {
  const { client, calls } = scoringClient(0.9);
  await new JevCompactor(client, false).judge([user("task"), result("c1", "out")], ctx.cwd);
  assert.equal(calls.length, 0);
});

test("an inverted threshold pair is clamped, and a tiny request budget is raised", async () => {
  const saved = {
    keep: process.env.JEV_COMPACT_KEEP,
    drop: process.env.JEV_COMPACT_DROP,
    maxState: process.env.JEV_COMPACT_MAXSTATE,
    maxReq: process.env.JEV_COMPACT_MAXREQ,
  };
  process.env.JEV_COMPACT_KEEP = "0.2";
  process.env.JEV_COMPACT_DROP = "0.9";
  process.env.JEV_COMPACT_MAXSTATE = "5000";
  process.env.JEV_COMPACT_MAXREQ = "100";
  try {
    const schedule = pruneSchedule();
    assert.equal(schedule.keepThreshold, 0.2);
    assert.equal(schedule.dropThreshold, 0.2, "a drop band above the keep band would be unreachable");

    const { client, calls } = scoringClient(...Array(5).fill(0.9));
    const messages = Array.from({ length: 5 }, (_, i) => result(`c${i}`, `raised budget ${i}`));
    await new JevCompactor(client, true).compact(compactEvent(messages), { cwd: fs.mkdtempSync(path.join(os.tmpdir(), "pi-jev-budget-")) } as any);

    assert.equal(calls.length, 1, "a request budget below the state budget must not fan out to one call per message");
  } finally {
    for (const [name, value] of [
      ["JEV_COMPACT_KEEP", saved.keep],
      ["JEV_COMPACT_DROP", saved.drop],
      ["JEV_COMPACT_MAXSTATE", saved.maxState],
      ["JEV_COMPACT_MAXREQ", saved.maxReq],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("a score frozen under a different goal is judged again", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jev-goal-"));
  const { client, calls } = scoringClient(0.9);
  const compactor = new JevCompactor(client, true);
  const event = () => compactEvent([user("task"), result("c1", "goal dependent")]);

  try {
    process.env.JEV_COMPACT_GOAL = "first task";
    await compactor.compact(event(), { cwd: dir } as any);
    await compactor.compact(event(), { cwd: dir } as any);
    assert.equal(calls.length, 1, "the same goal reuses the frozen score");

    process.env.JEV_COMPACT_GOAL = "second task";
    await compactor.compact(event(), { cwd: dir } as any);
    assert.equal(calls.length, 2, "a judgement is not reused under a task it was never taken against");
  } finally {
    delete process.env.JEV_COMPACT_GOAL;
  }
});

test("stale score records are evicted when the cache is written", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jev-ttl-"));
  const sidecar = path.join(dir, ".pi", "pi-jev.compact.json");
  fs.mkdirSync(path.dirname(sidecar), { recursive: true });
  fs.writeFileSync(
    sidecar,
    JSON.stringify({
      scores: {
        ancient: { keep: 0.9, at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), goal: goalKey("old") },
      },
    })
  );

  const { client } = scoringClient(0.9);
  await new JevCompactor(client, true).compact(compactEvent([user("task"), result("c1", "fresh")]), { cwd: dir } as any);

  const scores = JSON.parse(fs.readFileSync(sidecar, "utf8")).scores;
  assert.equal(scores.ancient, undefined, "a month-old score is dropped on write");
  assert.equal(Object.keys(scores).length, 1, "the score just taken stays");
});


test("a malformed answer is never frozen as a zero score", async () => {
  for (const junk of [null, "", [], false, {}]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jev-junk-"));
    // The real post-mapping shape: JevClient reports a missing answer as value 0 while `raw` keeps
    // whatever the provider actually sent.
    const client = {
      isConfigured: () => true,
      evaluate: async (request: any) => ({
        answers: Object.fromEntries(
          Object.keys(request.questions).map((id) => [id, { type: "noul", value: 0, raw: junk }])
        ),
      }),
    } as unknown as JevClient;

    const outcome = await new JevCompactor(client, true).compact(
      compactEvent([user("task"), result("c1", "important output")]),
      { cwd: dir } as any
    );

    assert.equal(outcome.dropped, 0, `${JSON.stringify(junk)} is not a score of zero`);
    assert.match(outcome.summary, /important output/);
    const sidecar = JSON.parse(fs.readFileSync(path.join(dir, ".pi", "pi-jev.compact.json"), "utf8"));
    assert.deepEqual(sidecar.scores, {}, "a malformed answer must stay uncached");
  }
});

test("the score key covers the whole message, so a tail-only edit is re-judged", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jev-tail-"));
  const { client, calls } = scoringClient(0.9);
  const compactor = new JevCompactor(client, true);
  const body = (tail: string) => `${"x".repeat(1000)}${tail}`;

  await compactor.compact(compactEvent([user("task"), result("c1", body("FIRST"))]), { cwd: dir } as any);
  assert.equal(calls.length, 1);
  await compactor.compact(compactEvent([user("task"), result("c1", body("SECOND"))]), { cwd: dir } as any);

  assert.equal(calls.length, 2, "a change past the per-message cap still counts as a change");
});

test("every question is keyed to a message the state actually shows", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jev-referent-"));
  const messages = [user("task"), result("c1", "one"), result("c2", "two"), result("c3", "three"), result("c4", "four"), result("c5", "five")];

  const previous = process.env.JEV_COMPACT_RECENT;
  process.env.JEV_COMPACT_RECENT = "1";
  try {
    const { client, calls } = scoringClient(...Array(4).fill(0.9));
    await new JevCompactor(client, true).judge(messages, dir);

    const shown = new Set((calls[0].state as any).messages.map((entry: any) => entry.hash));
    const asked = Object.keys(calls[0].questions).map((id) => id.replace(/^keep_/, ""));

    assert.equal(asked.length, 4);
    for (const hash of asked) {
      assert.ok(shown.has(hash), `question keep_${hash} has no state entry to answer against`);
    }
  } finally {
    if (previous === undefined) delete process.env.JEV_COMPACT_RECENT;
    else process.env.JEV_COMPACT_RECENT = previous;
  }
});

test("a kept message past the cap says so, and the truncate marker counts the real omission", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jev-marker-"));
  const { client } = scoringClient(0.9, 0.3);
  const outcome = await new JevCompactor(client, true).compact(
    compactEvent([result("c1", `${"k".repeat(1000)}TAIL`), result("c2", `${"t".repeat(1000)}END`)]),
    { cwd: dir } as any
  );

  assert.match(outcome.summary, /chars omitted from this kept message/, "the keep band must not clip silently");
  assert.doesNotMatch(outcome.summary, /TAIL/, "the tail beyond the cap is not claimed as present");

  const marker = outcome.summary.match(/\[pi-jev: result truncated, (\d+) chars omitted/);
  assert.ok(marker, "the truncate band keeps its re-run marker");
  assert.ok(Number(marker![1]) > 600, `expected the real omission count, got ${marker![1]}`);
});



