import { choice, noul, score } from "@typesafe-ai/sdk";
import {
  callJev,
  credentialHint,
  resolveCredential,
  resolveModel,
  resolvePlatform,
  type JevPlatform,
} from "./platform.js";
import type {
  JevEvaluationRequest,
  JevEvaluationResponse,
  JevAnswerResult,
  JevSessionStats,
} from "./types.js";

/**
 * The noul probability the provider actually gave, or null when it gave none.
 *
 * `JevAnswerResult.value` falls back to 0 so reporting code always has a number, which makes "no
 * answer" indistinguishable from "answered zero". Anything that has to tell them apart reads through
 * here instead — compaction does, because a low score drops history.
 */
export function noulProbability(rawAnswer: unknown): number | null {
  const raw = rawAnswer as { noul?: unknown; probability?: unknown; value?: unknown };
  const value = raw?.noul ?? raw?.probability ?? raw?.value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export class JevClient {
  /** Platform this client talks to, fixed for the process lifetime. */
  public readonly platform: JevPlatform = resolvePlatform();
  private apiKey: string | null = null;
  public stats: JevSessionStats = {
    requestsCount: 0,
    totalTokens: 0,
  };

  public isConfigured(): boolean {
    return Boolean(resolveCredential(this.platform) || this.apiKey);
  }

  /** Human-readable description of where the API key came from, or null when unconfigured. */
  public getKeyOrigin(): string | null {
    if (this.apiKey) return "set in-session";
    return resolveCredential(this.platform)?.origin ?? null;
  }

  public setApiKey(key: string): void {
    this.apiKey = key;
  }

  public async evaluate(
    request: JevEvaluationRequest,
    signal?: AbortSignal
  ): Promise<JevEvaluationResponse> {
    const startTime = Date.now();
    // An in-session key set via setApiKey() overrides the environment and secret file.
    const apiKey = this.apiKey ?? resolveCredential(this.platform)?.key;
    if (!apiKey) {
      throw new Error(
        `Missing Jev API key for the ${this.platform} platform. ${credentialHint(this.platform)}.`
      );
    }

    const questions: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(request.questions)) {
      if (q.type === "choice") {
        questions[id] = choice(q.instructions, q.criteria);
      } else if (q.type === "noul") {
        questions[id] = noul(q.instructions);
      } else if (q.type === "score") {
        questions[id] = score(q.instructions, q.criteria as any);
      }
    }

    const state: unknown =
      typeof request.state === "string" ? { text: request.state } : request.state;
    const model = resolveModel(this.platform, request.model);

    try {
      const response = await callJev(this.platform, apiKey, { state, questions, model, signal });

      const elapsedMs = Date.now() - startTime;
      this.stats.requestsCount += 1;
      const tokens = response.usage?.totalTokens || 0;
      this.stats.totalTokens += tokens;
      this.stats.lastElapsedMs = elapsedMs;

      const answers: Record<string, JevAnswerResult> = {};
      for (const [id, rawAns] of Object.entries(response.answers)) {
        const qConfig = request.questions[id];
        if (!qConfig) continue;

        const raw = rawAns as any;
        // The Vercel AI Gateway answers with gateway types and reports confidence out of band.
        const confidence = raw?.confidence ?? response.confidence?.[id];

        if (qConfig.type === "choice") {
          answers[id] = {
            type: "choice",
            value: raw?.choice ?? raw?.value,
            confidence,
            distribution: raw?.distribution ?? raw?.probabilities,
            raw: rawAns,
          };
        } else if (qConfig.type === "noul") {
          answers[id] = {
            type: "noul",
            value: raw?.noul ?? raw?.probability ?? raw?.value ?? 0,
            raw: rawAns,
          };
        } else if (qConfig.type === "score") {
          answers[id] = {
            type: "score",
            value: raw?.score ?? raw?.value ?? 0,
            confidence,
            raw: rawAns,
          };
        }
      }

      return {
        answers,
        model: response.model || model,
        usage: response.usage,
        elapsedMs,
      };
    } catch (err: any) {
      this.stats.lastError = err?.message || String(err);
      throw err;
    }
  }
}
