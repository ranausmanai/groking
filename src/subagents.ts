import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentState, GrokAgent, PlannedSubtask } from "./agent.js";
import { applyUnifiedPatch, summarizeToolResult, type ToolCall, type ToolContext, type ToolExecutionResult } from "./tools.js";

export type SubagentStatus = "queued" | "running" | "completed" | "failed";
export type SubagentMergeStatus = "pending" | "applied" | "conflict" | "skipped";

export interface SubagentRunRecord {
  id: string;
  sequence: number;
  label: string;
  task: string;
  scope?: string[];
  dependsOn?: string[];
  blockedBy?: string[];
  status: SubagentStatus;
  mergeStatus?: SubagentMergeStatus;
  currentAction?: string;
  lastActivityAt?: number;
  model: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  output?: string;
  error?: string;
  responseId?: string;
  patch?: string;
  patchFiles?: string[];
  mergeError?: string;
  logs: string[];
}

export type SubagentEvent =
  | { type: "queued"; run: SubagentRunRecord }
  | { type: "started"; run: SubagentRunRecord }
  | { type: "completed"; run: SubagentRunRecord }
  | { type: "failed"; run: SubagentRunRecord }
  | { type: "merge_started"; run: SubagentRunRecord }
  | { type: "merged"; run: SubagentRunRecord }
  | { type: "merge_failed"; run: SubagentRunRecord }
  | { type: "tool_start"; run: SubagentRunRecord; call: ToolCall }
  | { type: "tool_result"; run: SubagentRunRecord; call: ToolCall; result: ToolExecutionResult };

export interface SpawnSubagentParams {
  task: string;
  label?: string;
  model?: string;
  scope?: string[];
  dependsOn?: string[];
  deferPump?: boolean;
}

export interface SubagentManagerOptions {
  agent: GrokAgent;
  getBaseState: () => AgentState;
  toolContext: ToolContext;
  maxConcurrent?: number;
  onEvent?: (event: SubagentEvent) => void;
}

export interface SubagentProgressEntry {
  id: string;
  label: string;
  phase: "queued" | "running" | "pending-merge";
  action: string;
  elapsedMs: number;
}

export interface SubagentStatusOverview {
  queued: number;
  running: number;
  completed: number;
  failed: number;
  mergePending: number;
  mergeApplied: number;
  mergeConflict: number;
  mergeSkipped: number;
}

function summarizeText(text: string | undefined, maxChars = 160): string | undefined {
  if (!text) {
    return undefined;
  }

  const line = text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean);

  if (!line) {
    return undefined;
  }

  return line.length <= maxChars ? line : `${line.slice(0, maxChars - 1)}…`;
}

export function describeSubagentRun(run: SubagentRunRecord): string {
  const parts: string[] = [];

  if (run.scope?.length) {
    parts.push(`scope: ${run.scope.join(", ")}`);
  }

  const fileHint = run.patchFiles?.length
    ? run.patchFiles.slice(0, 3).join(", ") + (run.patchFiles.length > 3 ? ` +${run.patchFiles.length - 3} more` : "")
    : undefined;

  if (fileHint) {
    parts.push(`files: ${fileHint}`);
  }

  if (run.mergeStatus) {
    parts.push(`merge: ${run.mergeStatus}`);
  }

  if (run.status === "failed" && run.error) {
    parts.push(`error: ${run.error}`);
  }

  if (run.status === "failed" && run.blockedBy?.length) {
    parts.push(`blocked by: ${run.blockedBy.join(", ")}`);
  }

  if (run.mergeStatus === "conflict" && run.mergeError) {
    parts.push(`merge error: ${run.mergeError}`);
  }

  const summary = summarizeText(run.output);
  if (summary) {
    parts.push(summary);
  }

  return parts.join(" | ");
}

function summarizeToolCall(call: ToolCall): string {
  try {
    const parsed = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
    const interesting = ["path", "cwd", "command", "pattern"] as const;
    for (const key of interesting) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) {
        return `${call.name} ${value.trim()}`;
      }
    }
  } catch {
    // fall through
  }

  return call.name;
}

