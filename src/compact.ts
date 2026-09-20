import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { noulProbability, type JevClient } from "./jev.js";
import { isJsonObject, isTruthy, readJsonObject, writeJson } from "./config.js";
import { MAX_TEXT_CHARS, keptText, needsJudgement, rawTextOf, scoreKeyOf, textOf, truncateHead } from "./messages.js";
import { pairCalls, type Decision } from "./prune.js";

export interface CompactResult {
  summary: string;
  kept: number;
  truncated: number;
  dropped: number;
  considered: number;
  skipped?: "disabled" | "unconfigured" | "empty" | "error";
}

type ScoreRecord = { keep: number; at: string };
type Candidate = { message: any; index: number; judge: boolean; hash: string };
type Config = {
  keepThreshold: number;
  dropThreshold: number;
  headChars: number;
  recentMessages: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  timeoutMs: number;
  breakerMs: number;
  cacheTtlMs: number;
  minGapMs: number;
  prune: boolean;
};

const SMALLEST_CAP = 60;
/** Per-message text caps tried in order until the state fits its token budget. */
const STATE_CAPS = [MAX_TEXT_CHARS, 300, 120, SMALLEST_CAP];
const DEFAULTS: Config = {
  keepThreshold: 0.55,
  dropThreshold: 0.25,
  headChars: 300,
  recentMessages: 6,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  timeoutMs: 20_000,
  breakerMs: 120_000,
  cacheTtlMs: 300_000,
  minGapMs: 30_000,
  prune: true,
};

