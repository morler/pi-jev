# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Pressure checkpoint for in-place pruning: real usage is compared against Pi's own safe-input ceiling (its compaction `reserveTokens`), and one pass per armed episode (ARMED → AWAITING_VALIDATION → ARMED/EXHAUSTED) refreshes the decision set when the next request would miss the cache anyway. A pass that does not bring usage back inside is not repeated. Pi's **threshold** compaction is now cancelled while pruning can cover it; manual and overflow compactions always pass through.
- `/jev compact status|reset|now` and the `jev_compact_now` tool expose the pruning path: state, a full reset of scores/decisions/breaker/pressure, and a manual pass that accepts one cache miss. `now` reports the decisions it queued (the rewrite itself lands on the next request).
- Jev-guided in-place pruning: the same frozen scores now shrink the live prompt from the `context` hook, pairing each tool call with its result so a drop removes both. Judging runs in the background on `agent_settled` and only writes scores; the decision set refreshes only at a checkpoint where a prefix-cache miss is already paid (cold cache, `JEV_COMPACT_TTL`) or free (a provider that writes no cache), and stays byte-stable in between. While an agent run is live, drops are held back as truncates. The first message and the newest `JEV_COMPACT_RECENT` messages are never touched, and `JEV_COMPACT_PRUNE=0` disables pruning while keeping compaction.
- Jev compaction stays inside a request budget: the state is re-extracted with shorter per-message text until it fits `JEV_COMPACT_MAXSTATE`, the questions are batched so state + questions fits `JEV_COMPACT_MAXREQ`, each request is bounded by `JEV_COMPACT_TIMEOUT`, and two consecutive failures pause judging for `JEV_COMPACT_BREAKER`. An unscored message is kept verbatim, so a failed or skipped judging pass can never drop history.
- Jev compaction now scores every message Pi is about to discard (`preparation.messagesToSummarize` plus any split-turn prefix) instead of the oldest 24 branch entries, and splits the score into three bands: keep verbatim, truncate to a head with a re-run marker, or drop from the summary. Bands are tunable via `JEV_COMPACT_KEEP`, `JEV_COMPACT_DROP`, and `JEV_COMPACT_HEAD`.
- Compaction scores are frozen by content hash in `.pi/pi-jev.compact.json`, so an unchanged message is never judged twice and re-compacting a stable history costs no Jev requests.
- Jev API platform selection via `JEV_PLATFORM`: `typesafe` (default), `openrouter`, `cloudflare`, and `vercel`. Tools, skills, gate CLI, typed agent, auto mode, and compaction all follow the selected platform.
- Per-platform credential resolution from environment variables or Pi secret files (`openrouter_api_key`, `cloudflare_api_token`, `ai_gateway_api_key`), plus `JEV_MODEL` as a model override for any platform.
- `/jev status` reports the active platform, and error messages name the missing credential for it.
- `/jev status` and the compaction status line report kept, truncated, and dropped counts.
- Global switch persistence: `/jev auto|auto-model|compact|auto-agents [on|off]` writes `~/.pi/agent/pi-jev.json` (`PI_CODING_AGENT_DIR` honored), so automatic mode, auto-model, Jev compaction, and agent orchestration start the next Pi session the way you left them. Precedence is CLI flag > `PI_JEV_*` env var > saved file. `/jev status` names the path plus any shadowing env var, and a toggle that an env var would override says so instead of claiming a clean save.

### Changed

- Jev compaction is on by default: installing pi-jev makes `/compact` (manual, threshold, and overflow) produce the Jev summary instead of Pi's built-in one. Pi's summarizer remains the fail-open fallback when Jev is unconfigured or fails, and `/jev compact off` or `PI_JEV_COMPACT=0` restores the opt-in behavior.

