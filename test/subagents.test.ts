import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentState } from "../src/agent.js";
import { SubagentManager } from "../src/subagents.js";
import type { ToolContext } from "../src/tools.js";

function createToolContext(workspaceCwd: string): ToolContext {
  return {
    workspaceCwd,
    allowOutsideWorkspace: false,
    maxFileBytes: 1_000_000,
    defaultCommandTimeoutMs: 10_000,
    maxCommandOutputChars: 20_000
  };
}

async function makeWorkspace(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "groking-subagents-test-"));
}

test("SubagentManager runs isolated workers in parallel and merges patches", async () => {
  const workspace = await makeWorkspace();
  await fs.writeFile(path.join(workspace, "base.txt"), "base\n", "utf8");

  let active = 0;
  let maxActive = 0;

  const fakeAgent = {
    forkWithToolContext(toolContext: ToolContext) {
      return {
        async run(input: string, _state: AgentState) {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 120));
          await fs.writeFile(path.join(toolContext.workspaceCwd, `${input}.txt`), `worker:${input}\n`, "utf8");
          active -= 1;
          return { text: `done:${input}`, responseId: `r-${input}` };
        }
      };
    }
  };

  const manager = new SubagentManager({
    agent: fakeAgent as any,
    getBaseState: () => ({ model: "grok-code-fast-1", enableTools: true }),
    toolContext: createToolContext(workspace),
    maxConcurrent: 2
  });

  const first = manager.spawn({ task: "task-one", label: "one" });
  const second = manager.spawn({ task: "task-two", label: "two" });

  await manager.waitForIdle();

  assert.equal(maxActive, 2);
  assert.equal(await fs.readFile(path.join(workspace, "task-one.txt"), "utf8"), "worker:task-one\n");
  assert.equal(await fs.readFile(path.join(workspace, "task-two.txt"), "utf8"), "worker:task-two\n");
  assert.equal(manager.getRun(first.id)?.status, "completed");
  assert.equal(manager.getRun(second.id)?.status, "completed");
  assert.equal(manager.getRun(first.id)?.mergeStatus, "applied");
  assert.equal(manager.getRun(second.id)?.mergeStatus, "applied");
});

test("SubagentManager merges completed worker patches in spawn order and reports conflicts", async () => {
  const workspace = await makeWorkspace();
  await fs.writeFile(path.join(workspace, "shared.txt"), "base\n", "utf8");

  const fakeAgent = {
    forkWithToolContext(toolContext: ToolContext) {
      return {
        async run(input: string, _state: AgentState) {
          const delayMs = input === "first-change" ? 120 : 10;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          const content = input === "first-change" ? "first\n" : "second\n";
          await fs.writeFile(path.join(toolContext.workspaceCwd, "shared.txt"), content, "utf8");
          return { text: input, responseId: `r-${input}` };
        }
      };
    }
  };

  const manager = new SubagentManager({
    agent: fakeAgent as any,
    getBaseState: () => ({ model: "grok-code-fast-1", enableTools: true }),
    toolContext: createToolContext(workspace),
    maxConcurrent: 2
  });

  const first = manager.spawn({ task: "first-change", label: "first" });
  const second = manager.spawn({ task: "second-change", label: "second" });

  await manager.waitForIdle();

  assert.equal(await fs.readFile(path.join(workspace, "shared.txt"), "utf8"), "first\n");
  assert.equal(manager.getRun(first.id)?.mergeStatus, "applied");
  assert.equal(manager.getRun(second.id)?.mergeStatus, "conflict");
  assert.match(manager.getRun(second.id)?.mergeError ?? "", /patch validation failed|git apply failed/i);
});

test("SubagentManager clearFinished removes completed and failed runs", async () => {
  const workspace = await makeWorkspace();

  const fakeAgent = {
    forkWithToolContext() {
      return {
        async run(input: string) {
          if (input === "fail-me") {
            throw new Error("boom");
          }
          return { text: input, responseId: `r-${input}` };
        }
      };
    }
  };

  const manager = new SubagentManager({
    agent: fakeAgent as any,
    getBaseState: () => ({ model: "grok-code-fast-1", enableTools: true }),
    toolContext: createToolContext(workspace),
    maxConcurrent: 2
  });

  const successRun = manager.spawn({ task: "ok" });
  const failedRun = manager.spawn({ task: "fail-me" });

  await manager.waitForIdle();
  assert.equal(manager.getRun(successRun.id)?.status, "completed");
  assert.equal(manager.getRun(failedRun.id)?.status, "failed");

  const removed = manager.clearFinished();
  assert.equal(removed, 2);
  assert.equal(manager.getRun(successRun.id), undefined);
  assert.equal(manager.getRun(failedRun.id), undefined);
});

