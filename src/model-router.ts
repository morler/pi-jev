import type { ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { JevClient } from "./jev.js";

export type ModelTier = "light" | "heavy";
export type ModelErrorKind = "quota" | "rate-limit" | "context-limit" | "unavailable" | "timeout" | "auth" | "unknown";

export interface ModelRouteResult {
  changed: boolean;
  tier: ModelTier | null;
  model?: Model<Api>;
  reason: string;
  skipped?: "disabled" | "busy" | "unconfigured" | "no-match" | "no-judgment" | "no-model" | "error";
}

/** Noul probability at or above this means the prompt wants the strong pool model. */
const HEAVY_P = 0.6;
/** Noul probability at or below this means the fast pool model is plenty. */
const LIGHT_P = 0.3;
export function classifyModelError(error: unknown): ModelErrorKind {
  // SAFETY: providers throw both Error instances and plain objects carrying .message; read it off either shape.
  const text = String((error as unknown as { message?: string })?.message ?? error).toLowerCase();
  if (/context|too many tokens|token limit|maximum.*token|prompt too long/.test(text)) return "context-limit";
  if (/quota|credit|billing|insufficient.*fund|resource_exhausted/.test(text)) return "quota";
  if (/rate.?limit|too many requests|429/.test(text)) return "rate-limit";
  if (/timeout|timed out|deadline/.test(text)) return "timeout";
  if (/auth|unauthorized|forbidden|api key|401|403/.test(text)) return "auth";
  if (/model.*(not found|unavailable)|not available|503|502/.test(text)) return "unavailable";
  return "unknown";
}

/** Backoff before a failed pool model may be retried: billing/limit errors cool down 10 min, transient ones 1 min. */
function blockDurationMs(kind: ModelErrorKind): number {
  return kind === "quota" || kind === "rate-limit" ? 600_000 : 60_000;
}

/**
 * Switches between a two-entry candidate pool ([light, heavy]; see loadModelPool). The tier
 * comes from one Jev noul judgment per prompt ("does this need a strong reasoning model?"),
 * with the context size and image flag riding along as state. Between the
 * thresholds the answer is a coin flip, so the session simply stays on its current model.
 * Every failure path — Jev down, no key, no pool match, failed switch — keeps the current
 * model and never blocks the turn.
 */
export class AutoModelRouter {
  public enabled: boolean;
  private running = false;
  private blocked = new Map<string, number>();

  constructor(
    private pi: ExtensionAPI,
    enabled: boolean,
    private pool: string[],
    private jevClient: JevClient
  ) {
    this.enabled = enabled;
  }

  public setEnabled(enabled: boolean): void { this.enabled = enabled; }

  public recordProviderResponse(status: number, model?: Model<Api>): ModelErrorKind | undefined {
    if (!model || status < 400) return undefined;
    const kind: ModelErrorKind = status === 408 || status === 504 ? "timeout" : status === 401 || status === 403 ? "auth" : status === 413 ? "context-limit" : status === 429 ? "rate-limit" : status === 402 ? "quota" : status >= 500 ? "unavailable" : "unknown";
    if (["quota", "rate-limit", "context-limit", "unavailable", "timeout"].includes(kind)) {
      this.blocked.set(`${model.provider}/${model.id}`, Date.now() + blockDurationMs(kind));
    }
    return kind;
  }

  /** The pool entry for a tier: index 0 is light, index 1 heavy (extra entries are ignored). */
  private poolEntry(tier: ModelTier): string | undefined {
    return this.pool[tier === "heavy" ? 1 : 0];
  }

  /** First model matching a pool entry: provider-pinned entries match provider+id exactly (a HuggingFace mirror or a "-plus" variant can never win); bare entries stay a substring so version suffixes still hit. */
  private pick(tier: ModelTier, models: Model<Api>[], hasImages: boolean): Model<Api> | undefined {
    const entry = this.poolEntry(tier);
    if (!entry) return undefined;
    const slash = entry.indexOf("/");
    const wantProvider = slash > 0 ? entry.slice(0, slash) : undefined;
    const wantId = slash > 0 ? entry.slice(slash + 1) : entry;
    return models.find(
      (m) =>
        (wantProvider ? m.provider === wantProvider && m.id === wantId : m.id.includes(wantId)) &&
        (!hasImages || Boolean(m.input?.includes("image")))
    );
  }

  /** Tier judgment: one Jev noul call with two thresholds. */
  private async classify(prompt: string, contextChars: number, hasImages: boolean, signal?: AbortSignal): Promise<{ tier: ModelTier | null; reason: string }> {
    try {
      const response = await this.jevClient.evaluate(
        {
          state: { prompt, context_chars: contextChars, has_images: hasImages },
          questions: {
            strong_model: {
              type: "noul",
              instructions:
                "Probability this prompt needs a strong reasoning model instead of a fast cheap one. Strong-model work: planning, architecture, debugging, analysis, code review, refactoring, migrations, large-context synthesis, non-trivial image analysis, or non-trivial reasoning in any language. Image-bearing turns additionally require vision capability. Fast-model work: greetings, listings, renames, formatting, trivial lookups and edits.",
            },
          },
        },
        signal
      );
      const p = Number(response.answers["strong_model"]?.value);
      if (!Number.isFinite(p)) return { tier: null, reason: "Jev returned no usable probability" };
      if (p >= HEAVY_P) return { tier: "heavy", reason: `Jev P=${p.toFixed(2)} strong-model work` };
      if (p <= LIGHT_P) return { tier: "light", reason: `Jev P=${p.toFixed(2)} fast-model work` };
      return { tier: null, reason: `Jev P=${p.toFixed(2)} ambiguous — keeping current model` };
    } catch {
      return { tier: null, reason: "Jev classification failed — keeping current model" };
    }
  }

  public async route(prompt: string, ctx: ExtensionContext, options: { hasImages?: boolean } = {}): Promise<ModelRouteResult> {
    const current = ctx.model;
    const fallback: ModelRouteResult = { changed: false, tier: null, reason: "model selection skipped" };
    if (!this.enabled) return { ...fallback, skipped: "disabled" };
    if (this.running) return { ...fallback, skipped: "busy" };
    if (!this.jevClient.isConfigured()) return { ...fallback, skipped: "unconfigured" };
    if (!prompt.trim()) return { ...fallback, skipped: "no-match" };

    this.running = true;
    try {
      const contextChars = (ctx.getSystemPrompt?.() ?? "").length;
      const need = await this.classify(prompt, contextChars, Boolean(options.hasImages), ctx.signal);
      if (!need.tier) return { ...fallback, reason: need.reason, skipped: "no-judgment" };

      const models = (ctx.scopedModels?.length ? ctx.scopedModels.map((x) => x.model) : ctx.modelRegistry.getAvailable())
        .filter((model) => !this.blocked.get(`${model.provider}/${model.id}`) || (this.blocked.get(`${model.provider}/${model.id}`) ?? 0) < Date.now());
      const target = this.pick(need.tier, models, Boolean(options.hasImages));
      if (!target) return { ...fallback, tier: need.tier, reason: `no available model for pool entry "${this.poolEntry(need.tier) ?? "none"}"`, skipped: "no-model" };
      if (current?.provider === target.provider && current?.id === target.id) return { changed: false, tier: need.tier, model: target, reason: need.reason };

      try {
        await this.pi.setModel(target);
        return { changed: true, tier: need.tier, model: target, reason: need.reason };
      } catch (error) {
        const kind = classifyModelError(error);
        this.blocked.set(`${target.provider}/${target.id}`, Date.now() + blockDurationMs(kind));
        return { changed: false, tier: need.tier, model: current, reason: `model switch failed: ${kind}`, skipped: "error" };
      }
    } catch (error) {
      return { ...fallback, reason: `model selection failed: ${error instanceof Error ? error.message : String(error)}`, skipped: "error" };
    } finally {
      this.running = false;
    }
  }
}