### Fixed
- A Jev compaction that fails mid-flight now says so instead of falling back in silence: the status line reports `jev: compact failed → Pi's summarizer ran`, and `jev: nothing to compact → Pi's summarizer ran` when there was no text to judge, so a built-in summary is no longer indistinguishable from Jev's own. An off switch and a missing credential stay quiet, since those are configuration rather than failure.
- A frozen score is now keyed by the goal it was judged against as well as by the message, and all three call sites derive that goal the same way, so a decision is never taken against a task description the message was never judged with. The compaction path no longer folds its custom instructions into the goal, since `judge`/`planPrune` never see them and a goal only one path knows would freeze scores the other never reuses. A goal longer than 600 chars (a pasted document) is clipped, since `fitState` never shrinks the goal itself.
- The score key hashes the whole message rendering, tool-call arguments included: two calls differing only deep in their arguments no longer collide on a stale score.
- `scoreInto` merges its answers into a freshly read cache instead of writing back the snapshot it took before the round-trips, so an overlapping pass or a `/jev compact reset` is no longer clobbered. Records older than a week are evicted on write, which is the only thing bounding the file.
- An inverted threshold pair (`JEV_COMPACT_DROP` above `JEV_COMPACT_KEEP`) is read as an unordered pair, so the higher value is always the keep band and the truncate band stays reachable; the old clamp set both equal and emptied the band it claimed to protect. A request budget at or below the state budget is raised instead of fanning out one request per message. A negative `JEV_COMPACT_RECENT` falls back to the default rather than exposing the newest messages the window promises never to touch. `/jev compact status` prints the effective bands.
- A saved switch that is not a boolean (`"compact": "off"`) is coerced the way the env path coerces it, instead of a truthy string enabling the switch against the file's intent. `/jev status` now lists only the `PI_JEV_*` vars that actually change a switch from the saved file, instead of every set var. `/jev status` also reports the kept/truncated/dropped counts of the last compaction. The unused `JevClient.setApiKey` was removed.
- A toggle whose write failed is reported as session-only rather than saved, and `/jev compact now` no longer prints a progress line that its own result can contradict.
- `ctx.getContextUsage()` is guarded like the rest of the Jev integration: an exception there used to reject the `turn_end` and `context` handlers and surface as a broken request.
- A failed provider response no longer refreshes the cold-checkpoint clock: only a served request re-caches the prefix, so pruning does not stall for a whole TTL after provider errors.
- The pressure boundary is only read while pruning is on, and `.gitignore` uses `.pi/*` plus a negation so the tracked `.pi/settings.json` is not excluded by its parent directory.
- A question is now keyed to the message it asks about: state entries carry the hash each question is keyed by, so Jev can answer against a specific message. Messages the state had to omit (a history too large even at the smallest text cap) are no longer asked about, since such a question has no referent.
- A corrupt score record in the cache (a non-numeric `keep`, from a hand-edited file) is dropped on read rather than trusted: it compared false against every band and would have silently dropped the message. An unscored message is kept verbatim.
- A malformed Jev answer (`null`, `""`, `[]`, `false`) is no longer coerced to a finite `0` and frozen as a score of zero, which the drop band would then have acted on. The root cause was `JevAnswerResult.value` falling back to `0` for reporting, so compaction now reads the provider's own answer through `noulProbability`; only a number, or a non-empty numeric string, is accepted, and anything else stays uncached with the message kept.
- Scores are frozen against a message's FULL text, so an edit past the per-message cap is judged again instead of reusing a stale score.
- The keep band marks a message it had to clip, and the truncate band's "N chars omitted" now counts the real omission rather than the distance from the per-message cap. Nothing is shortened silently.
- Pi's threshold compaction is never cancelled on an unknown boundary, not even mid pressure episode. Pi's compaction settings being unreadable now reads as an unknown boundary instead of reserve 0: the old fallback widened the ceiling to the whole window, which cancelled Pi's own threshold compaction for no reason. A failed settings import is no longer cached for the session.
- `/jev compact reset` no longer reports success when no pruning control is available, and it reports a score cache file it could not clear rather than claiming a wipe that did not happen.

### Changed
- `/jev status` reports the real credential origin (`$TYPESAFE_API_KEY` or the secret file) instead of always reporting "set in-session".
## [0.5.0] - 2026-09-20

### Added
- **Tool Guard**: Opt-in tool call validation and anti-hallucination interceptor (`--jev-tool-guard`, `PI_JEV_TOOL_GUARD=1`, `/jev tool-guard [on|off]`). Evaluates tool parameters with Jev System One to block hallucinated paths/flags and enhances error output with targeted recovery hints.