test("SubagentManager enforces planned dependencies and scope locks", async () => {
  const workspace = await makeWorkspace();
  await fs.mkdir(path.join(workspace, "threejs"), { recursive: true });
  await fs.writeFile(path.join(workspace, "threejs", "index.html"), "<html></html>\n", "utf8");

  let activeImpl = 0;
  let maxImplActive = 0;

  const fakeAgent = {
    forkWithToolContext(toolContext: ToolContext) {
      return {
        async run(input: string) {
          const isImpl = input.includes("impl");
          if (isImpl) {
            activeImpl += 1;
            maxImplActive = Math.max(maxImplActive, activeImpl);
          }

          await new Promise((resolve) => setTimeout(resolve, input.includes("setup") ? 40 : 120));
          if (input === "setup") {
            await fs.writeFile(path.join(toolContext.workspaceCwd, "threejs", "boot.txt"), "setup\n", "utf8");
          } else if (input === "impl-1") {
            await fs.writeFile(path.join(toolContext.workspaceCwd, "threejs", "index.html"), "<html>impl1</html>\n", "utf8");
          } else if (input === "impl-2") {
            await fs.writeFile(path.join(toolContext.workspaceCwd, "threejs", "index.html"), "<html>impl2</html>\n", "utf8");
          } else if (input === "verify") {
            await fs.writeFile(path.join(toolContext.workspaceCwd, "threejs", "verify.txt"), "verify\n", "utf8");
          }

          if (isImpl) {
            activeImpl -= 1;
          }
          return { text: input, responseId: `r-${input}` };
        }
      };
    }
  };

  const manager = new SubagentManager({
    agent: fakeAgent as any,
    getBaseState: () => ({ model: "grok-code-fast-1", enableTools: true }),
    toolContext: createToolContext(workspace),
    maxConcurrent: 3
  });

  const runs = manager.spawnPlanned([
    { label: "setup", task: "setup", scope: ["threejs/"] },
    { label: "impl-1", task: "impl-1", scope: ["threejs/index.html"], depends_on: ["setup"] },
    { label: "impl-2", task: "impl-2", scope: ["threejs/index.html"], depends_on: ["setup"] },
    { label: "verify", task: "verify", scope: ["threejs/"], depends_on: ["impl-1", "impl-2"] }
  ]);

  await manager.waitForIdle();

  const byLabel = new Map(runs.map((run) => [run.label, manager.getRun(run.id)] as const));
  assert.equal(byLabel.get("setup")?.status, "completed");
  assert.equal(byLabel.get("impl-1")?.status, "completed");
  assert.equal(byLabel.get("impl-2")?.status, "completed");
  assert.equal(byLabel.get("verify")?.status, "completed");
  assert.equal(maxImplActive, 1);
  assert.equal(byLabel.get("verify")?.mergeStatus, "applied");
});

test("SubagentManager marks dependent task failed when dependency fails", async () => {
  const workspace = await makeWorkspace();
  const executed: string[] = [];

  const fakeAgent = {
    forkWithToolContext() {
      return {
        async run(input: string) {
          executed.push(input);
          if (input === "base-task") {
            throw new Error("base failed");
          }
          return { text: input, responseId: `r-${input}` };
        }
      };
    }
  };

  const manager = new SubagentManager({
    agent: fakeAgent as any,
    getBaseState: () => ({ model: "grok-code-fast-1", enableTools: true }),
    toolContext: createToolContext(workspace),
    maxConcurrent: 2
  });

  const runs = manager.spawnPlanned([
    { label: "base", task: "base-task" },
    { label: "dependent", task: "dependent-task", depends_on: ["base"] }
  ]);
  await manager.waitForIdle();

  const baseRun = manager.getRun(runs[0]!.id);
  const dependentRun = manager.getRun(runs[1]!.id);
  assert.equal(baseRun?.status, "failed");
  assert.equal(dependentRun?.status, "failed");
  assert.equal(executed.includes("dependent-task"), false);
  assert.match(dependentRun?.error ?? "", /blocked by failed dependency/i);
  assert.ok((dependentRun?.blockedBy?.length ?? 0) > 0);
});

