import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FunctionTool } from "openai/resources/responses/responses";

export interface ToolContext {
  workspaceCwd: string;
  allowOutsideWorkspace: boolean;
  maxFileBytes: number;
  defaultCommandTimeoutMs: number;
  maxCommandOutputChars: number;
}

export interface ToolExecutionResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface ToolCall {
  name: string;
  arguments: string;
  callId: string;
}

interface RunCommandResult {
  command: string;
  cwd: string;
  exit_code: number | null;
  timed_out: boolean;
  duration_ms: number;
  stdout: string;
  stderr: string;
}

interface ProcessResult {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

type JsonSchema = Record<string, unknown>;

function functionTool(name: string, description: string, parameters: JsonSchema): FunctionTool {
  return {
    type: "function",
    name,
    description,
    parameters,
    strict: false
  };
}

export const TOOL_SCHEMAS: FunctionTool[] = [
  functionTool(
    "get_workspace_info",
    "Return basic workspace information such as absolute cwd.",
    {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  ),
  functionTool(
    "list_files",
    "List files/directories inside a path. Use recursive mode to inspect trees.",
    {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative or absolute path. Defaults to current workspace." },
        recursive: { type: "boolean", description: "List recursively. Defaults to false." },
        hidden: { type: "boolean", description: "Include dotfiles. Defaults to false." },
        max_entries: { type: "number", description: "Hard cap on returned entries. Defaults to 200." }
      },
      additionalProperties: false
    }
  ),
  functionTool(
    "search_files",
    "Search text across files using ripgrep.",
    {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex/text pattern to search for." },
        path: { type: "string", description: "Directory or file path. Defaults to workspace root." },
        glob: { type: "string", description: "Optional glob filter like '*.ts'." },
        max_results: { type: "number", description: "Maximum number of matching lines. Defaults to 100." }
      },
      required: ["pattern"],
      additionalProperties: false
    }
  ),
  functionTool(
    "read_file",
    "Read file content, optionally a line range.",
    {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to file." },
        start_line: { type: "number", description: "1-based line index. Defaults to 1." },
        end_line: { type: "number", description: "Inclusive 1-based end line. Defaults to 500." }
      },
      required: ["path"],
      additionalProperties: false
    }
  ),
  functionTool(
    "write_file",
    "Write full content to a file, creating directories when requested.",
    {
      type: "object",
      properties: {
        path: { type: "string", description: "Target path." },
        content: { type: "string", description: "Complete file content to write." },
        create_directories: { type: "boolean", description: "Create parent directories. Defaults to true." }
      },
      required: ["path", "content"],
      additionalProperties: false
    }
  ),
  functionTool(
    "replace_in_file",
    "Replace a string occurrence in a file.",
    {
      type: "object",
      properties: {
        path: { type: "string", description: "Target file." },
        search: { type: "string", description: "Exact text to find." },
        replace: { type: "string", description: "Replacement text." },
        all: { type: "boolean", description: "Replace all matches. Defaults to false." }
      },
      required: ["path", "search", "replace"],
      additionalProperties: false
    }
  ),
  functionTool(
    "delete_file",
    "Delete a file.",
    {
      type: "object",
      properties: {
        path: { type: "string", description: "File path." }
      },
      required: ["path"],
      additionalProperties: false
    }
  ),
  functionTool(
    "apply_unified_patch",
    "Apply a unified diff patch to files in the workspace. Use this for multi-file refactors and precise edits.",
    {
      type: "object",
      properties: {
        patch: { type: "string", description: "Unified diff patch text." },
        dry_run: { type: "boolean", description: "Only validate applicability; do not write files." }
      },
      required: ["patch"],
      additionalProperties: false
    }
  ),
  functionTool(
    "run_command",
    "Run a shell command in the workspace.",
    {
      type: "object",
      properties: {
        command: { type: "string", description: "Command to run." },
        cwd: { type: "string", description: "Working directory for this command (defaults to workspace root)." },
        timeout_ms: { type: "number", description: "Execution timeout in milliseconds." }
      },
      required: ["command"],
      additionalProperties: false
    }
  ),
  functionTool(
    "git_status",
    "Get git branch and status for the workspace.",
    {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  )
];

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const remainder = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n...[truncated ${remainder} chars]`;
}

function isInsideWorkspace(workspace: string, candidate: string): boolean {
  const relative = path.relative(workspace, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolvePath(inputPath: string | undefined, ctx: ToolContext): string {
  const target = inputPath?.trim() ? inputPath : ".";
  const absolute = path.resolve(ctx.workspaceCwd, target);

  if (!ctx.allowOutsideWorkspace && !isInsideWorkspace(ctx.workspaceCwd, absolute)) {
    throw new Error(`Path is outside the workspace: ${inputPath}`);
  }

  return absolute;
}

async function getWorkspaceInfo(ctx: ToolContext): Promise<unknown> {
  return {
    workspace_cwd: ctx.workspaceCwd,
    allow_outside_workspace: ctx.allowOutsideWorkspace
  };
}

async function listFiles(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const basePath = resolvePath(typeof args.path === "string" ? args.path : ".", ctx);
  const recursive = Boolean(args.recursive);
  const includeHidden = Boolean(args.hidden);
  const maxEntries = Math.max(1, Math.min(5000, Number(args.max_entries ?? 200)));

  const entries: Array<{ path: string; type: "file" | "dir" }> = [];
  const queue: string[] = [basePath];

  while (queue.length > 0 && entries.length < maxEntries) {
    const current = queue.shift()!;
    const dirEntries = await fs.readdir(current, { withFileTypes: true });

    for (const entry of dirEntries) {
      if (!includeHidden && entry.name.startsWith(".")) {
        continue;
      }

      const absolute = path.join(current, entry.name);
      const relative = path.relative(ctx.workspaceCwd, absolute) || ".";

      if (entry.isDirectory()) {
        entries.push({ path: `${relative}/`, type: "dir" });
        if (recursive) {
          queue.push(absolute);
        }
      } else {
        entries.push({ path: relative, type: "file" });
      }

      if (entries.length >= maxEntries) {
        break;
      }
    }
  }

  return {
    root: path.relative(ctx.workspaceCwd, basePath) || ".",
    recursive,
    returned: entries.length,
    max_entries: maxEntries,
    entries
  };
}

function withLineNumbers(content: string, startLine: number): string {
  const lines = content.split(/\r?\n/);
  return lines.map((line, idx) => `${startLine + idx}| ${line}`).join("\n");
}

async function readFileTool(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const targetPath = resolvePath(String(args.path), ctx);
  const stat = await fs.stat(targetPath);

  if (!stat.isFile()) {
    throw new Error(`Not a file: ${targetPath}`);
  }

  if (stat.size > ctx.maxFileBytes) {
    throw new Error(`File too large (${stat.size} bytes). Max is ${ctx.maxFileBytes} bytes.`);
  }

  const raw = await fs.readFile(targetPath, "utf8");
  const lines = raw.split(/\r?\n/);

  const startLine = Math.max(1, Number(args.start_line ?? 1));
  const endLine = Math.max(startLine, Number(args.end_line ?? 500));

  const startIdx = startLine - 1;
  const endIdxExclusive = Math.min(lines.length, endLine);
  const slice = lines.slice(startIdx, endIdxExclusive).join("\n");

  return {
    path: path.relative(ctx.workspaceCwd, targetPath),
    total_lines: lines.length,
    start_line: startLine,
    end_line: endIdxExclusive,
    content: withLineNumbers(slice, startLine)
  };
}

async function writeFileTool(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const targetPath = resolvePath(String(args.path), ctx);
  const createDirs = args.create_directories === undefined ? true : Boolean(args.create_directories);
  const content = String(args.content ?? "");

  if (createDirs) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
  }

  await fs.writeFile(targetPath, content, "utf8");

  return {
    path: path.relative(ctx.workspaceCwd, targetPath),
    bytes_written: Buffer.byteLength(content, "utf8")
  };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }

  let count = 0;
  let cursor = 0;
  while (true) {
    const idx = haystack.indexOf(needle, cursor);
    if (idx < 0) {
      break;
    }
    count += 1;
    cursor = idx + needle.length;
  }
  return count;
}

async function replaceInFileTool(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const targetPath = resolvePath(String(args.path), ctx);
  const search = String(args.search ?? "");
  const replace = String(args.replace ?? "");
  const replaceAll = Boolean(args.all);

  if (!search) {
    throw new Error("search must be non-empty");
  }

  const current = await fs.readFile(targetPath, "utf8");
  if (!current.includes(search)) {
    throw new Error("search text not found");
  }

  const replacements = replaceAll ? countOccurrences(current, search) : 1;
  const updated = replaceAll ? current.split(search).join(replace) : current.replace(search, replace);

  await fs.writeFile(targetPath, updated, "utf8");

  return {
    path: path.relative(ctx.workspaceCwd, targetPath),
    replacements
  };
}

async function deleteFileTool(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const targetPath = resolvePath(String(args.path), ctx);
  await fs.unlink(targetPath);

  return {
    path: path.relative(ctx.workspaceCwd, targetPath),
    deleted: true
  };
}

async function runCommand(args: Record<string, unknown>, ctx: ToolContext): Promise<RunCommandResult> {
  const command = String(args.command ?? "").trim();
  if (!command) {
    throw new Error("command is required");
  }

  const commandCwd = resolvePath(typeof args.cwd === "string" ? args.cwd : ".", ctx);
  const timeoutMs = Math.max(1, Number(args.timeout_ms ?? ctx.defaultCommandTimeoutMs));
  const start = Date.now();

  const processResult = await runProcess(
    "zsh",
    ["-lc", command],
    commandCwd,
    timeoutMs,
    ctx.maxCommandOutputChars
  );
  const duration = Date.now() - start;
  return {
    command,
    cwd: path.relative(ctx.workspaceCwd, commandCwd) || ".",
    exit_code: processResult.exitCode,
    timed_out: processResult.timedOut,
    duration_ms: duration,
    stdout: processResult.stdout,
    stderr: processResult.stderr
  };
}

async function runProcess(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  maxOutputChars: number
): Promise<ProcessResult> {
  const start = Date.now();

  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(cmd, args, {
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

function normalizeDiffPath(rawPath: string): string | undefined {
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

function extractPatchPaths(patch: string): string[] {
  const lines = patch.split(/\r?\n/);
  const paths = new Set<string>();

  for (const line of lines) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const candidate = normalizeDiffPath(line.slice(4));
      if (candidate) {
        paths.add(candidate);
      }
      continue;
    }

    if (line.startsWith("diff --git ")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 4) {
        const left = normalizeDiffPath(parts[2]);
        const right = normalizeDiffPath(parts[3]);
        if (left) {
          paths.add(left);
        }
        if (right) {
          paths.add(right);
        }
      }
    }
  }

  return [...paths];
}

function chooseStripLevels(patch: string): number[] {
  const hasGitPrefixes =
    /^\+\+\+\s+b\//m.test(patch) ||
    /^---\s+a\//m.test(patch) ||
    /^diff --git a\//m.test(patch);
  return hasGitPrefixes ? [1, 0] : [0, 1];
}

export async function applyUnifiedPatch(patch: string, ctx: ToolContext, dryRun = false): Promise<unknown> {
  if (!patch.trim()) {
    throw new Error("patch must be non-empty");
  }

  if (Buffer.byteLength(patch, "utf8") > 1_000_000) {
    throw new Error("patch too large (max 1,000,000 bytes)");
  }

  const patchPaths = extractPatchPaths(patch);
  if (patchPaths.length === 0) {
    throw new Error("patch does not contain recognizable file headers");
  }

  for (const rel of patchPaths) {
    const absolute = path.resolve(ctx.workspaceCwd, rel);
    if (!ctx.allowOutsideWorkspace && !isInsideWorkspace(ctx.workspaceCwd, absolute)) {
      throw new Error(`Patch references path outside workspace: ${rel}`);
    }
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "grokcode-patch-"));
  const patchFile = path.join(tmpDir, "change.patch");

  try {
    await fs.writeFile(patchFile, patch, "utf8");

    const stripLevels = chooseStripLevels(patch);
    let selectedStrip: number | undefined;
    let lastError = "";
    let checkResult: ProcessResult | undefined;

    for (const strip of stripLevels) {
      const result = await runProcess(
        "git",
        ["apply", "--no-index", "--check", "--recount", "--whitespace=nowarn", `-p${strip}`, patchFile],
        ctx.workspaceCwd,
        ctx.defaultCommandTimeoutMs,
        ctx.maxCommandOutputChars
      );

      if (result.exitCode === 0) {
        selectedStrip = strip;
        checkResult = result;
        break;
      }

      lastError = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    }

    if (selectedStrip === undefined) {
      throw new Error(`patch validation failed: ${lastError || "unknown git apply error"}`);
    }

    if (dryRun) {
      return {
        applied: false,
        dry_run: true,
        strip_level: selectedStrip,
        files: patchPaths,
        file_count: patchPaths.length,
        validation: {
          duration_ms: checkResult?.durationMs ?? 0,
          stdout: checkResult?.stdout ?? "",
          stderr: checkResult?.stderr ?? ""
        }
      };
    }

    const applyResult = await runProcess(
      "git",
      ["apply", "--no-index", "--recount", "--whitespace=nowarn", `-p${selectedStrip}`, patchFile],
      ctx.workspaceCwd,
      ctx.defaultCommandTimeoutMs,
      ctx.maxCommandOutputChars
    );

    if (applyResult.exitCode !== 0) {
      throw new Error([applyResult.stdout, applyResult.stderr].filter(Boolean).join("\n").trim() || "git apply failed");
    }

    return {
      applied: true,
      dry_run: false,
      strip_level: selectedStrip,
      files: patchPaths,
      file_count: patchPaths.length,
      duration_ms: applyResult.durationMs
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function applyUnifiedPatchTool(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  return await applyUnifiedPatch(String(args.patch ?? ""), ctx, Boolean(args.dry_run));
}

async function searchFilesTool(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const pattern = String(args.pattern ?? "").trim();
  if (!pattern) {
    throw new Error("pattern is required");
  }

  const basePath = resolvePath(typeof args.path === "string" ? args.path : ".", ctx);
  const maxResults = Math.max(1, Math.min(2000, Number(args.max_results ?? 100)));

  const rgArgs = [
    "--line-number",
    "--column",
    "--no-heading",
    "--color=never",
    "--max-count",
    String(maxResults)
  ];

  if (typeof args.glob === "string" && args.glob.trim()) {
    rgArgs.push("-g", args.glob.trim());
  }

  rgArgs.push(pattern, basePath);

  const result = await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
    const child = spawn("rg", rgArgs, {
      cwd: ctx.workspaceCwd,
      env: process.env
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code });
    });
  });

  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(`rg failed (exit ${result.exitCode}): ${result.stderr}`);
  }

  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  const matches = lines.map((line) => {
    const match = /^(.*?):(\d+):(\d+):(.*)$/.exec(line);
    if (!match) {
      return { raw: line };
    }

    const filePath = path.relative(ctx.workspaceCwd, match[1]);
    return {
      path: filePath,
      line: Number(match[2]),
      column: Number(match[3]),
      text: match[4]
    };
  });

  return {
    pattern,
    searched_in: path.relative(ctx.workspaceCwd, basePath) || ".",
    matches: matches.slice(0, maxResults),
    total_matches: matches.length
  };
}

async function gitStatusTool(ctx: ToolContext): Promise<unknown> {
  const result = await runCommand({ command: "git status --short --branch", cwd: ".", timeout_ms: 15000 }, ctx);
  return {
    exit_code: result.exit_code,
    output: [result.stdout, result.stderr].filter(Boolean).join("\n").trim()
  };
}

function parseArgs(argsText: string): Record<string, unknown> {
  if (!argsText?.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(argsText);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }

    throw new Error("Tool arguments must be a JSON object");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid tool arguments JSON: ${message}`);
  }
}