/** JEV_COMPACT_* overrides; an unparsable value keeps the default. */
function compactSettings(): Config {
  const num = (name: string, fallback: number): number => {
    const raw = process.env[name];
    const parsed = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  // A blank var means "unset" for a knob, so the default survives. A switch in src/config.ts instead
  // treats "set at all" as meaningful, which is what makes PI_JEV_AUTO=0 a hard off.
  const flag = (name: string, fallback: boolean): boolean => {
    const raw = process.env[name];
    return raw === undefined || raw.trim() === "" ? fallback : isTruthy(raw);
  };
  return {
    keepThreshold: num("JEV_COMPACT_KEEP", DEFAULTS.keepThreshold),
    dropThreshold: num("JEV_COMPACT_DROP", DEFAULTS.dropThreshold),
    headChars: num("JEV_COMPACT_HEAD", DEFAULTS.headChars),
    recentMessages: num("JEV_COMPACT_RECENT", DEFAULTS.recentMessages),
    maxStateTokens: num("JEV_COMPACT_MAXSTATE", DEFAULTS.maxStateTokens),
    maxRequestTokens: num("JEV_COMPACT_MAXREQ", DEFAULTS.maxRequestTokens),
    timeoutMs: num("JEV_COMPACT_TIMEOUT", DEFAULTS.timeoutMs),
    breakerMs: num("JEV_COMPACT_BREAKER", DEFAULTS.breakerMs),
    cacheTtlMs: num("JEV_COMPACT_TTL", DEFAULTS.cacheTtlMs),
    minGapMs: num("JEV_COMPACT_GAP", DEFAULTS.minGapMs),
    prune: flag("JEV_COMPACT_PRUNE", DEFAULTS.prune),
  };
}

/** Schedule knobs the extension needs: when a refresh is free, and how often to judge. */
export function pruneSchedule(): { enabled: boolean; cacheTtlMs: number; minGapMs: number; headChars: number } {
  const c = compactSettings();
  return { enabled: c.prune, cacheTtlMs: c.cacheTtlMs, minGapMs: c.minGapMs, headChars: c.headChars };
}

/** Rough token estimate — about six letters, half a token per digit, one per other symbol. */
function estTokens(text: string): number {
  let total = 0;
  for (const char of text) {
    if (/[a-zA-Z]/.test(char)) total += 1 / 6;
    else if (/[0-9]/.test(char)) total += 0.5;
    else total += 1;
  }
  return Math.ceil(total);
}

/** Verbatim / head + re-run marker / nothing in the summary. */
function decide(keep: number, c: Config): Decision {
  if (keep >= c.keepThreshold) return "keep";
  if (keep >= c.dropThreshold) return "truncate";
  return "drop";
}

const QUESTION =
  "Should this historical message stay available in compacted context? Answer high if its exact contents are still needed, lower if only the fact that it happened matters, near zero if it is irrelevant to continuing the task.";

const ONGOING = "Continue the user's ongoing coding task";

/**
 * The messages Pi is about to discard: preparation.messagesToSummarize plus any split-turn prefix.
 * branchEntries is the whole branch, so slicing it judged the oldest entries and never looked at
 * the range that actually disappears.
 */
function discardedMessages(event: any): any[] {
  const preparation = event?.preparation ?? {};
  return [...(preparation.messagesToSummarize ?? []), ...(preparation.turnPrefixMessages ?? [])];
}

/** Candidates from a message list: whether to ask Jev, and the key a score is frozen against. */
function toCandidates(messages: any[]): Candidate[] {
  return messages
    .map((message, index) => ({ message, index, judge: needsJudgement(message), hash: scoreKeyOf(message) }))
    .filter((item) => rawTextOf(item.message) !== "");
}

/** The window Jev may prune: everything after the first message and outside the newest recent. */
function prunableWindow(length: number, c: Config): { from: number; to: number } {
  return { from: 1, to: Math.max(1, length - c.recentMessages) };
}

/** The task Jev judges against: the last few user prompts, or an explicit override. */
function inferGoal(messages: any[]): string {
  const prompts = messages
    .filter((message) => message?.role === "user")
    .map((message) => rawTextOf(message))
    .filter(Boolean)
    .slice(-3);
  return process.env.JEV_COMPACT_GOAL?.trim() || prompts.join(" | ") || ONGOING;
}

/** Score cache beside the session state; keyed by content hash so message positions never matter. */
function sidecarPath(cwd: string): string {
  return path.join(cwd, ".pi", "pi-jev.compact.json");
}

function loadScores(cwd: string): Record<string, ScoreRecord> {
  // An absent or corrupt cache reads as empty: everything is simply judged again.
  const scores = readJsonObject(sidecarPath(cwd)).scores;
  return isJsonObject(scores) ? (scores as Record<string, ScoreRecord>) : {};
}

function saveScores(cwd: string, scores: Record<string, ScoreRecord>): void {
  try {
    writeJson(sidecarPath(cwd), { scores });
  } catch {
    // Unwritable cache: judging still works, freezing just does not persist.
  }
}

/**
 * The state Jev reasons over: the same candidates with shorter text, shrunk through STATE_CAPS until
 * it fits its budget. Past the smallest cap the oldest messages are left out — they are the ones
 * furthest from where the task continues — while the questions still cover every candidate.
 */
function fitState(
  candidates: Candidate[],
  goal: string,
  budget: number
): { state: Record<string, unknown>; tokens: number; included: Set<string> } {
  const project = (cap: number, items: Candidate[]) =>
    items.map((item) => ({ index: item.index, hash: item.hash, text: textOf(item.message, cap) }));

  for (const cap of STATE_CAPS) {
    const state = { goal, messages: project(cap, candidates) };
    const tokens = estTokens(JSON.stringify(state));
    if (tokens <= budget) return { state, tokens, included: new Set(candidates.map((item) => item.hash)) };
  }

  const messages: Array<{ index: number; hash: string; text: string }> = [];
  let tokens = estTokens(JSON.stringify({ goal, messages: [] }));
  for (let i = candidates.length - 1; i >= 0; i--) {
    const item = candidates[i];
    if (!item) continue;
    const entry = { index: item.index, hash: item.hash, text: textOf(item.message, SMALLEST_CAP) };
    const size = estTokens(JSON.stringify(entry));
    if (messages.length > 0 && tokens + size > budget) break;
    messages.unshift(entry);
    tokens += size;
  }
  return { state: { goal, messages }, tokens, included: new Set(messages.map((entry) => entry.hash)) };
}

/** Split the questions so state + questions stays inside one request budget. */
function batchFresh(fresh: Candidate[], stateTokens: number, budget: number): Candidate[][] {
  const available = budget - stateTokens;
  const batches: Candidate[][] = [];
  let current: Candidate[] = [];
  let used = 0;
  for (const item of fresh) {
    const size = estTokens(QUESTION) + estTokens(item.hash) + 30;
    if (current.length > 0 && used + size > available) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Jev-guided context reduction: a compaction summary, plus in-place pruning of the live array. */
export class JevCompactor {
  public enabled: boolean;
  private failStreak = 0;
  private breakerUntil = 0;

  constructor(private jevClient: JevClient, enabled = false) {
    this.enabled = enabled;
  }

  public setEnabled(enabled: boolean): void { this.enabled = enabled; }

  /** Drop the frozen scores and the breaker: the next pass judges everything again. */
  public reset(cwd: string): void {
    saveScores(cwd, {});
    this.failStreak = 0;
    this.breakerUntil = 0;
  }

  /** Two consecutive failures pause judging; a successful pass clears the breaker. */
  private noteFailure(c: Config): void {
    if (++this.failStreak >= 2) this.breakerUntil = Date.now() + c.breakerMs;
  }

  /** One bounded request: the configured timeout, plus Pi's own abort signal. */
  private async ask(
    request: Parameters<JevClient["evaluate"]>[0],
    signal: AbortSignal | undefined,
    timeoutMs: number
  ): Promise<Awaited<ReturnType<JevClient["evaluate"]>>> {
    const controller = new AbortController();
    const forward = () => controller.abort(signal?.reason);
    if (signal?.aborted) forward();
    else signal?.addEventListener("abort", forward, { once: true });
    const timer = setTimeout(() => controller.abort(new Error(`Jev compaction timed out after ${timeoutMs}ms`)), timeoutMs);
    try {
      return await this.jevClient.evaluate(request, controller.signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forward);
    }
  }

  /**
   * Score candidates into the sidecar and return the merged score map. Shared by the summary path
   * and the background pruning judge. An open breaker scores nothing, leaving the cache in charge.
   */
  private async scoreInto(
    candidates: Candidate[],
    goal: string,
    cwd: string,
    signal: AbortSignal | undefined,
    c: Config
  ): Promise<Record<string, ScoreRecord>> {
    const scores = loadScores(cwd);
    const fresh = Date.now() < this.breakerUntil ? [] : candidates.filter((item) => item.judge && !(item.hash in scores));
    if (fresh.length === 0) return scores;

    const { state, tokens, included } = fitState(candidates, goal, c.maxStateTokens);
    // Only the messages the state actually shows can be asked about: a question about a message the
    // state left out has no referent for Jev to answer against.
    const askable = fresh.filter((item) => included.has(item.hash));
    if (askable.length === 0) return scores;
    const batches = batchFresh(askable, tokens, c.maxRequestTokens);
    const responses = await Promise.all(
      batches.map((batch) => {
        const questions: Record<string, { type: "noul"; instructions: string }> = {};
        for (const item of batch) questions[`keep_${item.hash}`] = { type: "noul", instructions: QUESTION };
        return this.ask({ state, questions }, signal, c.timeoutMs);
      })
    );

    const at = new Date().toISOString();
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i] ?? [];
      for (const item of batch) {
        // Read the provider's own answer, never the reporting value: `JevAnswerResult.value` falls
        // back to 0, which is indistinguishable from a real 0 and would drop history. An unanswered
        // message stays uncached and is therefore kept verbatim.
        const value = noulProbability(responses[i]?.answers[`keep_${item.hash}`]?.raw);
        if (value !== null) scores[item.hash] = { keep: value, at };
      }
    }
    saveScores(cwd, scores);
    this.failStreak = 0;
    this.breakerUntil = 0;
    return scores;
  }

  /** The compaction summary Pi substitutes for the messages it is about to discard. */
  public async compact(event: any, ctx: ExtensionContext): Promise<CompactResult> {
    const c = compactSettings();
    const off = { summary: "", kept: 0, truncated: 0, dropped: 0, considered: 0 };
    if (!this.enabled) return { ...off, skipped: "disabled" };
    if (!this.jevClient.isConfigured()) return { ...off, skipped: "unconfigured" };

    const candidates = toCandidates(discardedMessages(event));
    if (candidates.length === 0) return { ...off, skipped: "empty" };

    const cwd = ctx?.cwd ?? process.cwd();
    try {
      const scores = await this.scoreInto(candidates, event.customInstructions ?? ONGOING, cwd, event.signal, c);

      const lines: string[] = [];
      let kept = 0;
      let truncated = 0;
      let dropped = 0;
      for (const item of candidates) {
        // Unscored means unjudged: kept verbatim rather than dropped on the strength of a score we
        // do not have.
        const decision: Decision = item.judge ? decide(scores[item.hash]?.keep ?? 1, c) : "keep";
        if (decision === "drop") {
          dropped++;
          continue;
        }
        if (decision === "truncate") {
          truncated++;
          lines.push(`[message ${item.index}] ${truncateHead(rawTextOf(item.message), c.headChars)}`);
          continue;
        }
        kept++;
        lines.push(`[message ${item.index}] ${keptText(item.message, MAX_TEXT_CHARS)}`);
      }

      const summary = [
        "Jev compaction summary (tool history retained selectively; user/assistant intent preserved):",
        event.customInstructions ? `Goal: ${event.customInstructions}` : "",
        lines.length ? lines.join("\n") : "No historical messages were judged necessary to retain.",
      ].filter(Boolean).join("\n");
      return { summary, kept, truncated, dropped, considered: candidates.length };
    } catch {
      this.noteFailure(c);
      return { ...off, considered: candidates.length, skipped: "error" };
    }
  }

  /**
   * Score the prunable window into the sidecar, for the in-place pruning path. Rewrites nothing:
   * the context hook only ever applies decisions frozen at a checkpoint.
   */
  public async judge(messages: any[], cwd: string, signal?: AbortSignal): Promise<void> {
    const c = compactSettings();
    if (!this.enabled || !this.jevClient.isConfigured()) return;

    const { from, to } = prunableWindow(messages.length, c);
    const candidates = toCandidates(messages.slice(from, to));
    if (candidates.length === 0) return;
    try {
      await this.scoreInto(candidates, inferGoal(messages), cwd, signal, c);
    } catch {
      this.noteFailure(c);
    }
  }

  /**
   * The changes the live message array needs, keyed by tool-call id, from the frozen scores. Only
   * pairs that need changing appear — an absent id means keep — so an empty map lets the context
   * hook return without walking the messages. An unscored call is kept, and the first message plus
   * the newest recentMessages are never touched.
   */
  public planPrune(messages: any[], cwd: string, activeRun: boolean): Map<string, Decision> {
    const c = compactSettings();
    const scores = loadScores(cwd);
    const { from, to } = prunableWindow(messages.length, c);

    const decisions = new Map<string, Decision>();
    for (const pair of pairCalls(messages)) {
      // callIndex is never past resultIndex, so the two checks protect both ends of the pair.
      const position = pair.resultIndex ?? pair.callIndex;
      if (pair.callIndex < from || position >= to) continue;
      const decision = decide(scores[pair.scoreKey]?.keep ?? 1, c);
      // While an agent run is live a dropped call would break the causal chain the model is
      // following; it stays as a truncated breadcrumb until the next checkpoint after the run.
      const effective = activeRun && decision === "drop" ? "truncate" : decision;
      if (effective !== "keep") decisions.set(pair.callId, effective);
    }
    return decisions;
  }
}