test("SubagentManager ignores node_modules changes in worker patch generation", async () => {
  const workspace = await makeWorkspace();
  await fs.mkdir(path.join(workspace, "threejs"), { recursive: true });
  await fs.writeFile(path.join(workspace, "threejs", "index.html"), "<html></html>\n", "utf8");

  const fakeAgent = {
    forkWithToolContext(toolContext: ToolContext) {
      return {
        async run() {
          await fs.mkdir(path.join(toolContext.workspaceCwd, "threejs", "node_modules", "pkg"), { recursive: true });
          await fs.writeFile(
            path.join(toolContext.workspaceCwd, "threejs", "node_modules", "pkg", "index.js"),
            "module.exports = 1;\n",
            "utf8"
          );
          return { text: "created dependency artifacts", responseId: "r-artifacts" };
        }
      };
    }
  };

  const manager = new SubagentManager({
    agent: fakeAgent as any,
    getBaseState: () => ({ model: "grok-code-fast-1", enableTools: true }),
    toolContext: createToolContext(workspace),
    maxConcurrent: 1
  });

  const run = manager.spawn({ task: "deps-only", label: "deps-only", scope: ["threejs/"] });
  await manager.waitForIdle();

  const finalRun = manager.getRun(run.id);
  assert.equal(finalRun?.status, "completed");
  assert.equal(finalRun?.mergeStatus, "skipped");
  await assert.rejects(
    () => fs.stat(path.join(workspace, "threejs", "node_modules", "pkg", "index.js")),
    /ENOENT/
  );
});

test("SubagentManager rejects out-of-scope worker changes during merge", async () => {
  const workspace = await makeWorkspace();
  await fs.writeFile(path.join(workspace, "index.html"), "<html></html>\n", "utf8");
  await fs.writeFile(path.join(workspace, "app.js"), "console.log('base');\n", "utf8");

  const fakeAgent = {
    forkWithToolContext(toolContext: ToolContext) {
      return {
        async run() {
          await fs.writeFile(path.join(toolContext.workspaceCwd, "app.js"), "console.log('ok');\n", "utf8");
          await fs.writeFile(path.join(toolContext.workspaceCwd, "index.html"), "<html>changed</html>\n", "utf8");
          return { text: "updated app and html", responseId: "r-scope" };
        }
      };
    }
  };

  const manager = new SubagentManager({
    agent: fakeAgent as any,
    getBaseState: () => ({ model: "grok-code-fast-1", enableTools: true }),
    toolContext: createToolContext(workspace),
    maxConcurrent: 1
  });

  const run = manager.spawn({ task: "scoped-task", label: "scoped", scope: ["app.js"] });
  await manager.waitForIdle();

  const finalRun = manager.getRun(run.id);
  assert.equal(finalRun?.status, "completed");
  assert.equal(finalRun?.mergeStatus, "conflict");
  assert.match(finalRun?.mergeError ?? "", /scope violation/i);
  assert.equal(await fs.readFile(path.join(workspace, "index.html"), "utf8"), "<html></html>\n");
});

test("SubagentManager fails write-intent file-scoped task when no patch is produced", async () => {
  const workspace = await makeWorkspace();
  await fs.writeFile(path.join(workspace, "index.html"), "<html></html>\n", "utf8");

  const fakeAgent = {
    forkWithToolContext() {
      return {
        async run() {
          return { text: "checked only", responseId: "r-nochange" };
        }
      };
    }
  };

  const manager = new SubagentManager({
    agent: fakeAgent as any,
    getBaseState: () => ({ model: "grok-code-fast-1", enableTools: true }),
    toolContext: createToolContext(workspace),
    maxConcurrent: 1
  });

  const run = manager.spawn({ task: "write updated html", label: "writer", scope: ["index.html"] });
  await manager.waitForIdle();

  const finalRun = manager.getRun(run.id);
  assert.equal(finalRun?.status, "failed");
  assert.match(finalRun?.error ?? "", /require file edits/i);
  assert.equal(await fs.readFile(path.join(workspace, "index.html"), "utf8"), "<html></html>\n");
});

test("SubagentManager fails verification task when run_command times out", async () => {
  const workspace = await makeWorkspace();
  await fs.writeFile(path.join(workspace, "index.html"), "<html></html>\n", "utf8");

  const fakeAgent = {
    forkWithToolContext() {
      return {
        async run(_input: string, _state: AgentState, hooks?: any) {
          hooks?.onToolCallResult?.(
            { name: "run_command", arguments: "{\"command\":\"python app.py\"}", callId: "call-1" },
            {
              ok: true,
              result: {
                command: "python app.py",
                cwd: ".",
                exit_code: null,
                timed_out: true,
                duration_ms: 30000,
                stdout: "",
                stderr: ""
              }
            }
          );
          return { text: "verification complete", responseId: "r-timeout" };
        }
      };
    }
  };

  const manager = new SubagentManager({
    agent: fakeAgent as any,
    getBaseState: () => ({ model: "grok-code-fast-1", enableTools: true }),
    toolContext: createToolContext(workspace),
    maxConcurrent: 1
  });

  const run = manager.spawn({ task: "verify the output", label: "verify-step", scope: ["index.html"] });
  await manager.waitForIdle();

  const finalRun = manager.getRun(run.id);
  assert.equal(finalRun?.status, "failed");
  assert.match(finalRun?.error ?? "", /verification command timed out/i);
});
