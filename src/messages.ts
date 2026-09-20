import { createHash } from "node:crypto";

/**
 * Message-level primitives shared by the summary path (src/compact.ts) and the in-place pruning
 * path (src/prune.ts). Both must read a message and identify it the same way, because a score
 * frozen by one path is looked up by the other.
 */

/** Per-message text cap: what Jev sees, and the identity a score is frozen against. */
export const MAX_TEXT_CHARS = 900;

/** Content blocks of a message; a plain string body counts as one text block. */
export function blocksOf(message: any): any[] {
  const content = message?.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

/** Shorten text to `limit`, or leave it whole when the limit is null. */
export function clip(text: string, limit: number | null): string {
  return limit !== null && text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Tool-call arguments are clipped this far in the readable rendering; the score key is not. */
const ARG_LIMIT = 200;

/** All readable text of a message, with tool calls rendered as `name(args)`. */
export function rawTextOf(message: any, argLimit: number | null = ARG_LIMIT): string {
  const parts: string[] = [];
  for (const block of blocksOf(message)) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block?.type === "toolCall") {
      parts.push(`tool call ${block.name}(${clip(JSON.stringify(block.arguments ?? {}), argLimit)})`);
    }
  }
  const body = parts.join(" ").replace(/\s+/g, " ").trim();
  if (!body) return "";
  return `${message?.isError ? "(error) " : ""}${body}`;
}

export function textOf(message: any, limit: number): string {
  return clip(rawTextOf(message), limit);
}

/** The tool call a message answers, when the message is a toolResult. */
export function toolCallIdOf(message: any): string | null {
  return typeof message?.toolCallId === "string" ? message.toolCallId : null;
}

/** Tool-bearing messages are worth a Jev question; user prose is intent, kept without asking. */
export function needsJudgement(message: any): boolean {
  return message?.role === "assistant" || message?.role === "toolResult";
}

function hashOf(role: string, text: string): string {
  return createHash("sha1").update(`${role}\u0000${text}`).digest("hex").slice(0, 12);
}

/**
 * The key a score is frozen against, so both paths look up the same score for a message. It hashes
 * the whole rendering, arguments included: clipping any of it would let an edit past the cap reuse a
 * stale score, and two calls that differ only deep in their arguments would collide.
 */
export function scoreKeyOf(message: any): string {
  return hashOf(message?.role ?? "", rawTextOf(message, null));
}

/** A short stable hash of arbitrary text, for keys that are not a message identity. */
export function shortHash(text: string): string {
  return hashOf("", text);
}

/** Head of the text plus a marker naming what was dropped; short text is left alone, not annotated. */
function clipWithMarker(text: string, limit: number, marker: (omitted: number) => string): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[pi-jev: ${marker(text.length - limit)}]`;
}

/** Head of a tool result plus a re-run marker, for the truncate band. */
export function truncateHead(text: string, limit: number): string {
  return clipWithMarker(text, limit, (omitted) => `result truncated, ${omitted} chars omitted; re-run this tool before relying on its output`);
}

/** A kept message's full text, marked when it had to be clipped so nothing vanishes silently. */
export function keptText(message: any, limit: number): string {
  return clipWithMarker(rawTextOf(message), limit, (omitted) => `${omitted} chars omitted from this kept message`);
}
