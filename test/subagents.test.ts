import assert from "node:assert/strict";
import test from "node:test";

import type { AgentState } from "../src/agent.js";
import { SubagentManager } from "../src/subagents.js";

test("SubagentManager spawns and completes queued runs", async () => {
  const calls: string[] = [];
  const fakeAgent = {
    async run(input: string, _state: AgentState, hooks?: any) {
      calls.push(input);
      hooks?.onToolCallStart?.({ name: "read_file", arguments: "{}", callId: "c1" });
      hooks?.onToolCallResult?.(
        { name: "read_file", arguments: "{}", callId: "c1" },
        { ok: true, result: { path: "x" } }
      );
      return { text: `done:${input}`, responseId: `r-${input}` };
    }
  };

  const baseState: AgentState = {
    model: "grok-code-fast-1",
    enableTools: true,
    previousResponseId: "p1",
    systemPromptOverride: "base"
  };

  const manager = new SubagentManager({
    agent: fakeAgent as any,
    getBaseState: () => ({ ...baseState }),
    maxConcurrent: 1
  });

  const first = manager.spawn({ task: "task-1", label: "one" });
  const second = manager.spawn({ task: "task-2", label: "two" });

  assert.ok(first.status === "queued" || first.status === "running");
  assert.ok(second.status === "queued" || second.status === "running");

  await manager.waitForIdle();

  const firstFinal = manager.getRun(first.id);
  const secondFinal = manager.getRun(second.id);
  assert.ok(firstFinal);
  assert.ok(secondFinal);
  assert.equal(firstFinal?.status, "completed");
  assert.equal(secondFinal?.status, "completed");
  assert.match(firstFinal?.output ?? "", /done:task-1/);
  assert.match(secondFinal?.output ?? "", /done:task-2/);
  assert.equal(calls.length, 2);
});

test("SubagentManager clearFinished removes completed runs", async () => {
  const fakeAgent = {
    async run(input: string) {
      return { text: input, responseId: "r" };
    }
  };

  const manager = new SubagentManager({
    agent: fakeAgent as any,
    getBaseState: () => ({ model: "m", enableTools: true }),
    maxConcurrent: 1
  });

  const run = manager.spawn({ task: "x" });
  await manager.waitForIdle();
  assert.equal(manager.getRun(run.id)?.status, "completed");

  const removed = manager.clearFinished();
  assert.equal(removed, 1);
  assert.equal(manager.getRun(run.id), undefined);
});
