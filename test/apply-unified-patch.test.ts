import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { executeToolCall, type ToolContext } from "../src/tools.js";

function createCtx(workspaceCwd: string): ToolContext {
  return {
    workspaceCwd,
    allowOutsideWorkspace: false,
    maxFileBytes: 2_000_000,
    defaultCommandTimeoutMs: 30_000,
    maxCommandOutputChars: 50_000
  };
}

async function withWorkspace(fn: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "grokcode-test-"));
  try {
    await fn(workspace);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

test("apply_unified_patch modifies an existing file", async () => {
  await withWorkspace(async (workspace) => {
    const file = path.join(workspace, "hello.txt");
    await fs.writeFile(file, "hello\nworld\n", "utf8");

    const patch = [
      "diff --git a/hello.txt b/hello.txt",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1,2 +1,2 @@",
      "-hello",
      "+hi",
      " world",
      ""
    ].join("\n");

    const result = await executeToolCall(
      { name: "apply_unified_patch", arguments: JSON.stringify({ patch }), callId: "1" },
      createCtx(workspace)
    );

    assert.equal(result.ok, true);
    const updated = await fs.readFile(file, "utf8");
    assert.equal(updated, "hi\nworld\n");
  });
});

test("apply_unified_patch creates a new file", async () => {
  await withWorkspace(async (workspace) => {
    const patch = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+line1",
      "+line2",
      ""
    ].join("\n");

    const result = await executeToolCall(
      { name: "apply_unified_patch", arguments: JSON.stringify({ patch }), callId: "2" },
      createCtx(workspace)
    );

    assert.equal(result.ok, true);
    const created = await fs.readFile(path.join(workspace, "new.txt"), "utf8");
    assert.equal(created, "line1\nline2\n");
  });
});

test("apply_unified_patch supports dry_run without writing", async () => {
  await withWorkspace(async (workspace) => {
    const file = path.join(workspace, "dry.txt");
    await fs.writeFile(file, "old\n", "utf8");

    const patch = [
      "diff --git a/dry.txt b/dry.txt",
      "--- a/dry.txt",
      "+++ b/dry.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      ""
    ].join("\n");

    const result = await executeToolCall(
      { name: "apply_unified_patch", arguments: JSON.stringify({ patch, dry_run: true }), callId: "3" },
      createCtx(workspace)
    );

    assert.equal(result.ok, true);
    const unchanged = await fs.readFile(file, "utf8");
    assert.equal(unchanged, "old\n");
  });
});

test("apply_unified_patch rejects paths outside workspace", async () => {
  await withWorkspace(async (workspace) => {
    const patch = [
      "diff --git a/../../escape.txt b/../../escape.txt",
      "--- a/../../escape.txt",
      "+++ b/../../escape.txt",
      "@@ -0,0 +1 @@",
      "+pwn",
      ""
    ].join("\n");

    const result = await executeToolCall(
      { name: "apply_unified_patch", arguments: JSON.stringify({ patch }), callId: "4" },
      createCtx(workspace)
    );

    assert.equal(result.ok, false);
    assert.match(String(result.error), /outside workspace/i);
  });
});

test("apply_unified_patch deletes a file", async () => {
  await withWorkspace(async (workspace) => {
    const file = path.join(workspace, "dead.txt");
    await fs.writeFile(file, "bye\n", "utf8");

    const patch = [
      "diff --git a/dead.txt b/dead.txt",
      "deleted file mode 100644",
      "--- a/dead.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      ""
    ].join("\n");

    const result = await executeToolCall(
      { name: "apply_unified_patch", arguments: JSON.stringify({ patch }), callId: "5" },
      createCtx(workspace)
    );

    if (!result.ok) {
      throw new Error(`delete patch failed: ${result.error}`);
    }
    assert.equal(result.ok, true);
    await assert.rejects(fs.stat(file));
  });
});

test("apply_unified_patch supports patches without a/b prefixes", async () => {
  await withWorkspace(async (workspace) => {
    const file = path.join(workspace, "plain.txt");
    await fs.writeFile(file, "alpha\n", "utf8");

    const patch = [
      "--- plain.txt",
      "+++ plain.txt",
      "@@ -1 +1 @@",
      "-alpha",
      "+beta",
      ""
    ].join("\n");

    const result = await executeToolCall(
      { name: "apply_unified_patch", arguments: JSON.stringify({ patch }), callId: "6" },
      createCtx(workspace)
    );

    if (!result.ok) {
      throw new Error(`plain patch failed: ${result.error}`);
    }
    assert.equal(result.ok, true);
    const updated = await fs.readFile(file, "utf8");
    assert.equal(updated, "beta\n");
  });
});
