import { blocksOf, rawTextOf, scoreKeyOf, toolCallIdOf, truncateHead } from "./messages.js";

export type Decision = "keep" | "truncate" | "drop";

/** A tool call and, when present, the result message that answers it. */
export type Pair = {
  callId: string;
  /** Index of the message holding the call, and of the result message when one is present. */
  callIndex: number;
  resultIndex: number | null;
  /** Score key for the pair: the result's, or the call message's when no result is present. */
  scoreKey: string;
};

/**
 * Pair every tool call with the result answering it.
 *
 * pi-ai puts `toolCallId` on the toolResult MESSAGE rather than on a block, and a call and its
 * result have to travel together: removing one without the other makes the request invalid. So
 * pruning works on pairs, and a pair's score is the result's — the part that bloats the context.
 */
export function pairCalls(messages: any[]): Pair[] {
  const resultAt = new Map<string, number>();
  messages.forEach((message, index) => {
    const callId = toolCallIdOf(message);
    if (callId && !resultAt.has(callId)) resultAt.set(callId, index);
  });

  const pairs: Pair[] = [];
  messages.forEach((message, index) => {
    for (const block of blocksOf(message)) {
      if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
      const resultIndex = resultAt.get(block.id) ?? null;
      const source = resultIndex === null ? message : messages[resultIndex];
      pairs.push({
        callId: block.id,
        callIndex: index,
        resultIndex,
        scoreKey: scoreKeyOf(source),
      });
    }
  });
  return pairs;
}

export type PruneStats = { dropped: number; truncated: number; charsBefore: number; charsAfter: number };

/**
 * Rewrite the live message array: drop the call blocks and result messages of dropped pairs,
 * shorten truncated results to their head, and leave every other message byte-identical.
 */
export function applyPrune(
  messages: any[],
  decisions: Map<string, Decision>,
  headChars: number
): { messages: any[]; stats: PruneStats } {
  const dropIds = new Set<string>();
  const truncateIds = new Set<string>();
  for (const [callId, decision] of decisions) {
    if (decision === "drop") dropIds.add(callId);
    else if (decision === "truncate") truncateIds.add(callId);
  }

  const removed = new Set<string>();
  let truncated = 0;
  let charsBefore = 0;
  let charsAfter = 0;
  const out: any[] = [];

  for (const message of messages) {
    charsBefore += JSON.stringify(message).length;

    // A toolResult message answers exactly one call.
    const callId = toolCallIdOf(message);
    if (callId) {
      if (dropIds.has(callId)) {
        removed.add(callId);
        continue; // the whole result goes, so it contributes nothing to charsAfter
      }
      if (truncateIds.has(callId)) {
        const text = rawTextOf(message);
        const shortened = truncateHead(text, headChars);
        if (shortened !== text) {
          // Image blocks stay; every text block collapses into the one shortened text.
          const images = blocksOf(message).filter((block) => block?.type !== "text");
          const next = { ...message, content: [{ type: "text", text: shortened }, ...images] };
          truncated++;
          charsAfter += JSON.stringify(next).length;
          out.push(next);
          continue;
        }
      }
      charsAfter += JSON.stringify(message).length;
      out.push(message);
      continue;
    }

    // An assistant message: remove the call blocks whose pair is being dropped.
    const blocks = blocksOf(message);
    const kept = blocks.filter((block) => !(block?.type === "toolCall" && dropIds.has(block.id)));
    if (kept.length === blocks.length) {
      charsAfter += JSON.stringify(message).length;
      out.push(message);
      continue;
    }
    for (const block of blocks) {
      if (block?.type === "toolCall" && dropIds.has(block.id)) removed.add(block.id);
    }
    if (kept.length === 0) continue; // nothing left of this message: remove it
    const next = { ...message, content: kept };
    charsAfter += JSON.stringify(next).length;
    out.push(next);
  }

  return { messages: out, stats: { dropped: removed.size, truncated, charsBefore, charsAfter } };
}

// ---------- pressure ----------

export type PressureState = "armed" | "awaiting_validation" | "exhausted";

/** Tokens Pi may use before it treats the context as full. */
export function contextCeiling(contextWindow: number, reserveTokens: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
  const reserve = Number.isFinite(reserveTokens) ? Math.max(0, reserveTokens) : 0;
  return Math.max(0, contextWindow - reserve);
}

/** Whether usage is past Pi's ceiling, or null when either number is unknown. */
export type ContextBoundary = { overCeiling: boolean | null };

/**
 * Where the real usage sits against Pi's ceiling. overCeiling is null when either number is unknown,
 * and every caller treats null as "do not act".
 */
export function realContextBoundary(args: {
  tokens: number | null | undefined;
  contextWindow: number | null | undefined;
  reserveTokens: number;
}): ContextBoundary {
  const { tokens, contextWindow, reserveTokens } = args;
  if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0) return { overCeiling: null };
  const real = typeof tokens === "number" && Number.isFinite(tokens) ? Math.max(0, tokens) : null;
  return { overCeiling: real === null ? null : real > contextCeiling(contextWindow, reserveTokens) };
}

/**
 * One automatic pressure pass per episode: the next real post-turn usage validates it, and a pass
 * that did not bring usage back inside the ceiling is not repeated — Pi's own compaction takes over.
 */
export function reconcilePressure(state: PressureState, overCeiling: boolean | null): PressureState {
  if (state === "awaiting_validation") return overCeiling === false ? "armed" : "exhausted";
  if (state === "exhausted" && overCeiling === false) return "armed";
  return state;
}

/**
 * Pi's threshold compaction is its own early reaction to pressure; pruning covers that ground while
 * it can. Manual and overflow compactions are never cancelled, and an unknown boundary means no.
 */
export function cancelThresholdCompaction(args: {
  pruning: boolean;
  pressure: PressureState;
  overCeiling: boolean | null;
}): boolean {
  if (!args.pruning) return false;
  if (args.overCeiling === null) return false; // unknown boundary: never cancel
  if (args.pressure === "awaiting_validation") return true; // one turn validates the pruned prompt
  return args.overCeiling === false; // inside Pi's ceiling: compaction is not needed yet
}

