# pi-jev-tools

Semantic tool routing and typed decisions for the [Pi coding agent](https://pi.dev) powered by [TypeSafe](https://typesafe.ai) Jev (System One).

## Features

- **Semantic Tool Router (`jev_find_tools`)**: Automatically searches registered inactive tools and additively activates only the tools needed for the user's specific prompt or workflow.
- **Skill Discovery (`jev_find_skill`)**: Semantically matches and suggests the most relevant specialized agent skills (`SKILL.md`) for any task without cluttering prompt context.
- **Typed Judgments (`jev_evaluate`)**: Run fast, calibrated System One decisions directly from the agent using Choice, Noul (yes/no probability), and Score primitives. The tool itself is registered by the separate [pi-jev-core](https://github.com/morler/pi-jev-core) package — this extension only consumes its judgment core.
- **Four Jev API Platforms**: Reach Jev directly on the TypeSafe API or through OpenRouter, Cloudflare AI Gateway, or Vercel AI Gateway via `JEV_PLATFORM`. Tools, skills, gates, typed agent, and auto modes all follow the selected platform.
- **Dynamic Evaluations (`/jev test <prompt>`)**: The active model designs the Jev question schema for a free-form prompt, then Jev evaluates it.
- **Automatic Mode (opt-in)**: `--jev-auto` / `PI_JEV_AUTO=1` / `/jev auto on` routes tools and suggests skills before every prompt. Off by default.
- **Automatic Model Mode (opt-in)**: `--jev-auto-model` / `PI_JEV_AUTO_MODEL=1` / `/jev auto-model on` asks Jev to classify each prompt (one System One request; image prompts and oversized contexts skip the call and count as heavy) and picks between two candidate models — light for simple tasks, heavy for demanding ones (pool defaults to `glm-5.5-flash` + `deepseek-v4-flash`; override with `autoModelPool` in `pi-jev.json`). Off by default.
- **Tool Call Guard (opt-in)**: `--jev-tool-guard` / `PI_JEV_TOOL_GUARD=1` / `/jev tool-guard on` intercepts tool calls with Jev to detect hallucinations and enhance failed results. Off by default.
- **Search Gate (opt-in)**: `--jev-search-gate` / `PI_JEV_SEARCH_GATE=1` / `/jev search-gate on` offers the `jev_search_gate` tool: Jev ranks web-search results, drops prompt-injection results, judges whether the evidence suffices, and picks the next query from your own candidates. Fails closed: when Jev is unavailable nothing is shortlisted (`selected_ids` empty), the local screen still reports what it caught, and `decision: unknown`. Off by default.
- **Jev Compaction (on by default)**: after install, `/compact` runs Jev compaction — important tool history is retained selectively while user intent is preserved — with Pi's built-in summary as fail-open fallback. `/jev compact off` or `PI_JEV_COMPACT=0` restores Pi's built-in compaction.
- **Agent Orchestration & Typed Agent**: `/jev agents <task>` dispatches `pi-subagents` orchestration; register `agent: "jev"` in workflows for instant sub-second typed judgments without LLM overhead.
- **Post-Run Gate Check (`jev-gate` CLI)**: Fast binary for subagent `gate` parameters (`npx pi-jev-gate -c "criteria"`). Checks git diff / output and exits 0 on pass or 1 on fail.
- **On-Demand & Safe**: Runs when called. No unsolicited per-turn API token costs. Fails closed safely: if Jev is unreachable or unconfigured, tool routing does not blindly activate unjudged tools and reports zero confidence on keyword fallbacks.
- **Cost Clarity**: Tool routing (`jev_find_tools`, `/jev auto`), skill discovery (`jev_find_skill`), evaluations (`jev_evaluate`, served by pi-jev-core), Jev subagents (`agent: "jev"`), and gate checks (`pi-jev-gate`) consume a Jev System One request. Auto-model spends one extra Jev request per prompt to pick the model tier; the topology fallback stays local.

## Installation

### Requirement: pi-jev-core

pi-jev-tools judges nothing by itself: every Jev call — the `JevClient`, platform routing, credential resolution, and answer normalization — comes from the [pi-jev-core](https://github.com/morler/pi-jev-core) package (public on GitHub), wired as a `"pi-jev-core": "file:../pi-jev-core"` dependency. **pi-jev-core is not on npm yet**, so the npm and GitHub one-liners below only work once it is published. For now, clone both repos side by side:

```bash
# from the directory that will hold both repos (they must be siblings)
git clone https://github.com/morler/pi-jev-core.git
git clone https://github.com/morler/pi-jev.git pi-jev-tools
cd pi-jev-tools && npm install
cd ..
pi install ./pi-jev-tools
```

The sibling layout is required: `pi-jev-tools` resolves its Jev core through `../pi-jev-core`, so moving or renaming one repo without the other breaks every Jev feature at load time.

Once pi-jev-core is published to npm, these work on their own:

```bash
pi install npm:pi-jev-tools
pi install git:github.com/TheoOliveira/pi-jev
```

pi-jev-core is itself a standalone Pi extension (it registers the `jev_evaluate` tool); installing pi-jev-tools brings it along through the dependency, so you never install both by hand.

Verify the wiring after install:

```text
/jev status
```

## Setup

Pick the Jev API platform with `JEV_PLATFORM` (default `typesafe`) and set that platform's credential:

| `JEV_PLATFORM`        | Credential                                                              | Default model      |
| --------------------- | ----------------------------------------------------------------------- | ------------------ |
| `typesafe` (default)  | `TYPESAFE_API_KEY`                                                      | `jev-latest`       |
| `openrouter`          | `OPENROUTER_API_KEY`                                                    | `typesafe/jev-1.13`|
| `cloudflare`          | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_GATEWAY_ID` | `typesafe/jev`     |
| `vercel`              | `AI_GATEWAY_API_KEY`                                                    | `typesafe-ai/jev`  |
| `jevk5` (local)       | none — optional `JEVK5_BASE_URL`                                        | `jevk5-4b-v0.2`    |

```bash
export TYPESAFE_API_KEY=ts_...          # default platform
export JEV_PLATFORM=openrouter          # or cloudflare / vercel
export OPENROUTER_API_KEY=sk-or-...
export JEV_MODEL=typesafe/jev-1.13      # optional model override, any platform
```

Or store each credential in Pi's secret store file (`~/.pi/agent/secrets/<name>`):

```bash
mkdir -p ~/.pi/agent/secrets
echo "ts_..."    > ~/.pi/agent/secrets/typesafe_api_key
echo "sk-or-..." > ~/.pi/agent/secrets/openrouter_api_key
echo "cf-token"  > ~/.pi/agent/secrets/cloudflare_api_token
echo "gw-key"    > ~/.pi/agent/secrets/ai_gateway_api_key
```

`JEV_PLATFORM` is read when Pi starts. Cloudflare also requires `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_GATEWAY_ID`; TypeSafe additionally honors `TYPESAFE_DEFAULT_MODEL`. `jevk5` routes evaluations to a local llama-server serving a JevK5 GGUF — no credential and no egress; set `JEVK5_BASE_URL` (default `http://127.0.0.1:8008`) if your server listens elsewhere.

Then check status inside Pi:

```text
/jev status
```

## Automatic Mode

Opt in to run one Jev routing pass before each agent turn (automatic mode costs one Jev request per prompt):

```bash
pi --jev-auto            # per-run CLI flag
export PI_JEV_AUTO=1     # persistent via environment
```

Toggle at runtime with `/jev auto on` or `/jev auto off` (no argument flips it); the same works for `/jev auto-model`, `/jev compact`, and `/jev auto-agents`. Every toggle is saved to `~/.pi/agent/pi-jev.json` (`PI_CODING_AGENT_DIR` is honored), so the next Pi session starts the way you left it. Precedence is CLI flag > `PI_JEV_*` env var > saved file; `/jev status` prints the config path and any env var shadowing it. Automatic mode:

- activates inactive tools whose usefulness probability clears `JEV_THRESHOLD` (0.65);
- injects matching skill recommendations into the turn;
- skips slash commands, empty prompts, and prompts while Jev is unconfigured or already evaluating;
- never throws — a Jev failure leaves the turn untouched.

`JEV_THRESHOLD` (in `src/skills.ts`) is the one act/reject cutoff: raise it for precision, lower it for recall. Every path — router, tools, `/jev skills`, auto mode — reads that same constant.

### Jev Gate CLI (`pi-jev-gate` / `jev-gate`)

Use `pi-jev-gate` as a post-run gate check for subagents or CI/CD pipelines. Evaluates git diff, file, or stdin against natural language criteria using Jev System One probability.

- Exits `0` if evaluation probability meets threshold ($\ge 0.70$ by default).
- Exits `1` if rejected.
- Exits `2` on error (or `0` with `--fail-open`).

#### Subagent `gate` Example
Set a child subagent's `gate` parameter to run `pi-jev-gate` immediately upon completion:

```json
{
  "agent": "worker",
  "task": "Refactor auth middleware to use jose",
  "gate": "npx pi-jev-gate -c 'Middleware strictly refactored without breaking exports and no new any types' -d -p 0.8"
}
```

#### Pipeline / CLI Examples
```bash
# Check git diff against acceptance criteria
npx pi-jev-gate -c "All exported functions have TypeScript type annotations" --diff

# Check piped test/linter output
npm test 2>&1 | npx pi-jev-gate -c "Zero test failures and no unhandled promise rejections"

# JSON output with custom threshold
npx pi-jev-gate -c "Documentation updated" -f ./README.md -p 0.85 --json
```

### Typed Jev Subagent (`agent: "jev"`)

Register fast System One evaluations directly in `pi-subagents` workflows without spawning heavy LLM processes.

#### Workflow Example
```javascript
export const meta = { name: "triage_workflow", description: "Classify and route tasks" };

// 1. Instant typed classification with Jev
const triage = await agent("Classify incoming issue", {
  agent: "jev",
  type: "choice",
  criteria: {
    bug: "Bug or regression in existing behavior",
    feature: "New capability request",
    docs: "Documentation or comment update"
  },
  state: args.issueBody
});

// 2. Route dynamically based on System One verdict
if (triage.primaryValue === "bug") {
  await agent("Fix reported bug and add test", { agent: "worker", task: args.issueBody });
}
```

### Agent Orchestration

`/jev agents <task>` uses Jev System One to analyze task requirements and construct specialized multi-agent workflow scripts executed via `pi-subagents`:
- **Implementation tasks**: Staged `scout` (code context) $\rightarrow$ `worker` (changes) $\rightarrow$ `reviewer` (standards & tests).
- **Research tasks**: Parallel `scout` + `researcher` $\rightarrow$ `worker` synthesis.
- **Review / Security tasks**: Parallel `reviewer` + `evidence-auditor`.
- **General tasks**: `worker` $\rightarrow$ `reviewer`.

Execution is asynchronous; completion is reported back into the session. Automatic dispatch is opt-in via `--jev-agents` / `PI_JEV_AGENTS=1` or `/jev auto-agents on`.

Under the hood the command builds a backend-neutral `WorkflowPlan` (JSON nodes with `id`, `agent`, `needs`, and literal prompt `segments` — task text passes through verbatim, never parsed) and hands it to an `OrchestrationBackend`. The default backend compiles the plan to a `pi-subagents` workflow script and dispatches it over the `subagents:rpc:v1` event pair. Another subagent extension can take over by implementing `spawn(plan)` (plus optional `onCompleted`) and injecting it into `AgentOrchestrator` — no pi-jev changes required.

### Jev Compaction

Jev compaction is on by default: after install, `/compact` produces the Jev summary instead of Pi's built-in one. `/jev compact off` (persisted) or `PI_JEV_COMPACT=0` restores the built-in path. Every message Pi is about to discard (`preparation.messagesToSummarize`) is scored by Jev, and the score picks one of three bands: **keep** (its text in the custom summary, with a marker when it was longer than the per-message cap), **truncate** (head plus a re-run marker naming how much was dropped), or **drop** (absent from the summary). Nothing is shortened silently. User prose is intent and is never dropped. The feature preserves Pi's `firstKeptEntryId` boundary and falls back to Pi's built-in summary when Jev is unconfigured, fails, or returns unusable data. It does not silently truncate context.

Scores are frozen by content hash in `.pi/pi-jev.compact.json` (gitignored), keyed by the message **and the goal it was judged against**: an unchanged message under the same task is never judged twice, while a different task is judged again, because the task is part of the question. Records older than a week are dropped when the cache is written. Tune the bands with environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `JEV_COMPACT_KEEP` | `0.55` | score at or above this keeps the message verbatim |
| `JEV_COMPACT_DROP` | `0.25` | score at or above this truncates to the head; below it the message is dropped |
| `JEV_COMPACT_HEAD` | `300` | characters of a truncated message to keep |
| `JEV_COMPACT_MAXSTATE` | `25000` | estimated-token ceiling for the state Jev reasons over |
| `JEV_COMPACT_MAXREQ` | `30000` | per-request ceiling (state + questions); questions are batched to fit |
| `JEV_COMPACT_TIMEOUT` | `20000` | per-request timeout in ms |
| `JEV_COMPACT_BREAKER` | `120000` | pause after two consecutive failures, in ms |
| `JEV_COMPACT_RECENT` | `6` | newest messages pruning never touches |
| `JEV_COMPACT_TTL` | `300000` | prefix-cache TTL in ms: how long a pruned prompt stays frozen |
| `JEV_COMPACT_GAP` | `30000` | minimum interval between background judging passes, in ms |
| `JEV_COMPACT_PRUNE` | on | set to `0` to keep compaction but disable in-place pruning |
| `JEV_COMPACT_GOAL` | last 3 user prompts | fixed task description sent to Jev |

An unparsable value keeps the default. Deleting the score file only forces re-judging.

Two inversions are corrected rather than obeyed: `JEV_COMPACT_KEEP` and `JEV_COMPACT_DROP` are read as an unordered pair, so the higher value is always the keep band and an inverted pair cannot empty the truncate band, and `JEV_COMPACT_MAXREQ` is raised above `JEV_COMPACT_MAXSTATE` (a request budget at or below the state budget leaves no room for questions and fans a pass out to one request per message). A negative `JEV_COMPACT_RECENT` falls back to the default. `/jev compact status` prints the effective bands.

Long histories stay inside those ceilings rather than failing: the state is re-extracted with shorter per-message text until it fits `JEV_COMPACT_MAXSTATE` (past the smallest cap the oldest messages are left out of the state, and so are not asked about either — an unasked message is kept verbatim), and the questions are split across requests so state + questions fits `JEV_COMPACT_MAXREQ`. Every request is bounded by `JEV_COMPACT_TIMEOUT`, and two consecutive failures pause judging for `JEV_COMPACT_BREAKER` — during that pause compaction still runs, keeping every message verbatim because an unscored message is never dropped.

#### In-place pruning

Compaction only runs when Pi asks for it. The same scores also let Jev shrink the live prompt before that point, so the context lasts longer instead of being summarised earlier. Tool calls and their results are paired (`toolCallId`), because pi-ai requires a call and its result to travel together: a **drop** removes both, a **truncate** shortens the result to its head plus a re-run marker, and everything else is untouched.

Judging runs in the background after an agent run settles (`agent_settled`), at most once per `JEV_COMPACT_GAP`, and only writes scores — it never rewrites messages. The `context` hook is the single place messages change, and it refreshes its decisions only at a checkpoint where a full-prefix cache miss is already paid or free:

- **cold** — the provider's prefix cache is stale (`Date.now() - lastResponseAt > JEV_COMPACT_TTL`), or no response has been served yet this session;
- **no-cache** — the provider never writes cache (`cacheRead` and `cacheWrite` both zero for three turns), so pruning is always free;
- **pressure** — usage is past Pi's own safe-input ceiling (`contextWindow - reserveTokens`, read from Pi's compaction settings), so the next request misses the cache anyway. One pass per armed episode (ARMED → AWAITING_VALIDATION → ARMED or EXHAUSTED), validated by the next real post-turn usage: a pass that did not bring usage back inside is not repeated, and Pi's compaction takes over.

Between checkpoints the same decisions are re-applied, so the prompt prefix stays byte-stable. While an agent run is live, **drop** is held back as **truncate** — the call stays as a breadcrumb — and promotes at the next checkpoint after the run settles. The first message and the newest `JEV_COMPACT_RECENT` messages are never touched, and an unscored call is never dropped.

Because pruning keeps usage under Pi's ceiling, Pi's own **threshold** compaction is cancelled while it can be — that is Pi's early reaction to pressure, and pruning covers it. Manual `/compact` and overflow recovery always pass through to the summary path, and an unknown boundary always lets Pi compact.

### Automatic Model Mode

Auto-model uses task signals, attached images, and context size to choose the best available model. It respects `ctx.scopedModels`, skips low-confidence general prompts, and preserves the current model when no compatible option exists. Models that hit quota, rate-limit, timeout, or context-limit errors are temporarily avoided on later prompts; fallback is bounded and never loops. Provider failures do not silently truncate user context.

## Commands

- `/jev status` — Shows Jev configuration (and where the API key came from), auto-mode state, session request count, total tokens, available tool counts, and the kept/truncated/dropped counts of the last compaction.
- `/jev help` — Lists available subcommands.
- `/jev skills [query]` — Discover and rank matching skills in the workspace using Jev.
- `/jev test [prompt]` — With no prompt, runs the fixed connectivity smoke test. With a prompt, the active model designs the Jev questions for that prompt and Jev evaluates them. Also accepts `/jev eval` and `/jev evaluate`.
- `/jev enable` — Enables Jev tools in the active session.
- `/jev disable` — Disables Jev tools for the active session.
- `/jev auto [on|off]` — Turns automatic per-prompt tool/skill routing on or off (no argument flips it).
- `/jev auto-model [on|off]` — Turns automatic model selection on or off (no argument flips it).
- `/jev tool-guard [on|off]` — Turns tool call anti-hallucination validation and error guidance on or off.
- `/jev search-gate [on|off]` — Turns the `jev_search_gate` search-ranking tool on or off.
- `/jev compact [on|off]` — Turns Jev-guided compaction on or off (on by default; `/compact` runs it).
- `/jev compact status` — Shows in-place pruning state: pressure episode, agent-run flag, no-cache streak, pending changes, and the cache/judge timings.
- `/jev compact reset` — Clears the frozen scores, the applied decisions, the breaker, and the pressure state.
- `/jev compact now` — Scores the history and applies the pruning decisions immediately, accepting one prompt-cache miss.
- `/jev agents <task>` — Dispatches the task to `pi-subagents`, which selects and coordinates available agents.
- `/jev auto-agents [on|off]` — Enables automatic orchestration for complex architecture, refactoring, security, repository-wide, and migration prompts.

## Tools Provided

### 1. `jev_compact_now`
Same as `/jev compact now`: score the history with Jev and apply the pruning decisions now, accepting one prompt-cache miss. Takes no parameters.

### 2. `jev_find_tools`
Used by the model to find capabilities that aren't currently loaded into the prompt prefix.

```json
{
  "query": "inspect SQLite database schemas and run queries"
}
```

### 3. `jev_find_skill`
Used by the agent to find relevant specialized workflows and instructions for complex tasks.

```json
{
  "query": "build accessible modal component in React"
}
```

### 4. `jev_evaluate`
Registered by [pi-jev-core](https://github.com/morler/pi-jev-core), not by this extension. Used for structured decisions, classifications, triage, and scoring.

### 5. `jev_search_gate`
One round of search decisions after a web or API search: Jev ranks which results are worth reading, drops results carrying injected instructions, judges whether the evidence already answers the question, and picks the next query from your own candidates. Fails closed: when Jev is unavailable nothing is shortlisted (`selected_ids` empty), the local screen still reports what it caught, and `decision` is `"unknown"`.

```json
{
  "state": { "diff": "..." },
  "questions": {
    "is_breaking": {
      "type": "noul",
      "instructions": "Does this change introduce any breaking API changes?"
    }
  }
}
```

## Development & Testing

```bash
npm install
npm run typecheck
npm test
```

## License

MIT © Theophilo Damiao