### Fixed
- **Safe Fallback**: When Jev is unreachable or unconfigured, tool router no longer auto-activates tools blindly and reports 0 probability rather than false certainty (1.0). Skill router only surfaces keyword matches with 0 probability (closes #1: "A failed request activates three tools and reports them at probability 1.0").
- Removed outdated reference to nonexistent `/jev login` in `jev_evaluate` error message.
- Documentation clarifies that heuristic routing (`/jev auto-model`, topology fallback) executes locally without spending Jev requests.

## [0.4.0] - 2026-09-18

### Added
- Jev Gate CLI binary (`bin/jev-gate.js`, exposed as `pi-jev-gate` and `jev-gate`) for subagent post-run `gate` checks and CI/CD validation. Evaluates git diff, stdin, or files against acceptance criteria with fast System One noul probability.
- Typed Jev Subagent (`agent: "jev"` / `agentType: "jev"`) handler in `pi-subagents` RPC for sub-second, zero-LLM-overhead choice, score, and probability decisions inside workflows.

### Fixed
- `/jev agents <task>` now directly constructs multi-agent `workflowScript` topologies delegating to builtin agents (`scout`, `worker`, `reviewer`, `researcher`, `evidence-auditor`), replacing single `delegate` subagent calls.

## [0.3.0] - 2026-09-17

### Added
- Opt-in automatic model routing via `--jev-auto-model`, `PI_JEV_AUTO_MODEL=1`, and `/jev auto-model [on|off]`.
- Model profiles for fast, balanced, reasoning, long-context, and vision tasks. Selection respects scoped models and attached images.
- Provider-limit handling: quota, rate-limit, timeout, unavailable, auth, and context-limit errors are classified; retry-prone models are temporarily avoided on later prompts without loops or silent truncation.
- Opt-in Jev-guided `/compact` via `--jev-compact`, `PI_JEV_COMPACT=1`, or `/jev compact on`. Important tool history is retained in a custom compaction summary, with Pi's built-in summary as fail-open fallback.
- Explicit agent orchestration via `/jev agents <task>` and opt-in automatic orchestration via `--jev-agents`, `PI_JEV_AGENTS=1`, or `/jev auto-agents on`, using the installed `pi-subagents` RPC.

## [0.2.1] - 2026-09-17

### Documentation
- Add secret store key resolution option (`~/.pi/agent/secrets/typesafe_api_key`) to Setup section in README.

## [0.2.0] - 2026-09-17

### Added
- Dynamic evaluation command: `/jev test <prompt>` (aliases `/jev eval`, `/jev evaluate`) asks the session's active model to design the Jev question schema from the user's prompt, then runs it on TypeSafe Jev. `/jev test` alone still runs the fixed smoke test.
- Automatic mode: `--jev-auto` flag / `PI_JEV_AUTO=1` env var and `/jev auto [on|off]` command run one Jev routing pass before each prompt, activating tools and surfacing matching skills.

### Changed
- Single activation threshold `JEV_THRESHOLD` (0.65) in `src/skills.ts`, used by the router, both tools, `/jev skills`, and auto mode. `/jev skills` previously used 0.6, so manual skill search could show matches auto mode hid.

### Fixed
- Router no longer offers `pi-jev`'s own tools as routing candidates. After `/jev disable`, automatic routing used to re-activate `jev_find_skill` and `jev_evaluate`.
- `/jev` subcommands now match exactly, so `/jev autofoo on` and `/jev skillsfoo` report an error instead of silently toggling or searching.
- `/jev skills` discloses local heuristic fallback instead of presenting 1.00 probabilities as Jev judgments.
- `/jev status` reports where the API key came from (`$TYPESAFE_API_KEY` vs `~/.pi/agent/secrets/typesafe_api_key`) and counts only genuinely routable tools.
- `/jev help` lists usage at info level instead of warn-as-unknown-command.
- Router and skill fallback tests no longer depend on the machine being unconfigured.
- `npm run smoke` passes `-ne` so it no longer collides with an already-installed `pi-jev` copy.

## [0.1.1] - 2026-09-17

### Added
- `jev_find_skill` tool and `/jev skills [query]` command for semantic skill discovery and recommendation.

## [0.1.0] - 2026-09-17

### Added
- Initial public release of `pi-jev` package for the Pi coding agent.
- `jev_find_tools` tool for semantic candidate shortlisting and additive tool activation.
- `jev_evaluate` tool exposing typed TypeSafe Jev decisions (Choice, Noul, Score).
- `/jev` slash commands (`status`, `enable`, `disable`, `test`).
- Bounded TypeSafe client integration with safe error handling and usage accounting.
- Comprehensive unit test suite and CI workflows.