export async function executeToolCall(call: ToolCall, ctx: ToolContext): Promise<ToolExecutionResult> {
  let args: Record<string, unknown>;
  try {
    args = parseArgs(call.arguments);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }

  try {
    let result: unknown;

    switch (call.name) {
      case "get_workspace_info":
        result = await getWorkspaceInfo(ctx);
        break;
      case "list_files":
        result = await listFiles(args, ctx);
        break;
      case "search_files":
        result = await searchFilesTool(args, ctx);
        break;
      case "read_file":
        result = await readFileTool(args, ctx);
        break;
      case "write_file":
        result = await writeFileTool(args, ctx);
        break;
      case "replace_in_file":
        result = await replaceInFileTool(args, ctx);
        break;
      case "delete_file":
        result = await deleteFileTool(args, ctx);
        break;
      case "apply_unified_patch":
        result = await applyUnifiedPatchTool(args, ctx);
        break;
      case "run_command":
        result = await runCommand(args, ctx);
        break;
      case "git_status":
        result = await gitStatusTool(ctx);
        break;
      default:
        return { ok: false, error: `Unknown tool: ${call.name}` };
    }

    return { ok: true, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

export function summarizeToolResult(result: ToolExecutionResult): string {
  if (!result.ok) {
    return `error: ${result.error ?? "unknown"}`;
  }

  const text = JSON.stringify(result.result);
  return truncate(text, 240);
}
