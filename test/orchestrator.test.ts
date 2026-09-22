import test from "node:test";
import assert from "node:assert/strict";
import {
  AgentOrchestrator,
  classifyTopologyFallback,
  determineTopology,
  buildWorkflowScript,
  buildWorkflowPlan,
  compilePiSubagentsScript,
} from "../src/orchestrator.js";
import type { OrchestrationBackend, WorkflowPlan } from "../src/orchestrator.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { JevClient } from "../src/jev.js";

/** Test double carrying the only ExtensionContext fields dispatch reads: ui.notify and signal. */
const stubCtx = (notify: (m: string) => void): ExtensionContext =>
  ({ ui: { notify }, signal: undefined }) as ExtensionContext;

test("classifyTopologyFallback categorizes tasks correctly", () => {
  assert.equal(classifyTopologyFallback("Fix broken authentication token handler"), "implementation");
  assert.equal(classifyTopologyFallback("Research best WebSockets libraries in Node"), "research");
  assert.equal(classifyTopologyFallback("Review security and code standards of this PR"), "review");
  assert.equal(classifyTopologyFallback("Say hello"), "general");
});

test("determineTopology uses JevClient evaluation when configured", async () => {
  const mockClient = new JevClient();
  mockClient.isConfigured = () => true;
  mockClient.evaluate = async () => ({
    answers: {
      topology: {
        type: "choice",
        value: "research",
      },
    },
    model: "jev-latest",
    elapsedMs: 20,
  });

  const topology = await determineTopology("Examine architecture tradeoffs", mockClient);
  assert.equal(topology, "research");
});