function normalizeScopePath(input: string): string | undefined {
  const value = input.trim();
  if (!value) {
    return undefined;
  }

  let normalized = path.normalize(value);
  if (normalized.length > 1) {
    normalized = normalized.replace(/[\\/]+$/, "");
  }
  if (!normalized || normalized === ".") {
    return undefined;
  }

  return normalized;
}

function scopesOverlap(left: string[] | undefined, right: string[] | undefined): boolean {
  if (!left?.length || !right?.length) {
    return false;
  }

  for (const a of left) {
    for (const b of right) {
      if (a === b) {
        return true;
      }
      if (a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`)) {
        return true;
      }
    }
  }

  return false;
}

function isPathCoveredByScopes(filePath: string, scopes: string[] | undefined): boolean {
  if (!scopes || scopes.length === 0) {
    return true;
  }

  const normalizedFile = normalizeScopePath(filePath);
  if (!normalizedFile) {
    return false;
  }

  for (const scope of scopes) {
    const normalizedScope = normalizeScopePath(scope);
    if (!normalizedScope) {
      continue;
    }

    if (normalizedFile === normalizedScope) {
      return true;
    }

    if (normalizedFile.startsWith(`${normalizedScope}${path.sep}`)) {
      return true;
    }
  }

  return false;
}

interface ProcessResult {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

interface WorkerSnapshot {
  bundleDir: string;
  baseDir: string;
  workerDir: string;
}

const SNAPSHOT_EXCLUDES = new Set([
  ".git",
  ".groking",
  "node_modules",
  "dist",
  ".DS_Store"
]);

const PATCH_EXCLUDED_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  ".next",
  ".nuxt",
  "coverage",
  ".cache",
  ".turbo",
  ".vite"
]);

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

function shouldCopySnapshotPath(workspace: string, candidate: string): boolean {
  const relative = path.relative(workspace, candidate);
  if (!relative) {
    return true;
  }

  const parts = relative.split(path.sep).filter(Boolean);
  return !parts.some((part) => SNAPSHOT_EXCLUDES.has(part));
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function cloneWorkspaceSnapshot(sourceWorkspace: string, targetWorkspace: string): Promise<void> {
  await fs.mkdir(targetWorkspace, { recursive: true });
  await fs.cp(sourceWorkspace, targetWorkspace, {
    recursive: true,
    preserveTimestamps: true,
    filter: (src) => shouldCopySnapshotPath(sourceWorkspace, src)
  });

  const nodeModulesSource = path.join(sourceWorkspace, "node_modules");
  if (!(await pathExists(nodeModulesSource))) {
    return;
  }

  const nodeModulesTarget = path.join(targetWorkspace, "node_modules");
  if (await pathExists(nodeModulesTarget)) {
    return;
  }

  await fs.symlink(nodeModulesSource, nodeModulesTarget, process.platform === "win32" ? "junction" : "dir");
}

async function prepareWorkerSnapshot(sourceWorkspace: string): Promise<WorkerSnapshot> {
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "groking-worker-"));
  const baseDir = path.join(bundleDir, "base");
  const workerDir = path.join(bundleDir, "worker");

  await cloneWorkspaceSnapshot(sourceWorkspace, baseDir);
  await cloneWorkspaceSnapshot(sourceWorkspace, workerDir);

  return { bundleDir, baseDir, workerDir };
}

async function prunePatchIgnoredPaths(rootDir: string): Promise<void> {
  const queue: string[] = [rootDir];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const entries = await fs.readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (!entry.isDirectory()) {
        continue;
      }

      if (PATCH_EXCLUDED_DIR_NAMES.has(entry.name)) {
        await fs.rm(absolute, { recursive: true, force: true });
        continue;
      }

      queue.push(absolute);
    }
  }
}

async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  maxOutputChars: number
): Promise<ProcessResult> {
  const start = Date.now();

  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        timedOut,
        durationMs: Date.now() - start,
        stdout: truncate(stdout, maxOutputChars),
        stderr: truncate(stderr, maxOutputChars)
      });
    });
  });
}

function sanitizePatchLine(line: string): string {
  if (line.startsWith("diff --git ")) {
    return line
      .replace(/\sa\/(?:base|worker)\//, " a/")
      .replace(/\sb\/(?:base|worker)\//, " b/");
  }

  if (line.startsWith("--- a/")) {
    return line.replace(/^--- a\/(?:base|worker)\//, "--- a/");
  }

  if (line.startsWith("+++ b/")) {
    return line.replace(/^\+\+\+ b\/(?:base|worker)\//, "+++ b/");
  }

  if (line.startsWith("Binary files ")) {
    return line
      .replace(/^Binary files a\/(?:base|worker)\//, "Binary files a/")
      .replace(/\sb\/(?:base|worker)\//, " b/");
  }

  return line;
}

function sanitizeWorkerPatch(rawPatch: string): string {
  if (!rawPatch.trim()) {
    return "";
  }

  return (
    rawPatch
    .split(/\r?\n/)
    .map((line) => sanitizePatchLine(line))
    .join("\n")
    .replace(/\n+$/, "\n")
  );
}

function normalizePatchPath(rawPath: string): string | undefined {
  const withoutTimestamp = rawPath.split("\t")[0].trim();
  if (!withoutTimestamp || withoutTimestamp === "/dev/null") {
    return undefined;
  }

  let normalized = withoutTimestamp;
  if (normalized.startsWith("a/") || normalized.startsWith("b/")) {
    normalized = normalized.slice(2);
  }

  normalized = path.normalize(normalized);
  if (!normalized || normalized === "." || path.isAbsolute(normalized)) {
    return undefined;
  }

  return normalized;
}

function extractPatchFiles(patch: string): string[] {
  const files = new Set<string>();

  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const candidate = normalizePatchPath(line.slice(4));
      if (candidate) {
        files.add(candidate);
      }
      continue;
    }

    if (!line.startsWith("diff --git ")) {
      continue;
    }

    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) {
      continue;
    }

    const left = normalizePatchPath(parts[2]);
    const right = normalizePatchPath(parts[3]);
    if (left) {
      files.add(left);
    }
    if (right) {
      files.add(right);
    }
  }

  return [...files];
}

async function generateWorkerPatch(snapshot: WorkerSnapshot, toolContext: ToolContext): Promise<string> {
  await prunePatchIgnoredPaths(snapshot.baseDir);
  await prunePatchIgnoredPaths(snapshot.workerDir);
  const patchFile = path.join(snapshot.bundleDir, "worker.patch");
  const result = await runProcess(
    "git",
    ["diff", "--no-index", "--binary", "--no-ext-diff", "--output", patchFile, "--", "base", "worker"],
    snapshot.bundleDir,
    toolContext.defaultCommandTimeoutMs,
    toolContext.maxCommandOutputChars
  );

  if (result.timedOut) {
    throw new Error("worker diff timed out");
  }

  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error([result.stdout, result.stderr].filter(Boolean).join("\n").trim() || "git diff failed");
  }

  const rawPatch = await fs.readFile(patchFile, "utf8").catch(() => "");
  const sanitized = sanitizeWorkerPatch(rawPatch);
  const patchBytes = Buffer.byteLength(sanitized, "utf8");
  if (patchBytes > 900_000) {
    throw new Error(
      `worker patch too large (${patchBytes} bytes). likely generated artifacts/dependencies; narrow scope or avoid install/build output`
    );
  }

  return sanitized;
}

export class SubagentManager {
  private readonly agent: GrokAgent;
  private readonly getBaseState: () => AgentState;
  private readonly toolContext: ToolContext;
  private readonly maxConcurrent: number;
  private readonly onEvent?: (event: SubagentEvent) => void;

  private readonly runs = new Map<string, SubagentRunRecord>();
  private readonly queue: string[] = [];
  private activeCount = 0;
  private mergeInProgress = false;
  private nextSequence = 1;

  constructor(options: SubagentManagerOptions) {
    this.agent = options.agent;
    this.getBaseState = options.getBaseState;
    this.toolContext = options.toolContext;
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 4);
    this.onEvent = options.onEvent;
  }

  listRuns(): SubagentRunRecord[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  getRun(id: string): SubagentRunRecord | undefined {
    return this.runs.get(id);
  }

  getProgressEntries(now = Date.now()): SubagentProgressEntry[] {
    const entries: SubagentProgressEntry[] = [];

    for (const run of [...this.runs.values()].sort((a, b) => a.sequence - b.sequence)) {
      if (run.status === "queued") {
        entries.push({
          id: run.id,
          label: run.label,
          phase: "queued",
          action: run.currentAction ?? "waiting to start",
          elapsedMs: Math.max(0, now - run.createdAt)
        });
        continue;
      }

      if (run.status === "running") {
        entries.push({
          id: run.id,
          label: run.label,
          phase: "running",
          action: run.currentAction ?? "working",
          elapsedMs: Math.max(0, now - (run.startedAt ?? run.createdAt))
        });
        continue;
      }

      if (run.status === "completed" && run.mergeStatus === "pending") {
        entries.push({
          id: run.id,
          label: run.label,
          phase: "pending-merge",
          action: run.currentAction ?? "waiting to merge",
          elapsedMs: Math.max(0, now - (run.startedAt ?? run.createdAt))
        });
      }
    }

    return entries;
  }

  getStatusOverview(): SubagentStatusOverview {
    const summary: SubagentStatusOverview = {
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      mergePending: 0,
      mergeApplied: 0,
      mergeConflict: 0,
      mergeSkipped: 0
    };

    for (const run of this.runs.values()) {
      if (run.status === "queued") {
        summary.queued += 1;
      } else if (run.status === "running") {
        summary.running += 1;
      } else if (run.status === "completed") {
        summary.completed += 1;
      } else if (run.status === "failed") {
        summary.failed += 1;
      }

      if (run.mergeStatus === "pending") {
        summary.mergePending += 1;
      } else if (run.mergeStatus === "applied") {
        summary.mergeApplied += 1;
      } else if (run.mergeStatus === "conflict") {
        summary.mergeConflict += 1;
      } else if (run.mergeStatus === "skipped") {
        summary.mergeSkipped += 1;
      }
    }

    return summary;
  }

  clearFinished(): number {
    let removed = 0;
    for (const [id, run] of this.runs.entries()) {
      if (run.status === "completed" || run.status === "failed") {
        this.runs.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  async waitForIdle(): Promise<void> {
    while (this.activeCount > 0 || this.queue.length > 0 || this.mergeInProgress) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  spawn(params: SpawnSubagentParams): SubagentRunRecord {
    const base = this.getBaseState();
    const scope = (params.scope ?? [])
      .map((item) => normalizeScopePath(item))
      .filter((item): item is string => Boolean(item))
      .slice(0, 12);
    const dependsOn = (params.dependsOn ?? [])
      .map((item) => item.trim())
      .filter(Boolean);
    const run: SubagentRunRecord = {
      id: crypto.randomUUID().slice(0, 8),
      sequence: this.nextSequence++,
      label: params.label?.trim() || "worker",
      task: params.task.trim(),
      scope: scope.length > 0 ? scope : undefined,
      dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
      status: "queued",
      currentAction: "waiting to start",
      lastActivityAt: Date.now(),
      model: params.model?.trim() || base.model,
      createdAt: Date.now(),
      logs: []
    };

    this.runs.set(run.id, run);
    this.queue.push(run.id);
    this.emit({ type: "queued", run });
    if (!params.deferPump) {
      this.pump();
    }

    return run;
  }

  spawnPlanned(tasks: PlannedSubtask[], model?: string): SubagentRunRecord[] {
    const labelToId = new Map<string, string>();
    const created = tasks.map((task, index) => {
      const safeLabel = task.label?.trim() || `worker-${index + 1}`;
      const run = this.spawn({
        task: task.task,
        label: safeLabel,
        model,
        scope: task.scope,
        deferPump: true
      });
      labelToId.set(safeLabel, run.id);
      return run;
    });

    for (let index = 0; index < created.length; index += 1) {
      const run = created[index]!;
      const task = tasks[index]!;
      const deps = (task.depends_on ?? [])
        .map((label) => labelToId.get(label.trim()))
        .filter((id): id is string => Boolean(id) && id !== run.id);
      run.dependsOn = deps.length > 0 ? deps : undefined;
    }

    this.pump();
    return created;
  }

  private emit(event: SubagentEvent): void {
    this.onEvent?.(event);
  }

  private pruneQueue(): void {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const runId = this.queue[index]!;
      const run = this.runs.get(runId);
      if (!run || run.status !== "queued") {
        this.queue.splice(index, 1);
      }
    }
  }

  private pump(): void {
    this.pruneQueue();
    this.resolveBlockedQueuedRuns();
    this.pruneQueue();

    while (this.activeCount < this.maxConcurrent) {
      const run = this.takeNextRunnableRun();
      if (!run) {
        break;
      }
      this.activeCount += 1;
      void this.executeRun(run).finally(() => {
        this.activeCount -= 1;
        this.pump();
      });
    }
  }

  private resolveBlockedQueuedRuns(): void {
    for (const runId of this.queue) {
      const run = this.runs.get(runId);
      if (!run || run.status !== "queued" || !run.dependsOn?.length) {
        continue;
      }

      const blockingDeps = run.dependsOn
        .map((id) => this.runs.get(id))
        .filter((dep): dep is SubagentRunRecord => Boolean(dep))
        .filter((dep) => dep.status === "failed" || dep.mergeStatus === "conflict")
        .map((dep) => `${dep.id}:${dep.label}`);

      if (blockingDeps.length === 0) {
        continue;
      }

      run.status = "failed";
      run.error = "Blocked by failed dependency";
      run.blockedBy = blockingDeps;
      run.endedAt = Date.now();
      run.lastActivityAt = Date.now();
      run.currentAction = "blocked by failed dependency";
      this.emit({ type: "failed", run });
    }
  }

  private takeNextRunnableRun(): SubagentRunRecord | undefined {
    const busyRuns = [...this.runs.values()].filter(
      (run) => run.status === "running" || (run.status === "completed" && run.mergeStatus === "pending")
    );

    for (let index = 0; index < this.queue.length; index += 1) {
      const runId = this.queue[index]!;
      const run = this.runs.get(runId);
      if (!run || run.status !== "queued") {
        continue;
      }

      const depsPending = run.dependsOn?.some((depId) => {
        const dep = this.runs.get(depId);
        if (!dep) {
          return true;
        }
        return dep.status !== "completed" || dep.mergeStatus === "pending";
      }) ?? false;
      if (depsPending) {
        run.currentAction = "waiting for dependencies";
        continue;
      }

      const hasScopeContention = busyRuns.some((busyRun) => scopesOverlap(run.scope, busyRun.scope));
      if (hasScopeContention) {
        run.currentAction = "waiting for scope lock";
        continue;
      }

      this.queue.splice(index, 1);
      return run;
    }

    return undefined;
  }

  private async executeRun(run: SubagentRunRecord): Promise<void> {
    run.status = "running";
    run.startedAt = Date.now();
    run.lastActivityAt = Date.now();
    run.currentAction = "preparing isolated workspace";
    this.emit({ type: "started", run });

    const base = this.getBaseState();
    let snapshot: WorkerSnapshot | undefined;

    try {
      snapshot = await prepareWorkerSnapshot(this.toolContext.workspaceCwd);
      const workerToolContext: ToolContext = {
        ...this.toolContext,
        workspaceCwd: snapshot.workerDir
      };

      const workerAgent = this.agent.forkWithToolContext(workerToolContext);
      const workerState: AgentState = {
        model: run.model,
        previousResponseId: undefined,
        enableTools: base.enableTools,
        systemPromptOverride: [
          base.systemPromptOverride?.trim(),
          "You are a spawned worker subagent.",
          `Worker label: ${run.label}`,
          "You are operating inside an isolated workspace snapshot.",
          "Do not install dependencies, run package managers, or create build artifacts unless explicitly required by the task.",
          run.scope?.length
            ? `Allowed write scope: ${run.scope.join(", ")}. Do not modify files outside this scope.`
            : undefined,
          "Make file changes only for the assigned task and keep the scope tight.",
          "Return a concise summary of what changed and what remains."
        ]
          .filter(Boolean)
          .join("\n")
      };

      const result = await workerAgent.run(
        run.task,
        workerState,
        {
          onToolCallStart: (call) => {
            run.logs.push(`tool> ${call.name} ${call.arguments}`);
            run.lastActivityAt = Date.now();
            run.currentAction = summarizeToolCall(call);
            this.emit({ type: "tool_start", run, call });
          },
          onToolCallResult: (call, toolResult) => {
            run.logs.push(`tool< ${call.name} ${summarizeToolResult(toolResult)}`);
            run.lastActivityAt = Date.now();
            run.currentAction = toolResult.ok ? `thinking after ${call.name}` : `recovering from ${call.name}`;
            this.emit({ type: "tool_result", run, call, result: toolResult });
          }
        },
        { maxToolRounds: 40 }
      );

      run.status = "completed";
      run.endedAt = Date.now();
      run.output = result.text;
      run.responseId = result.responseId;
      run.lastActivityAt = Date.now();

      const patch = await generateWorkerPatch(snapshot, this.toolContext);
      run.patch = patch || undefined;
      run.patchFiles = patch ? extractPatchFiles(patch) : [];
      run.mergeStatus = patch ? "pending" : "skipped";
      run.currentAction = patch ? "waiting to merge" : "completed";
      this.emit({ type: "completed", run });
    } catch (error) {
      run.status = "failed";
      run.endedAt = Date.now();
      run.error = error instanceof Error ? error.message : String(error);
      run.lastActivityAt = Date.now();
      run.currentAction = "failed";
      this.emit({ type: "failed", run });
    } finally {
      if (snapshot) {
        await fs.rm(snapshot.bundleDir, { recursive: true, force: true });
      }
      await this.maybeMergeReadyRuns();
    }
  }

  private async maybeMergeReadyRuns(): Promise<void> {
    if (this.mergeInProgress) {
      return;
    }

    this.mergeInProgress = true;

    try {
      while (true) {
        const next = this.findNextMergeCandidate();
        if (!next) {
          break;
        }

        await this.mergeRun(next);
      }
    } finally {
      this.mergeInProgress = false;
    }
  }

  private findNextMergeCandidate(): SubagentRunRecord | undefined {
    const runs = [...this.runs.values()].sort((a, b) => a.sequence - b.sequence);

    for (const run of runs) {
      if (run.status !== "completed" || run.mergeStatus !== "pending" || !run.patch) {
        continue;
      }

      const blocked = runs.some(
        (candidate) =>
          candidate.sequence < run.sequence && (candidate.status === "queued" || candidate.status === "running")
      );

      if (!blocked) {
        return run;
      }

      break;
    }

    return undefined;
  }

  private async mergeRun(run: SubagentRunRecord): Promise<void> {
    run.lastActivityAt = Date.now();
    run.currentAction = "applying patch";
    this.emit({ type: "merge_started", run });

    try {
      const outOfScope = (run.patchFiles ?? []).filter((file) => !isPathCoveredByScopes(file, run.scope));
      if (outOfScope.length > 0) {
        throw new Error(
          `scope violation: worker touched files outside scope (${outOfScope.join(", ")}); declared scope: ${
            run.scope?.join(", ") ?? "(none)"
          }`
        );
      }

      await applyUnifiedPatch(run.patch ?? "", this.toolContext, false);
      run.mergeStatus = "applied";
      run.lastActivityAt = Date.now();
      run.currentAction = "merged";
      this.emit({ type: "merged", run });
    } catch (error) {
      run.mergeStatus = "conflict";
      run.mergeError = error instanceof Error ? error.message : String(error);
      run.lastActivityAt = Date.now();
      run.currentAction = "merge conflict";
      this.emit({ type: "merge_failed", run });
    }
  }
}
