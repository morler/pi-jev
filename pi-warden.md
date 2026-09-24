# No hardcoded secrets

Source code must not contain passwords, API keys, tokens, or connection URLs with credentials.
Read them from the environment, a function parameter, or the config module.

# Comments explain why, not what

A comment states a reason, a constraint, a workaround, or a non-obvious invariant. A comment
that restates what the next line plainly does is a violation.

# Errors are not swallowed

A `catch` block must handle the error, report it, or re-raise it. An empty catch block, or
one whose body is only a comment, is a violation.

# No partial implementations

Implement features fully. A comment that says "for now", "simplified", or "later", or a
stub body, is a violation. If a part genuinely cannot be done, say so in your reply instead
of stubbing it.

# Do not run destructive commands that erase uncommitted work

`git reset --hard`, `git checkout -- .`, `git clean -fd`, and similar commands that discard
untracked or uncommitted changes are forbidden. These destroy work that has no backup. If a
clean tree is needed, create a worktree instead or ask the user.

# No explicit any

TypeScript source must not use the explicit `any` type. Use precise types, `unknown` with
narrowing, or generics instead.

paths: **/*.ts, **/*.tsx

# Exported functions declare their return type

Every exported function in src must state its return type explicitly; inferred return types
on exports are a violation.

paths: src/**/*.ts

# Jev integration fails closed

When Jev is unreachable, unconfigured, or returns unusable data, the feature must not
blindly proceed: tool routing activates no unjudged tools, keyword fallbacks report zero
confidence, and compaction falls back to Pi's built-in summarizer. Failing open or
defaulting to permissive behavior is a violation.

# Never drop or silently truncate user content

In compaction and pruning, user prose is intent and is never dropped. An unscored message
or tool call is never dropped. Every keep/truncate/drop decision is visible; nothing is
shortened without a marker naming what was removed.

# Tool calls and results travel together

Pruning must never remove a tool call without its paired result (matched by toolCallId), or
a result without its call. A drop removes both; a truncate keeps the call as a breadcrumb.

paths: src/compact*.ts, src/compaction*.ts, src/prune*.ts

# Single source of truth for thresholds

Every act/reject cutoff reads the same named constant (e.g. `JEV_THRESHOLD` in src/skills.ts).
Do not duplicate a threshold literal in a second call site.

# Config precedence is CLI flag > environment variable > saved file

The `PI_JEV_*` environment variables override values in pi-jev.json (pi-jev.json is
PI_CODING_AGENT_DIR-aware); a saved toggle never overrides an env var or CLI flag. New
switches must follow this precedence and persist to the config module, not ad-hoc files.

# Model routing must be conservative

Auto-model preserves the current model when no signal, no compatible candidate, or a
blocked/missing/failed switch exists. Models that hit quota, rate-limit, timeout, or
context-limit errors are temporarily avoided; fallback is bounded and never loops.

# Prefix stability between checkpoints

Between pruning checkpoints the applied decisions are re-applied byte-identically so the
prompt prefix stays stable. In-place pruning writes only at a checkpoint where a full-prefix
cache miss is already paid or free (cold, no-cache, or pressure).