test("buildWorkflowScript outputs workflows delegating to builtin agents", () => {
  const implScript = buildWorkflowScript("Fix race condition in store", "implementation");
  assert.match(implScript, /runs\.run\("scout"/);
  assert.match(implScript, /runs\.run\("worker"/);
  assert.match(implScript, /runs\.run\("reviewer"/);

  const researchScript = buildWorkflowScript("Research vector DBs", "research");
  assert.match(researchScript, /runs\.all\(\[/);
  assert.match(researchScript, /agent:\s*"scout"/);
  assert.match(researchScript, /agent:\s*"researcher"/);
  assert.match(researchScript, /agent:\s*"worker"/);

  const reviewScript = buildWorkflowScript("Review PR changes", "review");
  assert.match(reviewScript, /agent:\s*"reviewer"/);
  assert.match(reviewScript, /agent:\s*"evidence-auditor"/);
});

test("AgentOrchestrator dispatches workflowScript through pi-subagents RPC", async () => {
  const listeners: Record<string, Function[]> = {};
  let emittedRequest: any = null;

  const mockPi: any = {
    events: {
      on: (event: string, fn: Function) => {
        listeners[event] = listeners[event] || [];
        listeners[event].push(fn);
        return () => {};
      },
      emit: (event: string, payload: any) => {
        if (event === "subagents:rpc:v1:request") {
          emittedRequest = payload;
          const replyEvent = `subagents:rpc:v1:reply:${payload.requestId}`;
          setTimeout(() => {
            const replyFn = listeners[replyEvent]?.[0];
            replyFn?.({ success: true, data: { runId: "run-abc-123" } });
          }, 5);
        }
      },
    },
  };

  const orchestrator = new AgentOrchestrator(mockPi, undefined, true);
  const ctx: any = { ui: { notify: () => {} }, signal: undefined };

  const result = await orchestrator.dispatch("Fix typo in README", ctx);
  assert.equal(result.accepted, true);
  assert.equal(result.runId, "run-abc-123");
  assert.ok(emittedRequest);
  assert.equal(emittedRequest.params.async, true);
  assert.match(emittedRequest.params.workflowScript, /runs\.run/);
  assert.match(emittedRequest.params.workflowScript, /scout/);
  assert.match(emittedRequest.params.workflowScript, /worker/);
  assert.match(emittedRequest.params.workflowScript, /reviewer/);
});

test("buildWorkflowPlan emits a backend-neutral JSON plan with dependencies", () => {
  const plan = buildWorkflowPlan("Fix race condition in store", "implementation");
  assert.equal(plan.task, "Fix race condition in store");
  assert.equal(plan.topology, "implementation");
  assert.deepEqual(
    plan.nodes.map((n) => n.id),
    ["scout", "worker", "reviewer"]
  );
  assert.deepEqual(plan.nodes.map((n) => n.needs), [[], ["scout"], ["worker"]]);

  // The plan must survive a JSON round trip: it is the cross-extension contract.
  assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan);

  const research = buildWorkflowPlan("Research vector DBs", "research");
  const synth = research.nodes.find((n) => n.id === "synthesizer");
  assert.ok(synth, "research plan has a synthesizer node");
  assert.equal(synth.agent, "worker");
  assert.deepEqual(synth.needs, ["scout", "researcher"]);
});

test("compilePiSubagentsScript batches ready nodes and passes task text verbatim", () => {
  // Parallel: scout + researcher are both ready at batch start.
  const script = compilePiSubagentsScript(buildWorkflowPlan("Research vector DBs", "research"));
  assert.match(script, /const \[scout, researcher\] = runs\.all\(\[/);
  assert.match(script, /const synthesizer = await runs\.run\("synthesizer"/);

  // Sequential implementation chain.
  const impl = compilePiSubagentsScript(buildWorkflowPlan("Fix the bug", "implementation"));
  assert.match(impl, /const scout = await runs\.run\("scout"/);
  assert.ok(!impl.includes("runs.all("), "implementation chain must stay ordered");

  // Task text with brace-like content is data, never a placeholder.
  const trickyTask = "Render {{input}} from " + "$" + "{worker}";
  const tricky = compilePiSubagentsScript(buildWorkflowPlan(trickyTask, "general"));
  assert.ok(tricky.includes(trickyTask), "tricky task text must pass through verbatim");
});

test("compilePiSubagentsScript rejects unsatisfiable or forward references", () => {
  const bad: WorkflowPlan = {
    task: "t",
    topology: "general",
    nodes: [
      { id: "a", agent: "worker", label: "A", needs: ["b"], segments: [{ task: true }] },
      { id: "b", agent: "worker", label: "B", needs: [], segments: [{ task: true }] },
    ],
  };
  assert.throws(() => compilePiSubagentsScript(bad), /unsatisfiable needs/);

  const forward: WorkflowPlan = {
    task: "t",
    topology: "general",
    nodes: [
      { id: "a", agent: "worker", label: "A", needs: [], segments: [{ input: "b" }] },
      { id: "b", agent: "worker", label: "B", needs: [], segments: [{ task: true }] },
    ],
  };
  assert.throws(() => compilePiSubagentsScript(forward), /before it runs/);
});

test("AgentOrchestrator dispatches through an injected backend", async () => {
  let received: WorkflowPlan | undefined;
  const backend: OrchestrationBackend = {
    spawn: async (plan) => {
      received = plan;
      return { runId: "run-custom-1" };
    },
  };
  const orchestrator = new AgentOrchestrator({} as ExtensionAPI, undefined, true, backend);
  const notifications: string[] = [];
  const ctx = stubCtx((m) => notifications.push(m));

  const result = await orchestrator.dispatch("Fix typo in README", ctx);
  assert.equal(result.accepted, true);
  assert.equal(result.runId, "run-custom-1");
  assert.equal(result.topology, "implementation");
  assert.ok(received, "backend received the plan");
  assert.equal(received.task, "Fix typo in README");
  assert.match(notifications[0], /\(implementation topology\) \[run-custom-1\]/);
});

test("AgentOrchestrator surfaces backend failures", async () => {
  const backend: OrchestrationBackend = {
    spawn: async () => {
      throw new Error("pi-subagents unavailable");
    },
  };
  const orchestrator = new AgentOrchestrator({} as ExtensionAPI, undefined, true, backend);
  const result = await orchestrator.dispatch("Say hello", stubCtx(() => {}));
  assert.equal(result.accepted, false);
  assert.equal(result.error, "pi-subagents unavailable");
});
