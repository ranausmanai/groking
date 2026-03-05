#!/usr/bin/env node

// src/cli.ts
import "dotenv/config";
import fs5 from "fs/promises";
import path5 from "path";
import process6 from "process";
import { Command } from "commander";

// src/agent.ts
import OpenAI from "openai";

// src/prompts.ts
var DEFAULT_SYSTEM_PROMPT = `You are GrokCode, a terminal coding agent with local tool access.

Rules:
- Make precise, minimal, correct code changes.
- Prefer reading files before editing them.
- Keep edits scoped to the user request.
- Prefer patch-style edits using apply_unified_patch for existing files; fall back to write_file only when needed.
- Run checks/tests after edits when feasible.
- If a command fails, explain the failure and propose the next fix.
- Never fabricate command output or file contents.
- Use relative workspace paths in explanations.
- When you need to change files, use tools instead of describing hypothetical edits.
- If the request is ambiguous, state your assumption and continue.
- Avoid destructive actions unless explicitly requested.
`;
function withUserSystemOverride(override) {
  if (!override?.trim()) {
    return DEFAULT_SYSTEM_PROMPT;
  }
  return `${DEFAULT_SYSTEM_PROMPT}
Additional user instructions:
${override.trim()}
`;
}

// src/tools.ts
import { spawn } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
function functionTool(name, description, parameters) {
  return {
    type: "function",
    name,
    description,
    parameters,
    strict: false
  };
}
var TOOL_SCHEMAS = [
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
function truncate(text, maxChars) {
  if (text.length <= maxChars) {
    return text;
  }
  const remainder = text.length - maxChars;
  return `${text.slice(0, maxChars)}
...[truncated ${remainder} chars]`;
}
function isInsideWorkspace(workspace, candidate) {
  const relative = path.relative(workspace, candidate);
  return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
}
function resolvePath(inputPath, ctx) {
  const target = inputPath?.trim() ? inputPath : ".";
  const absolute = path.resolve(ctx.workspaceCwd, target);
  if (!ctx.allowOutsideWorkspace && !isInsideWorkspace(ctx.workspaceCwd, absolute)) {
    throw new Error(`Path is outside the workspace: ${inputPath}`);
  }
  return absolute;
}
async function getWorkspaceInfo(ctx) {
  return {
    workspace_cwd: ctx.workspaceCwd,
    allow_outside_workspace: ctx.allowOutsideWorkspace
  };
}
async function listFiles(args, ctx) {
  const basePath = resolvePath(typeof args.path === "string" ? args.path : ".", ctx);
  const recursive = Boolean(args.recursive);
  const includeHidden = Boolean(args.hidden);
  const maxEntries = Math.max(1, Math.min(5e3, Number(args.max_entries ?? 200)));
  const entries = [];
  const queue = [basePath];
  while (queue.length > 0 && entries.length < maxEntries) {
    const current = queue.shift();
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
function withLineNumbers(content, startLine) {
  const lines = content.split(/\r?\n/);
  return lines.map((line, idx) => `${startLine + idx}| ${line}`).join("\n");
}
async function readFileTool(args, ctx) {
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
async function writeFileTool(args, ctx) {
  const targetPath = resolvePath(String(args.path), ctx);
  const createDirs = args.create_directories === void 0 ? true : Boolean(args.create_directories);
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
function countOccurrences(haystack, needle) {
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
async function replaceInFileTool(args, ctx) {
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
async function deleteFileTool(args, ctx) {
  const targetPath = resolvePath(String(args.path), ctx);
  await fs.unlink(targetPath);
  return {
    path: path.relative(ctx.workspaceCwd, targetPath),
    deleted: true
  };
}
async function runCommand(args, ctx) {
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
async function runProcess(cmd, args, cwd, timeoutMs, maxOutputChars) {
  const start = Date.now();
  return await new Promise((resolve, reject) => {
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
      setTimeout(() => child.kill("SIGKILL"), 1e3).unref();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
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
function normalizeDiffPath(rawPath) {
  const withoutTimestamp = rawPath.split("	")[0].trim();
  if (!withoutTimestamp || withoutTimestamp === "/dev/null") {
    return void 0;
  }
  let normalized = withoutTimestamp;
  if (normalized.startsWith("a/") || normalized.startsWith("b/")) {
    normalized = normalized.slice(2);
  }
  normalized = path.normalize(normalized);
  if (!normalized || normalized === "." || path.isAbsolute(normalized)) {
    return void 0;
  }
  return normalized;
}
function extractPatchPaths(patch) {
  const lines = patch.split(/\r?\n/);
  const paths = /* @__PURE__ */ new Set();
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
function chooseStripLevels(patch) {
  const hasGitPrefixes = /^\+\+\+\s+b\//m.test(patch) || /^---\s+a\//m.test(patch) || /^diff --git a\//m.test(patch);
  return hasGitPrefixes ? [1, 0] : [0, 1];
}
async function applyUnifiedPatch(patch, ctx, dryRun = false) {
  if (!patch.trim()) {
    throw new Error("patch must be non-empty");
  }
  if (Buffer.byteLength(patch, "utf8") > 1e6) {
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
    let selectedStrip;
    const checkErrors = [];
    let checkResult;
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
      const message = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      if (message) {
        checkErrors.push(`-p${strip}: ${message}`);
      }
    }
    if (selectedStrip === void 0) {
      const details = checkErrors.length > 0 ? checkErrors.join("\n") : "unknown git apply error";
      throw new Error(`patch validation failed: ${details}`);
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
async function applyUnifiedPatchTool(args, ctx) {
  return await applyUnifiedPatch(String(args.patch ?? ""), ctx, Boolean(args.dry_run));
}
async function searchFilesTool(args, ctx) {
  const pattern = String(args.pattern ?? "").trim();
  if (!pattern) {
    throw new Error("pattern is required");
  }
  const basePath = resolvePath(typeof args.path === "string" ? args.path : ".", ctx);
  const maxResults = Math.max(1, Math.min(2e3, Number(args.max_results ?? 100)));
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
  const result = await new Promise((resolve, reject) => {
    const child = spawn("rg", rgArgs, {
      cwd: ctx.workspaceCwd,
      env: process.env
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
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
async function gitStatusTool(ctx) {
  const result = await runCommand({ command: "git status --short --branch", cwd: ".", timeout_ms: 15e3 }, ctx);
  return {
    exit_code: result.exit_code,
    output: [result.stdout, result.stderr].filter(Boolean).join("\n").trim()
  };
}
function parseArgs(argsText) {
  if (!argsText?.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(argsText);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
    throw new Error("Tool arguments must be a JSON object");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid tool arguments JSON: ${message}`);
  }
}
async function executeToolCall(call, ctx) {
  let args;
  try {
    args = parseArgs(call.arguments);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
  try {
    let result;
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
function summarizeToolResult(result) {
  if (!result.ok) {
    return `error: ${result.error ?? "unknown"}`;
  }
  const text = JSON.stringify(result.result);
  return truncate(text, 240);
}

// src/agent.ts
function parsePlannedSubtasksFromObject(parsed) {
  const tasksRaw = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
  if (tasksRaw.length === 0) {
    return [];
  }
  const intermediate = tasksRaw.reduce((acc, item, index) => {
    const record = item;
    const label = String(record.label ?? "").trim();
    const task = String(record.task ?? "").trim();
    if (!task) {
      return acc;
    }
    const scopeRaw = Array.isArray(record.scope) ? record.scope : [];
    const dependsRaw = Array.isArray(record.depends_on) ? record.depends_on : [];
    const scope = scopeRaw.map((part) => String(part ?? "").trim()).filter(Boolean).slice(0, 8);
    const dependsOn = dependsRaw.map((part) => String(part ?? "").trim()).filter(Boolean).slice(0, 8);
    acc.push({
      label: label || `worker-task-${index + 1}`,
      task,
      scope,
      depends_on: dependsOn
    });
    return acc;
  }, []).slice(0, 8);
  if (intermediate.length === 0) {
    return [];
  }
  const labelCounts = /* @__PURE__ */ new Map();
  const normalized = intermediate.map((item) => {
    const seen = (labelCounts.get(item.label) ?? 0) + 1;
    labelCounts.set(item.label, seen);
    const label = seen === 1 ? item.label : `${item.label}-${seen}`;
    return { ...item, label };
  });
  const allowedLabels = new Set(normalized.map((item) => item.label));
  return normalized.map((item) => {
    const depends = item.depends_on.filter((label) => label !== item.label && allowedLabels.has(label)).filter((label, index, arr) => arr.indexOf(label) === index).slice(0, 8);
    const planned = {
      label: item.label,
      task: item.task
    };
    if (item.scope.length > 0) {
      planned.scope = item.scope;
    }
    if (depends.length > 0) {
      planned.depends_on = depends;
    }
    return planned;
  });
}
function parsePlannedSubtasksText(text) {
  const parsed = extractJsonObject(text);
  return parsePlannedSubtasksFromObject(parsed);
}
function toToolCall(item) {
  return {
    name: String(item.name),
    arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
    callId: String(item.call_id)
  };
}
function extractOutputText(response) {
  if (typeof response.output_text === "string" && response.output_text.trim().length > 0) {
    return response.output_text;
  }
  const output = Array.isArray(response.output) ? response.output : [];
  const chunks = [];
  for (const item of output) {
    if (item?.type !== "message") {
      continue;
    }
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (part?.type === "output_text" && typeof part.text === "string") {
        chunks.push(part.text);
      }
      if (part?.type === "text" && typeof part.text === "string") {
        chunks.push(part.text);
      }
    }
  }
  return chunks.join("\n").trim();
}
function extractJsonObject(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return void 0;
  }
  try {
    const direct = JSON.parse(trimmed);
    if (direct && typeof direct === "object" && !Array.isArray(direct)) {
      return direct;
    }
  } catch {
  }
  const fenceMatch = /```json\s*([\s\S]*?)```/i.exec(text);
  if (fenceMatch?.[1]) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
    }
  }
  const objectMatch = /\{[\s\S]*\}/.exec(text);
  if (!objectMatch) {
    return void 0;
  }
  try {
    const parsed = JSON.parse(objectMatch[0]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    return void 0;
  }
  return void 0;
}
var GrokAgent = class _GrokAgent {
  client;
  apiKey;
  baseURL;
  toolContext;
  instructionsSupported = true;
  instructionsWithPreviousResponseSupported = true;
  constructor(config) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL;
    this.client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
    this.toolContext = config.toolContext;
  }
  forkWithToolContext(toolContext) {
    const next = new _GrokAgent({
      apiKey: this.apiKey,
      baseURL: this.baseURL,
      toolContext
    });
    next.instructionsSupported = this.instructionsSupported;
    next.instructionsWithPreviousResponseSupported = this.instructionsWithPreviousResponseSupported;
    return next;
  }
  static isInstructionsUnsupportedError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("Parameter is not supported with reasoning models: instructions");
  }
  static isInstructionsWithPreviousResponseUnsupportedError(error) {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return message.includes("not supported") && message.includes("instructions") && message.includes("previous_response_id");
  }
  async createResponse(request, instructions) {
    const includeInstructions = this.instructionsSupported && (this.instructionsWithPreviousResponseSupported || request.previous_response_id === void 0);
    try {
      return await this.client.responses.create({
        ...request,
        instructions: includeInstructions ? instructions : void 0,
        store: true
      });
    } catch (error) {
      if (includeInstructions && _GrokAgent.isInstructionsWithPreviousResponseUnsupportedError(error) && request.previous_response_id) {
        this.instructionsWithPreviousResponseSupported = false;
        return await this.client.responses.create({
          ...request,
          store: true
        });
      }
      if (!includeInstructions || !_GrokAgent.isInstructionsUnsupportedError(error)) {
        throw error;
      }
      this.instructionsSupported = false;
      return await this.client.responses.create({
        ...request,
        store: true
      });
    }
  }
  async run(input, state, hooks, options) {
    const instructions = withUserSystemOverride(state.systemPromptOverride);
    let response = await this.createResponse(
      {
        model: state.model,
        input,
        previous_response_id: state.previousResponseId,
        tools: state.enableTools ? TOOL_SCHEMAS : void 0,
        tool_choice: state.enableTools ? "auto" : "none"
      },
      instructions
    );
    const maxToolRounds = Math.max(1, options?.maxToolRounds ?? 24);
    let rounds = 0;
    while (state.enableTools) {
      const calls = (Array.isArray(response.output) ? response.output : []).filter((item) => item?.type === "function_call").map(toToolCall);
      if (calls.length === 0) {
        break;
      }
      rounds += 1;
      if (rounds > maxToolRounds) {
        throw new Error(`Tool loop exceeded ${maxToolRounds} rounds`);
      }
      const toolOutputs = [];
      for (const call of calls) {
        hooks?.onToolCallStart?.(call);
        const result = await executeToolCall(call, this.toolContext);
        hooks?.onToolCallResult?.(call, result);
        toolOutputs.push({
          type: "function_call_output",
          call_id: call.callId,
          output: JSON.stringify(result)
        });
      }
      response = await this.createResponse(
        {
          model: state.model,
          previous_response_id: response.id,
          input: toolOutputs,
          tools: TOOL_SCHEMAS,
          tool_choice: "auto"
        },
        instructions
      );
    }
    const text = extractOutputText(response);
    return {
      text,
      responseId: String(response.id)
    };
  }
  async listModels() {
    const response = await this.client.models.list();
    const items = Array.isArray(response.data) ? response.data : [];
    return items.map((item) => ({ id: String(item?.id ?? "") })).filter((item) => item.id.length > 0).sort((a, b) => a.id.localeCompare(b.id));
  }
  async planSubtasks(goal, state, plannerModel) {
    const instructions = withUserSystemOverride(state.systemPromptOverride);
    const planningModel = plannerModel?.trim() || state.plannerModel?.trim() || state.model;
    const basePrompt = `Break this engineering goal into 2-6 executable worker tasks.

Goal:
${goal}

Output strict JSON only:
{"tasks":[{"label":"short label","task":"concrete engineering instruction","scope":["path/or/file"],"depends_on":["other label"]}]}

Rules:
- include one setup task when needed (files/directories/bootstrap)
- implementation tasks should have disjoint scope whenever possible
- test/verify tasks must depend_on implementation tasks
- scope should be specific paths (files or directories)
- depends_on values must reference labels from this same task list
- do not include markdown`;
    const response = await this.createResponse(
      {
        model: planningModel,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: basePrompt }]
          }
        ]
      },
      instructions
    );
    const text = extractOutputText(response);
    let tasks = parsePlannedSubtasksText(text);
    if (tasks.length > 0) {
      return tasks;
    }
    const repairPrompt = `Rewrite the following planner draft into strict JSON with this exact shape:
{"tasks":[{"label":"short label","task":"concrete engineering instruction","scope":["path/or/file"],"depends_on":["other label"]}]}

Return JSON only. No markdown.

Draft:
${text || "(empty response)"}`;
    const repaired = await this.createResponse(
      {
        model: planningModel,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: repairPrompt }]
          }
        ]
      },
      instructions
    );
    tasks = parsePlannedSubtasksText(extractOutputText(repaired));
    if (tasks.length > 0) {
      return tasks;
    }
    return [{ label: "implementation", task: goal.trim() }];
  }
};

// src/auth.ts
import fs2 from "fs/promises";
import os2 from "os";
import path2 from "path";
import process2 from "process";
import readline from "readline/promises";
function configPath() {
  return path2.join(os2.homedir(), ".groking", "config.json");
}
async function readConfig() {
  try {
    const raw = await fs2.readFile(configPath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
async function writeConfig(next) {
  const file = configPath();
  await fs2.mkdir(path2.dirname(file), { recursive: true });
  await fs2.writeFile(file, `${JSON.stringify(next, null, 2)}
`, "utf8");
}
async function promptVisible(promptText) {
  const rl = readline.createInterface({
    input: process2.stdin,
    output: process2.stdout,
    terminal: true
  });
  try {
    return (await rl.question(promptText)).trim();
  } finally {
    rl.close();
  }
}
async function promptHidden(promptText) {
  if (!process2.stdin.isTTY || !process2.stdout.isTTY) {
    return await promptVisible(promptText);
  }
  const stdin = process2.stdin;
  const stdout = process2.stdout;
  const chunks = [];
  return await new Promise((resolve, reject) => {
    const restoreRawMode = stdin.isRaw;
    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(restoreRawMode ?? false);
      stdin.pause();
    };
    const onData = (buf) => {
      const text = buf.toString("utf8");
      if (text === "") {
        stdout.write("\n");
        cleanup();
        reject(new Error("Input cancelled"));
        return;
      }
      if (text === "\r" || text === "\n") {
        stdout.write("\n");
        cleanup();
        resolve(chunks.join("").trim());
        return;
      }
      if (text === "\x7F") {
        if (chunks.length > 0) {
          chunks.pop();
          stdout.write("\b \b");
        }
        return;
      }
      chunks.push(text);
      stdout.write("*");
    };
    stdout.write(promptText);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}
async function resolveApiKeyInteractive() {
  const fromEnv = process2.env.XAI_API_KEY?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const config = await readConfig();
  const fromConfig = config.xai_api_key?.trim();
  if (fromConfig) {
    return fromConfig;
  }
  console.log("No xAI API key found. Enter it once to continue.");
  const entered = await promptHidden("XAI_API_KEY: ");
  if (!entered) {
    throw new Error("XAI_API_KEY is required.");
  }
  await writeConfig({
    ...config,
    xai_api_key: entered
  });
  return entered;
}

// src/banner.ts
import process3 from "process";
var RESET = "\x1B[0m";
var BOLD = "\x1B[1m";
var LETTER_COLORS = [
  [255, 70, 70],
  // G - red
  [255, 150, 50],
  // R - orange
  [255, 220, 50],
  // O - yellow
  [50, 220, 120],
  // K - green
  [50, 180, 255],
  // I - cyan
  [100, 100, 255],
  // N - blue
  [200, 100, 255]
  // G - purple
];
var LETTERS = [
  // G
  [
    " \u2588\u2588\u2588\u2588\u2588\u2588 ",
    "\u2588\u2588      ",
    "\u2588\u2588  \u2588\u2588\u2588 ",
    "\u2588\u2588   \u2588\u2588 ",
    " \u2588\u2588\u2588\u2588\u2588\u2588 "
  ],
  // R
  [
    "\u2588\u2588\u2588\u2588\u2588\u2588  ",
    "\u2588\u2588   \u2588\u2588 ",
    "\u2588\u2588\u2588\u2588\u2588\u2588  ",
    "\u2588\u2588  \u2588\u2588  ",
    "\u2588\u2588   \u2588\u2588 "
  ],
  // O
  [
    " \u2588\u2588\u2588\u2588\u2588  ",
    "\u2588\u2588   \u2588\u2588 ",
    "\u2588\u2588   \u2588\u2588 ",
    "\u2588\u2588   \u2588\u2588 ",
    " \u2588\u2588\u2588\u2588\u2588  "
  ],
  // K
  [
    "\u2588\u2588  \u2588\u2588 ",
    "\u2588\u2588 \u2588\u2588  ",
    "\u2588\u2588\u2588\u2588   ",
    "\u2588\u2588 \u2588\u2588  ",
    "\u2588\u2588  \u2588\u2588 "
  ],
  // I
  [
    "\u2588\u2588 ",
    "\u2588\u2588 ",
    "\u2588\u2588 ",
    "\u2588\u2588 ",
    "\u2588\u2588 "
  ],
  // N
  [
    "\u2588\u2588   \u2588\u2588 ",
    "\u2588\u2588\u2588  \u2588\u2588 ",
    "\u2588\u2588 \u2588 \u2588\u2588 ",
    "\u2588\u2588  \u2588\u2588\u2588 ",
    "\u2588\u2588   \u2588\u2588 "
  ],
  // G
  [
    " \u2588\u2588\u2588\u2588\u2588\u2588 ",
    "\u2588\u2588      ",
    "\u2588\u2588  \u2588\u2588\u2588 ",
    "\u2588\u2588   \u2588\u2588 ",
    " \u2588\u2588\u2588\u2588\u2588\u2588 "
  ]
];
function supportsColor() {
  return Boolean(process3.stdout.isTTY) && process3.env.NO_COLOR === void 0;
}
function rgb(text, r, g, b) {
  return `\x1B[38;2;${r};${g};${b}m${text}`;
}
function buildBannerLines() {
  const rows = LETTERS[0].length;
  const lines = [];
  for (let row = 0; row < rows; row++) {
    let line = "  ";
    for (let li = 0; li < LETTERS.length; li++) {
      line += LETTERS[li][row];
    }
    lines.push(line);
  }
  return lines;
}
function colorizeLine(line) {
  let out = "";
  let col = 0;
  for (const char of line) {
    if (char === " ") {
      out += char;
      col++;
      continue;
    }
    const letterIdx = getLetterIndex(col);
    const [r, g, b] = LETTER_COLORS[letterIdx];
    out += rgb(char, r, g, b);
    col++;
  }
  return out + RESET;
}
function getLetterIndex(col) {
  let pos = 2;
  for (let i = 0; i < LETTERS.length; i++) {
    const width = LETTERS[i][0].length;
    if (col < pos + width) return i;
    pos += width;
  }
  return LETTERS.length - 1;
}
function printGrokingBanner() {
  const lines = buildBannerLines();
  if (!supportsColor()) {
    console.log(`
${lines.join("\n")}
`);
    console.log("GROKING  |  Terminal coding agent for Grok\n");
    return;
  }
  const colored = lines.map((line) => colorizeLine(line));
  const subtitle = rgb(`${BOLD}  Terminal coding agent for Grok`, 0, 200, 255);
  const tip = rgb("  Tip: /help for commands, /reset to clear context", 120, 110, 160);
  console.log();
  console.log(colored.join("\n"));
  console.log();
  console.log(`${subtitle}`);
  console.log(`${tip}
`);
}

// src/repl.ts
import readline3 from "readline/promises";
import * as nodeReadline from "readline";
import process5 from "process";

// src/subagents.ts
import { spawn as spawn2 } from "child_process";
import crypto from "crypto";
import fs3 from "fs/promises";
import os3 from "os";
import path3 from "path";
function summarizeText(text, maxChars = 160) {
  if (!text) {
    return void 0;
  }
  const line = text.split(/\r?\n/).map((item) => item.trim()).find(Boolean);
  if (!line) {
    return void 0;
  }
  return line.length <= maxChars ? line : `${line.slice(0, maxChars - 1)}\u2026`;
}
function describeSubagentRun(run2) {
  const parts = [];
  if (run2.scope?.length) {
    parts.push(`scope: ${run2.scope.join(", ")}`);
  }
  const fileHint = run2.patchFiles?.length ? run2.patchFiles.slice(0, 3).join(", ") + (run2.patchFiles.length > 3 ? ` +${run2.patchFiles.length - 3} more` : "") : void 0;
  if (fileHint) {
    parts.push(`files: ${fileHint}`);
  }
  if (run2.mergeStatus) {
    parts.push(`merge: ${run2.mergeStatus}`);
  }
  if (run2.status === "failed" && run2.error) {
    parts.push(`error: ${run2.error}`);
  }
  if (run2.status === "failed" && run2.blockedBy?.length) {
    parts.push(`blocked by: ${run2.blockedBy.join(", ")}`);
  }
  if (run2.mergeStatus === "conflict" && run2.mergeError) {
    parts.push(`merge error: ${run2.mergeError}`);
  }
  const summary = summarizeText(run2.output);
  if (summary) {
    parts.push(summary);
  }
  return parts.join(" | ");
}
function summarizeToolCall(call) {
  try {
    const parsed = JSON.parse(call.arguments || "{}");
    const interesting = ["path", "cwd", "command", "pattern"];
    for (const key of interesting) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) {
        return `${call.name} ${value.trim()}`;
      }
    }
  } catch {
  }
  return call.name;
}
function normalizeScopePath(input) {
  const value = input.trim();
  if (!value) {
    return void 0;
  }
  const hasTrailingSeparator = /[\\/]$/.test(value);
  let normalized = path3.normalize(value);
  normalized = normalized.replace(/[\\/]+$/, "");
  if (!normalized || normalized === ".") {
    return void 0;
  }
  if (hasTrailingSeparator) {
    return `${normalized}/`;
  }
  return normalized;
}
function stripScopeSeparator(input) {
  if (input.length <= 1) {
    return input;
  }
  return input.replace(/[\\/]+$/, "");
}
function scopesOverlap(left, right) {
  if (!left?.length || !right?.length) {
    return false;
  }
  for (const a of left) {
    for (const b of right) {
      const aPath = stripScopeSeparator(a);
      const bPath = stripScopeSeparator(b);
      if (aPath === bPath) {
        return true;
      }
      if (aPath.startsWith(`${bPath}${path3.sep}`) || bPath.startsWith(`${aPath}${path3.sep}`)) {
        return true;
      }
    }
  }
  return false;
}
function isPathCoveredByScopes(filePath, scopes) {
  if (!scopes || scopes.length === 0) {
    return true;
  }
  const normalizedFile = normalizeScopePath(filePath);
  if (!normalizedFile) {
    return false;
  }
  const filePathForMatch = stripScopeSeparator(normalizedFile);
  for (const scope of scopes) {
    const normalizedScope = normalizeScopePath(scope);
    if (!normalizedScope) {
      continue;
    }
    const scopePath = stripScopeSeparator(normalizedScope);
    if (filePathForMatch === scopePath) {
      return true;
    }
    if (filePathForMatch.startsWith(`${scopePath}${path3.sep}`)) {
      return true;
    }
  }
  return false;
}
function isDirectoryScope(scope) {
  return scope.endsWith("/");
}
function runLikelyRequiresFileChanges(run2) {
  const fileScoped = (run2.scope ?? []).filter((scope) => !isDirectoryScope(scope));
  if (fileScoped.length === 0) {
    return false;
  }
  return /\b(write|create|update|edit|modify|refactor|implement|add|remove|rename|patch)\b/i.test(run2.task);
}
var SNAPSHOT_EXCLUDES = /* @__PURE__ */ new Set([
  ".git",
  ".groking",
  "node_modules",
  "dist",
  ".DS_Store"
]);
var PATCH_EXCLUDED_DIR_NAMES = /* @__PURE__ */ new Set([
  "node_modules",
  "dist",
  ".next",
  ".nuxt",
  "coverage",
  ".cache",
  ".turbo",
  ".vite"
]);
function truncate2(text, maxChars) {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}
...[truncated ${text.length - maxChars} chars]`;
}
function shouldCopySnapshotPath(workspace, candidate) {
  const relative = path3.relative(workspace, candidate);
  if (!relative) {
    return true;
  }
  const parts = relative.split(path3.sep).filter(Boolean);
  return !parts.some((part) => SNAPSHOT_EXCLUDES.has(part));
}
async function pathExists(targetPath) {
  try {
    await fs3.lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}
async function cloneWorkspaceSnapshot(sourceWorkspace, targetWorkspace) {
  await fs3.mkdir(targetWorkspace, { recursive: true });
  await fs3.cp(sourceWorkspace, targetWorkspace, {
    recursive: true,
    preserveTimestamps: true,
    filter: (src) => shouldCopySnapshotPath(sourceWorkspace, src)
  });
  const nodeModulesSource = path3.join(sourceWorkspace, "node_modules");
  if (!await pathExists(nodeModulesSource)) {
    return;
  }
  const nodeModulesTarget = path3.join(targetWorkspace, "node_modules");
  if (await pathExists(nodeModulesTarget)) {
    return;
  }
  await fs3.symlink(nodeModulesSource, nodeModulesTarget, process.platform === "win32" ? "junction" : "dir");
}
async function prepareWorkerSnapshot(sourceWorkspace) {
  const bundleDir = await fs3.mkdtemp(path3.join(os3.tmpdir(), "groking-worker-"));
  const baseDir = path3.join(bundleDir, "base");
  const workerDir = path3.join(bundleDir, "worker");
  await cloneWorkspaceSnapshot(sourceWorkspace, baseDir);
  await cloneWorkspaceSnapshot(sourceWorkspace, workerDir);
  return { bundleDir, baseDir, workerDir };
}
async function prunePatchIgnoredPaths(rootDir) {
  const queue = [rootDir];
  while (queue.length > 0) {
    const current = queue.shift();
    const entries = await fs3.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path3.join(current, entry.name);
      if (!entry.isDirectory()) {
        continue;
      }
      if (PATCH_EXCLUDED_DIR_NAMES.has(entry.name)) {
        await fs3.rm(absolute, { recursive: true, force: true });
        continue;
      }
      queue.push(absolute);
    }
  }
}
async function runProcess2(command, args, cwd, timeoutMs, maxOutputChars) {
  const start = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn2(command, args, {
      cwd,
      env: process.env
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1e3).unref();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
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
        stdout: truncate2(stdout, maxOutputChars),
        stderr: truncate2(stderr, maxOutputChars)
      });
    });
  });
}
function sanitizePatchLine(line) {
  if (line.startsWith("diff --git ")) {
    return line.replace(/\sa\/(?:base|worker)\//, " a/").replace(/\sb\/(?:base|worker)\//, " b/");
  }
  if (line.startsWith("--- a/")) {
    return line.replace(/^--- a\/(?:base|worker)\//, "--- a/");
  }
  if (line.startsWith("+++ b/")) {
    return line.replace(/^\+\+\+ b\/(?:base|worker)\//, "+++ b/");
  }
  if (line.startsWith("Binary files ")) {
    return line.replace(/^Binary files a\/(?:base|worker)\//, "Binary files a/").replace(/\sb\/(?:base|worker)\//, " b/");
  }
  return line;
}
function sanitizeWorkerPatch(rawPatch) {
  if (!rawPatch.trim()) {
    return "";
  }
  return rawPatch.split(/\r?\n/).map((line) => sanitizePatchLine(line)).join("\n").replace(/\n+$/, "\n");
}
function normalizePatchPath(rawPath) {
  const withoutTimestamp = rawPath.split("	")[0].trim();
  if (!withoutTimestamp || withoutTimestamp === "/dev/null") {
    return void 0;
  }
  let normalized = withoutTimestamp;
  if (normalized.startsWith("a/") || normalized.startsWith("b/")) {
    normalized = normalized.slice(2);
  }
  normalized = path3.normalize(normalized);
  if (!normalized || normalized === "." || path3.isAbsolute(normalized)) {
    return void 0;
  }
  return normalized;
}
function extractPatchFiles(patch) {
  const files = /* @__PURE__ */ new Set();
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
async function generateWorkerPatch(snapshot, toolContext) {
  await prunePatchIgnoredPaths(snapshot.baseDir);
  await prunePatchIgnoredPaths(snapshot.workerDir);
  const patchFile = path3.join(snapshot.bundleDir, "worker.patch");
  const result = await runProcess2(
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
  const rawPatch = await fs3.readFile(patchFile, "utf8").catch(() => "");
  const sanitized = sanitizeWorkerPatch(rawPatch);
  const patchBytes = Buffer.byteLength(sanitized, "utf8");
  if (patchBytes > 9e5) {
    throw new Error(
      `worker patch too large (${patchBytes} bytes). likely generated artifacts/dependencies; narrow scope or avoid install/build output`
    );
  }
  return sanitized;
}
var SubagentManager = class {
  agent;
  getBaseState;
  toolContext;
  maxConcurrent;
  onEvent;
  runs = /* @__PURE__ */ new Map();
  queue = [];
  activeCount = 0;
  mergeInProgress = false;
  nextSequence = 1;
  constructor(options) {
    this.agent = options.agent;
    this.getBaseState = options.getBaseState;
    this.toolContext = options.toolContext;
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 4);
    this.onEvent = options.onEvent;
  }
  listRuns() {
    return [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }
  getRun(id) {
    return this.runs.get(id);
  }
  getProgressEntries(now = Date.now()) {
    const entries = [];
    for (const run2 of [...this.runs.values()].sort((a, b) => a.sequence - b.sequence)) {
      if (run2.status === "queued") {
        entries.push({
          id: run2.id,
          label: run2.label,
          phase: "queued",
          action: run2.currentAction ?? "waiting to start",
          elapsedMs: Math.max(0, now - run2.createdAt)
        });
        continue;
      }
      if (run2.status === "running") {
        entries.push({
          id: run2.id,
          label: run2.label,
          phase: "running",
          action: run2.currentAction ?? "working",
          elapsedMs: Math.max(0, now - (run2.startedAt ?? run2.createdAt))
        });
        continue;
      }
      if (run2.status === "completed" && run2.mergeStatus === "pending") {
        entries.push({
          id: run2.id,
          label: run2.label,
          phase: "pending-merge",
          action: run2.currentAction ?? "waiting to merge",
          elapsedMs: Math.max(0, now - (run2.startedAt ?? run2.createdAt))
        });
      }
    }
    return entries;
  }
  getStatusOverview() {
    const summary = {
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      mergePending: 0,
      mergeApplied: 0,
      mergeConflict: 0,
      mergeSkipped: 0
    };
    for (const run2 of this.runs.values()) {
      if (run2.status === "queued") {
        summary.queued += 1;
      } else if (run2.status === "running") {
        summary.running += 1;
      } else if (run2.status === "completed") {
        summary.completed += 1;
      } else if (run2.status === "failed") {
        summary.failed += 1;
      }
      if (run2.mergeStatus === "pending") {
        summary.mergePending += 1;
      } else if (run2.mergeStatus === "applied") {
        summary.mergeApplied += 1;
      } else if (run2.mergeStatus === "conflict") {
        summary.mergeConflict += 1;
      } else if (run2.mergeStatus === "skipped") {
        summary.mergeSkipped += 1;
      }
    }
    return summary;
  }
  clearFinished() {
    let removed = 0;
    for (const [id, run2] of this.runs.entries()) {
      if (run2.status === "completed" || run2.status === "failed") {
        this.runs.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
  async waitForIdle() {
    while (this.activeCount > 0 || this.queue.length > 0 || this.mergeInProgress) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  spawn(params) {
    const base = this.getBaseState();
    const scope = (params.scope ?? []).map((item) => normalizeScopePath(item)).filter((item) => Boolean(item)).slice(0, 12);
    const dependsOn = (params.dependsOn ?? []).map((item) => item.trim()).filter(Boolean);
    const run2 = {
      id: crypto.randomUUID().slice(0, 8),
      sequence: this.nextSequence++,
      label: params.label?.trim() || "worker",
      task: params.task.trim(),
      scope: scope.length > 0 ? scope : void 0,
      dependsOn: dependsOn.length > 0 ? dependsOn : void 0,
      status: "queued",
      currentAction: "waiting to start",
      lastActivityAt: Date.now(),
      model: params.model?.trim() || base.model,
      createdAt: Date.now(),
      logs: []
    };
    this.runs.set(run2.id, run2);
    this.queue.push(run2.id);
    this.emit({ type: "queued", run: run2 });
    if (!params.deferPump) {
      this.pump();
    }
    return run2;
  }
  spawnPlanned(tasks, model) {
    const labelToId = /* @__PURE__ */ new Map();
    const created = tasks.map((task, index) => {
      const safeLabel = task.label?.trim() || `worker-${index + 1}`;
      const run2 = this.spawn({
        task: task.task,
        label: safeLabel,
        model,
        scope: task.scope,
        deferPump: true
      });
      labelToId.set(safeLabel, run2.id);
      return run2;
    });
    for (let index = 0; index < created.length; index += 1) {
      const run2 = created[index];
      const task = tasks[index];
      const deps = (task.depends_on ?? []).map((label) => labelToId.get(label.trim())).filter((id) => Boolean(id) && id !== run2.id);
      run2.dependsOn = deps.length > 0 ? deps : void 0;
    }
    this.pump();
    return created;
  }
  emit(event) {
    this.onEvent?.(event);
  }
  pruneQueue() {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const runId = this.queue[index];
      const run2 = this.runs.get(runId);
      if (!run2 || run2.status !== "queued") {
        this.queue.splice(index, 1);
      }
    }
  }
  pump() {
    this.pruneQueue();
    this.resolveBlockedQueuedRuns();
    this.pruneQueue();
    while (this.activeCount < this.maxConcurrent) {
      const run2 = this.takeNextRunnableRun();
      if (!run2) {
        break;
      }
      this.activeCount += 1;
      void this.executeRun(run2).finally(() => {
        this.activeCount -= 1;
        this.pump();
      });
    }
  }
  resolveBlockedQueuedRuns() {
    for (const runId of this.queue) {
      const run2 = this.runs.get(runId);
      if (!run2 || run2.status !== "queued" || !run2.dependsOn?.length) {
        continue;
      }
      const blockingDeps = run2.dependsOn.map((id) => this.runs.get(id)).filter((dep) => Boolean(dep)).filter((dep) => dep.status === "failed" || dep.mergeStatus === "conflict").map((dep) => `${dep.id}:${dep.label}`);
      if (blockingDeps.length === 0) {
        continue;
      }
      run2.status = "failed";
      run2.error = "Blocked by failed dependency";
      run2.blockedBy = blockingDeps;
      run2.endedAt = Date.now();
      run2.lastActivityAt = Date.now();
      run2.currentAction = "blocked by failed dependency";
      this.emit({ type: "failed", run: run2 });
    }
  }
  takeNextRunnableRun() {
    const busyRuns = [...this.runs.values()].filter(
      (run2) => run2.status === "running" || run2.status === "completed" && run2.mergeStatus === "pending"
    );
    for (let index = 0; index < this.queue.length; index += 1) {
      const runId = this.queue[index];
      const run2 = this.runs.get(runId);
      if (!run2 || run2.status !== "queued") {
        continue;
      }
      const depsPending = run2.dependsOn?.some((depId) => {
        const dep = this.runs.get(depId);
        if (!dep) {
          return true;
        }
        return dep.status !== "completed" || dep.mergeStatus === "pending";
      }) ?? false;
      if (depsPending) {
        run2.currentAction = "waiting for dependencies";
        continue;
      }
      const hasScopeContention = busyRuns.some((busyRun) => scopesOverlap(run2.scope, busyRun.scope));
      if (hasScopeContention) {
        run2.currentAction = "waiting for scope lock";
        continue;
      }
      this.queue.splice(index, 1);
      return run2;
    }
    return void 0;
  }
  async executeRun(run2) {
    run2.status = "running";
    run2.startedAt = Date.now();
    run2.lastActivityAt = Date.now();
    run2.currentAction = "preparing isolated workspace";
    this.emit({ type: "started", run: run2 });
    const base = this.getBaseState();
    let snapshot;
    try {
      snapshot = await prepareWorkerSnapshot(this.toolContext.workspaceCwd);
      const workerToolContext = {
        ...this.toolContext,
        workspaceCwd: snapshot.workerDir
      };
      const workerAgent = this.agent.forkWithToolContext(workerToolContext);
      const workerState = {
        model: run2.model,
        previousResponseId: void 0,
        enableTools: base.enableTools,
        systemPromptOverride: [
          base.systemPromptOverride?.trim(),
          "You are a spawned worker subagent.",
          `Worker label: ${run2.label}`,
          "You are operating inside an isolated workspace snapshot.",
          "Do not install dependencies, run package managers, or create build artifacts unless explicitly required by the task.",
          run2.scope?.length ? `Allowed write scope: ${run2.scope.join(", ")}. Do not modify files outside this scope.` : void 0,
          "If the task requests creating or editing files, you must actually make those file changes before finishing.",
          "Make file changes only for the assigned task and keep the scope tight.",
          "Return a concise summary of what changed and what remains."
        ].filter(Boolean).join("\n")
      };
      const result = await workerAgent.run(
        run2.task,
        workerState,
        {
          onToolCallStart: (call) => {
            run2.logs.push(`tool> ${call.name} ${call.arguments}`);
            run2.lastActivityAt = Date.now();
            run2.currentAction = summarizeToolCall(call);
            this.emit({ type: "tool_start", run: run2, call });
          },
          onToolCallResult: (call, toolResult) => {
            run2.logs.push(`tool< ${call.name} ${summarizeToolResult(toolResult)}`);
            run2.lastActivityAt = Date.now();
            run2.currentAction = toolResult.ok ? `thinking after ${call.name}` : `recovering from ${call.name}`;
            this.emit({ type: "tool_result", run: run2, call, result: toolResult });
          }
        },
        { maxToolRounds: 40 }
      );
      run2.status = "completed";
      run2.endedAt = Date.now();
      run2.output = result.text;
      run2.responseId = result.responseId;
      run2.lastActivityAt = Date.now();
      let patch = await generateWorkerPatch(snapshot, this.toolContext);
      run2.patch = patch || void 0;
      run2.patchFiles = patch ? extractPatchFiles(patch) : [];
      if (!patch && runLikelyRequiresFileChanges(run2)) {
        throw new Error(
          `task appears to require file edits but worker produced no changes (scope: ${run2.scope?.join(", ") ?? "(none)"})`
        );
      }
      run2.mergeStatus = patch ? "pending" : "skipped";
      run2.currentAction = patch ? "waiting to merge" : "completed";
      this.emit({ type: "completed", run: run2 });
    } catch (error) {
      run2.status = "failed";
      run2.endedAt = Date.now();
      run2.error = error instanceof Error ? error.message : String(error);
      run2.lastActivityAt = Date.now();
      run2.currentAction = "failed";
      this.emit({ type: "failed", run: run2 });
    } finally {
      if (snapshot) {
        await fs3.rm(snapshot.bundleDir, { recursive: true, force: true });
      }
      await this.maybeMergeReadyRuns();
    }
  }
  async maybeMergeReadyRuns() {
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
  findNextMergeCandidate() {
    const runs = [...this.runs.values()].sort((a, b) => a.sequence - b.sequence);
    for (const run2 of runs) {
      if (run2.status !== "completed" || run2.mergeStatus !== "pending" || !run2.patch) {
        continue;
      }
      const blocked = runs.some(
        (candidate) => candidate.sequence < run2.sequence && (candidate.status === "queued" || candidate.status === "running")
      );
      if (!blocked) {
        return run2;
      }
      break;
    }
    return void 0;
  }
  async mergeRun(run2) {
    run2.lastActivityAt = Date.now();
    run2.currentAction = "applying patch";
    this.emit({ type: "merge_started", run: run2 });
    try {
      const outOfScope = (run2.patchFiles ?? []).filter((file) => !isPathCoveredByScopes(file, run2.scope));
      if (outOfScope.length > 0) {
        throw new Error(
          `scope violation: worker touched files outside scope (${outOfScope.join(", ")}); declared scope: ${run2.scope?.join(", ") ?? "(none)"}`
        );
      }
      await applyUnifiedPatch(run2.patch ?? "", this.toolContext, false);
      run2.mergeStatus = "applied";
      run2.lastActivityAt = Date.now();
      run2.currentAction = "merged";
      this.emit({ type: "merged", run: run2 });
    } catch (error) {
      run2.mergeStatus = "conflict";
      run2.mergeError = error instanceof Error ? error.message : String(error);
      run2.lastActivityAt = Date.now();
      run2.currentAction = "merge conflict";
      this.emit({ type: "merge_failed", run: run2 });
    }
  }
};

// src/ui.ts
import * as readline2 from "readline";
import process4 from "process";
var COLORS = {
  muted: "\x1B[2m",
  accent: "\x1B[96m",
  ok: "\x1B[92m",
  warn: "\x1B[93m",
  error: "\x1B[91m",
  title: "\x1B[95m",
  text: "\x1B[97m"
};
var RESET2 = "\x1B[0m";
var BOLD2 = "\x1B[1m";
var ITALIC = "\x1B[3m";
function canColor() {
  return Boolean(process4.stdout.isTTY) && process4.env.NO_COLOR === void 0;
}
function paint(text, tone) {
  if (!canColor()) {
    return text;
  }
  return `${COLORS[tone]}${text}${RESET2}`;
}
function truncate3(input, max = 180) {
  if (input.length <= max) {
    return input;
  }
  return `${input.slice(0, max)} \u2026[${input.length - max} more chars]`;
}
function compactArguments(raw) {
  const text = raw.trim();
  if (!text) {
    return "{}";
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      return truncate3(text);
    }
    const compacted = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        compacted[key] = value.length > 80 ? `<string ${value.length} chars>` : value;
        continue;
      }
      compacted[key] = value;
    }
    return truncate3(JSON.stringify(compacted));
  } catch {
    return truncate3(text.replace(/\s+/g, " "));
  }
}
function formatPrompt() {
  return `${paint("groking", "accent")}${paint(">", "title")} `;
}
function formatToolStart(name, argsRaw) {
  return `${paint("tool>", "title")} ${paint(name, "text")} ${paint(compactArguments(argsRaw), "muted")}`;
}
function formatToolResult(name, summary) {
  return `${paint("tool<", "title")} ${paint(name, "text")} ${paint(truncate3(summary, 220), "muted")}`;
}
function formatError(message) {
  return `${paint("error:", "error")} ${message}`;
}
function stylizeInlineMarkdown(line) {
  if (!canColor()) {
    return line;
  }
  const codeSegments = [];
  let transformed = line.replace(/`([^`]+)`/g, (_, code) => {
    const token = `@@CODE_${codeSegments.length}@@`;
    codeSegments.push(code);
    return token;
  });
  transformed = transformed.replace(/\*\*(.+?)\*\*/g, (_, boldText) => {
    return `${BOLD2}${boldText}${RESET2}${COLORS.text}`;
  });
  transformed = transformed.replace(/(^|[^*])\*(?!\*)([^*]+)\*(?!\*)/g, (_, prefix, italicText) => {
    return `${prefix}${ITALIC}${italicText}${RESET2}${COLORS.text}`;
  });
  transformed = transformed.replace(/@@CODE_(\d+)@@/g, (_, idx) => {
    const code = codeSegments[Number(idx)] ?? "";
    return `\x1B[38;5;229m\x1B[48;5;238m ${code} ${RESET2}${COLORS.text}`;
  });
  return transformed;
}
function renderAssistantBody(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let inCodeBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      const label = trimmed.replace(/```/, "").trim();
      if (inCodeBlock) {
        out.push(paint(`\u250C\u2500 code${label ? ` (${label})` : ""}`, "muted"));
      } else {
        out.push(paint("\u2514\u2500 end code", "muted"));
      }
      continue;
    }
    if (inCodeBlock) {
      out.push(canColor() ? `\x1B[38;5;120m${line}${RESET2}` : line);
      continue;
    }
    if (/^#{1,6}\s+/.test(trimmed)) {
      const heading = trimmed.replace(/^#{1,6}\s+/, "");
      out.push(canColor() ? `${BOLD2}${paint(heading, "title")}${RESET2}` : heading);
      continue;
    }
    if (/^[-*]\s+/.test(trimmed)) {
      const item = trimmed.replace(/^[-*]\s+/, "");
      const styled2 = stylizeInlineMarkdown(item);
      out.push(canColor() ? `${COLORS.text}\u2022 ${styled2}${RESET2}` : `\u2022 ${item}`);
      continue;
    }
    if (/^\d+\.\s+/.test(trimmed)) {
      const styled2 = stylizeInlineMarkdown(trimmed);
      out.push(canColor() ? `${COLORS.text}${styled2}${RESET2}` : trimmed);
      continue;
    }
    const styled = stylizeInlineMarkdown(line);
    out.push(canColor() ? `${COLORS.text}${styled}${RESET2}` : styled);
  }
  return out.join("\n");
}
function printAssistantText(text) {
  const header = paint("assistant", "accent");
  const body = renderAssistantBody(text);
  process4.stdout.write(`
${header}
${body}

`);
}
var Spinner = class {
  frames = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
  timer;
  index = 0;
  text = "Thinking...";
  active = false;
  printedFallback = false;
  start(text) {
    if (text) {
      this.text = text;
    }
    if (!process4.stdout.isTTY) {
      if (!this.printedFallback) {
        console.log(this.text);
        this.printedFallback = true;
      }
      return;
    }
    if (this.active) {
      return;
    }
    this.active = true;
    this.render();
    this.timer = setInterval(() => {
      this.index = (this.index + 1) % this.frames.length;
      this.render();
    }, 90);
  }
  setText(text) {
    this.text = text;
    if (this.active) {
      this.render();
    }
  }
  log(line) {
    if (!process4.stdout.isTTY || !this.active) {
      console.log(line);
      return;
    }
    this.clearLine();
    console.log(line);
    this.render();
  }
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = void 0;
    }
    if (process4.stdout.isTTY && this.active) {
      this.clearLine();
    }
    this.active = false;
    this.printedFallback = false;
  }
  render() {
    if (!process4.stdout.isTTY || !this.active) {
      return;
    }
    const frame = this.frames[this.index];
    const text = `${paint(frame, "title")} ${paint(this.text, "muted")}`;
    process4.stdout.write(`\r${text}`);
  }
  clearLine() {
    readline2.clearLine(process4.stdout, 0);
    readline2.cursorTo(process4.stdout, 0);
  }
};

// src/repl.ts
function printHelp() {
  console.log("Commands:");
  console.log("  /help              Show this help");
  console.log("  /reset             Clear server-side conversation link for this local session");
  console.log("  /model             Show current model");
  console.log("  /model <name>      Change model for next turns");
  console.log("  /planner           Show current planner model");
  console.log("  /planner <name>    Change planner model used by /agents run");
  console.log("  /models            List available models from API");
  console.log("  /agents help       Show subagent commands");
  console.log("  /agents run <goal> Planner splits goal and spawns workers");
  console.log("  /agents spawn <task> Spawn one worker subagent");
  console.log("  /agents status     Show live worker/merge summary");
  console.log("  /agents list       List worker runs");
  console.log("  /agents result <id> Show one worker result");
  console.log("  /agents log <id>   Show one worker tool log");
  console.log("  /agents wait       Wait until workers are done");
  console.log("  /agents clear      Remove completed/failed runs from list");
  console.log("  /tools on|off      Enable or disable local tool access");
  console.log("  /exit              Exit REPL");
}
function printAgentsHelp() {
  console.log("Subagent commands:");
  console.log("  /agents run <goal>");
  console.log("  /agents spawn <task>");
  console.log("  /agents status");
  console.log("  /agents list");
  console.log("  /agents result <id>");
  console.log("  /agents log <id>");
  console.log("  /agents wait");
  console.log("  /agents clear");
}
function truncateForStatus(text, max = 220) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}\u2026`;
}
function formatElapsedShort(ms) {
  const seconds = Math.max(0, Math.round(ms / 1e3));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m${remaining}s`;
}
function printRunSummary(runId, summary) {
  if (!summary) {
    return;
  }
  console.log(`  ${runId}: ${summary}`);
}
function isTerminalRunStatus(status) {
  return status === "completed" || status === "failed";
}
function stripAnsi(input) {
  return input.replace(/\x1b\[[0-9;]*m/g, "");
}
function printLiveNotice(rl, prompt, message, awaitingInput) {
  if (!awaitingInput || !process5.stdout.isTTY) {
    console.log(message);
    return;
  }
  const line = typeof rl.line === "string" ? rl.line : "";
  const cursor = typeof rl.cursor === "number" ? rl.cursor : line.length;
  const visiblePromptLength = stripAnsi(prompt).length;
  nodeReadline.clearLine(process5.stdout, 0);
  nodeReadline.cursorTo(process5.stdout, 0);
  process5.stdout.write(`${message}
`);
  process5.stdout.write(prompt);
  process5.stdout.write(line);
  nodeReadline.cursorTo(process5.stdout, visiblePromptLength + cursor);
}
async function startRepl(options) {
  const rl = readline3.createInterface({
    input: process5.stdin,
    output: process5.stdout,
    terminal: true
  });
  printHelp();
  let awaitingInput = false;
  const promptText = formatPrompt();
  const heartbeatFrames = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
  let heartbeatIndex = 0;
  let lastHeartbeatAt = 0;
  const trackedRunIds = /* @__PURE__ */ new Set();
  const notificationTimer = setInterval(() => {
    const pending = options.pullNotifications?.() ?? [];
    if (pending.length === 0) {
      const progress = options.subagents.getProgressEntries();
      if (progress.length === 0) {
        return;
      }
      const now = Date.now();
      if (now - lastHeartbeatAt < 1800) {
        return;
      }
      heartbeatIndex = (heartbeatIndex + 1) % heartbeatFrames.length;
      lastHeartbeatAt = now;
      const details = progress.slice(0, 3).map((entry) => `${entry.id} ${entry.label} [${entry.phase}] ${entry.action} (${formatElapsedShort(entry.elapsedMs)})`).join(" | ");
      const suffix = progress.length > 3 ? ` | +${progress.length - 3} more` : "";
      printLiveNotice(
        rl,
        promptText,
        truncateForStatus(`status> ${heartbeatFrames[heartbeatIndex]} ${details}${suffix}`),
        awaitingInput
      );
      return;
    }
    for (const note of pending) {
      lastHeartbeatAt = Date.now();
      printLiveNotice(rl, promptText, note, awaitingInput);
    }
    if (trackedRunIds.size === 0) {
      return;
    }
    const trackedRuns = [...trackedRunIds].map((id) => options.subagents.getRun(id)).filter((run2) => Boolean(run2));
    if (trackedRuns.length === 0) {
      trackedRunIds.clear();
      return;
    }
    const allTerminal = trackedRuns.every((run2) => isTerminalRunStatus(run2.status));
    if (!allTerminal) {
      return;
    }
    const completed = trackedRuns.filter((run2) => run2.status === "completed").length;
    const failed = trackedRuns.filter((run2) => run2.status === "failed").length;
    const mergeApplied = trackedRuns.filter((run2) => run2.mergeStatus === "applied").length;
    const mergeConflict = trackedRuns.filter((run2) => run2.mergeStatus === "conflict").length;
    const mergeSkipped = trackedRuns.filter((run2) => run2.mergeStatus === "skipped").length;
    const changedFiles = [...new Set(trackedRuns.flatMap((run2) => run2.patchFiles ?? []))];
    const openHint = changedFiles[0];
    printLiveNotice(
      rl,
      promptText,
      `agents> batch complete: completed=${completed} failed=${failed} merged=${mergeApplied} conflicts=${mergeConflict} skipped=${mergeSkipped}`,
      awaitingInput
    );
    if (changedFiles.length > 0) {
      const preview = changedFiles.slice(0, 4).join(", ");
      const suffix = changedFiles.length > 4 ? ` +${changedFiles.length - 4} more` : "";
      printLiveNotice(rl, promptText, `agents> changed files: ${preview}${suffix}`, awaitingInput);
    }
    if (openHint) {
      printLiveNotice(rl, promptText, `agents> open first: ${openHint}`, awaitingInput);
    }
    trackedRunIds.clear();
  }, 160);
  notificationTimer.unref?.();
  while (true) {
    awaitingInput = true;
    const raw = await rl.question(promptText);
    awaitingInput = false;
    const input = raw.trim();
    if (!input) {
      continue;
    }
    if (input === "/exit" || input === "/quit") {
      break;
    }
    if (input === "/help") {
      printHelp();
      continue;
    }
    if (input === "/reset") {
      options.state.previousResponseId = void 0;
      await options.onReset();
      console.log("Session reset.");
      continue;
    }
    if (input === "/model") {
      console.log(`Current model: ${options.state.model}`);
      console.log("Usage: /model <name>");
      continue;
    }
    if (input.startsWith("/model ")) {
      const model = input.replace("/model", "").trim();
      if (!model) {
        console.log("Usage: /model <name>");
      } else {
        options.state.model = model;
        console.log(`Model set to ${model}`);
      }
      continue;
    }
    if (input === "/planner") {
      console.log(`Current planner model: ${options.state.plannerModel ?? options.state.model}`);
      console.log("Usage: /planner <name>");
      continue;
    }
    if (input.startsWith("/planner ")) {
      const model = input.replace("/planner", "").trim();
      if (!model) {
        console.log("Usage: /planner <name>");
      } else {
        options.state.plannerModel = model;
        console.log(`Planner model set to ${model}`);
      }
      continue;
    }
    if (input === "/models") {
      const spinner2 = new Spinner();
      try {
        spinner2.start("Fetching models...");
        const models = await options.agent.listModels();
        spinner2.stop();
        if (models.length === 0) {
          console.log("No models returned by API.");
        } else {
          console.log("Available models:");
          for (const model of models) {
            const active = model.id === options.state.model ? " (current)" : "";
            console.log(`  - ${model.id}${active}`);
          }
        }
      } catch (error) {
        spinner2.stop();
        const message = error instanceof Error ? error.message : String(error);
        console.error(formatError(`Failed to list models: ${message}`));
      }
      continue;
    }
    if (input.startsWith("/tools ")) {
      const value = input.replace("/tools", "").trim().toLowerCase();
      if (value !== "on" && value !== "off") {
        console.log("Usage: /tools on|off");
      } else {
        options.state.enableTools = value === "on";
        console.log(`Tools ${options.state.enableTools ? "enabled" : "disabled"}`);
      }
      continue;
    }
    if (input === "/agents" || input === "/agents help") {
      printAgentsHelp();
      continue;
    }
    if (input.startsWith("/agents ")) {
      const command = input.slice("/agents ".length).trim();
      if (command === "list") {
        const runs = options.subagents.listRuns();
        if (runs.length === 0) {
          console.log("No subagent runs yet.");
          continue;
        }
        console.log("Subagent runs:");
        for (const run2 of runs) {
          const duration = typeof run2.startedAt === "number" && typeof run2.endedAt === "number" ? ` (${Math.max(0, run2.endedAt - run2.startedAt)}ms)` : "";
          const merge = run2.status === "completed" ? ` merge=${run2.mergeStatus ?? "n/a"}` : "";
          const action = run2.currentAction && (run2.status === "running" || run2.status === "queued" || run2.mergeStatus === "pending") ? ` action=${run2.currentAction}` : "";
          const scope = run2.scope?.length ? ` scope=${run2.scope.join(",")}` : "";
          const deps = run2.dependsOn?.length ? ` depends_on=${run2.dependsOn.join(",")}` : "";
          console.log(`  - ${run2.id} [${run2.status}] ${run2.label}${duration}${merge}${action}${scope}${deps}`);
        }
        continue;
      }
      if (command === "status") {
        const overview = options.subagents.getStatusOverview();
        console.log(
          `Workers: queued=${overview.queued} running=${overview.running} completed=${overview.completed} failed=${overview.failed}`
        );
        console.log(
          `Merge: pending=${overview.mergePending} applied=${overview.mergeApplied} conflict=${overview.mergeConflict} skipped=${overview.mergeSkipped}`
        );
        const progress = options.subagents.getProgressEntries();
        if (progress.length > 0) {
          console.log("Live progress:");
          for (const entry of progress.slice(0, 8)) {
            console.log(
              `  - ${entry.id} ${entry.label} [${entry.phase}] ${entry.action} (${formatElapsedShort(entry.elapsedMs)})`
            );
          }
        }
        const latestCompleted = options.subagents.listRuns().filter((run2) => run2.status === "completed" || run2.status === "failed").sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).slice(0, 5);
        if (latestCompleted.length > 0) {
          console.log("Recent outcomes:");
          for (const run2 of latestCompleted) {
            const summary = describeSubagentRun(run2) || "(no summary)";
            console.log(`  - ${run2.id} [${run2.status}] ${run2.label}: ${summary}`);
          }
        }
        continue;
      }
      if (command.startsWith("spawn ")) {
        const task = command.slice("spawn ".length).trim();
        if (!task) {
          console.log("Usage: /agents spawn <task>");
          continue;
        }
        const run2 = options.subagents.spawn({ task, label: "worker" });
        trackedRunIds.add(run2.id);
        console.log(`Spawned subagent ${run2.id} [queued]`);
        continue;
      }
      if (command === "spawn") {
        console.log("Usage: /agents spawn <task>");
        continue;
      }
      if (command.startsWith("run ")) {
        const goal = command.slice("run ".length).trim();
        if (!goal) {
          console.log("Usage: /agents run <goal>");
          continue;
        }
        const spinner2 = new Spinner();
        try {
          const plannerModel = options.state.plannerModel ?? options.state.model;
          spinner2.start(`Planning worker tasks with ${plannerModel}...`);
          const plan = await options.agent.planSubtasks(goal, options.state, plannerModel);
          spinner2.stop();
          const runs = options.subagents.spawnPlanned(plan);
          for (const run2 of runs) {
            trackedRunIds.add(run2.id);
          }
          console.log(`Spawned ${runs.length} subagents from planner:`);
          for (const run2 of runs) {
            const scope = run2.scope?.length ? ` scope=${run2.scope.join(",")}` : "";
            const deps = run2.dependsOn?.length ? ` depends_on=${run2.dependsOn.join(",")}` : "";
            console.log(`  - ${run2.id} [${run2.status}] ${run2.label}${scope}${deps}`);
          }
        } catch (error) {
          spinner2.stop();
          const message = error instanceof Error ? error.message : String(error);
          console.error(formatError(`Failed to run planner: ${message}`));
        }
        continue;
      }
      if (command === "run") {
        console.log("Usage: /agents run <goal>");
        continue;
      }
      if (command === "wait") {
        const spinner2 = new Spinner();
        try {
          spinner2.start("Waiting for subagents...");
          await options.subagents.waitForIdle();
          spinner2.stop();
          console.log("All subagents are idle.");
          const finishedRuns = options.subagents.listRuns().filter((run2) => run2.status === "completed" || run2.status === "failed").sort((a, b) => a.sequence - b.sequence);
          if (finishedRuns.length > 0) {
            console.log("Run summary:");
            for (const run2 of finishedRuns) {
              printRunSummary(run2.id, describeSubagentRun(run2));
            }
          }
        } catch (error) {
          spinner2.stop();
          const message = error instanceof Error ? error.message : String(error);
          console.error(formatError(`Failed while waiting: ${message}`));
        }
        continue;
      }
      if (command === "clear") {
        const removed = options.subagents.clearFinished();
        console.log(`Cleared ${removed} finished run(s).`);
        continue;
      }
      if (command.startsWith("result ")) {
        const id = command.slice("result ".length).trim();
        if (!id) {
          console.log("Usage: /agents result <id>");
          continue;
        }
        const run2 = options.subagents.getRun(id);
        if (!run2) {
          console.log(`Unknown subagent id: ${id}`);
          continue;
        }
        console.log(`Subagent ${run2.id} [${run2.status}] ${run2.label}`);
        if (run2.mergeStatus) {
          console.log(`Merge: ${run2.mergeStatus}`);
        }
        if (run2.error) {
          console.log(`Error: ${run2.error}`);
        }
        if (run2.mergeError) {
          console.log(`Merge error: ${run2.mergeError}`);
        }
        if (run2.patchFiles?.length) {
          console.log(`Patch files: ${run2.patchFiles.join(", ")}`);
        }
        const summary = describeSubagentRun(run2);
        if (summary) {
          console.log(`Summary: ${summary}`);
        }
        if (run2.output) {
          printAssistantText(run2.output);
        } else {
          console.log("(no output yet)");
        }
        continue;
      }
      if (command === "result") {
        console.log("Usage: /agents result <id>");
        continue;
      }
      if (command.startsWith("log ")) {
        const id = command.slice("log ".length).trim();
        if (!id) {
          console.log("Usage: /agents log <id>");
          continue;
        }
        const run2 = options.subagents.getRun(id);
        if (!run2) {
          console.log(`Unknown subagent id: ${id}`);
          continue;
        }
        if (run2.logs.length === 0) {
          console.log("No logs recorded for this subagent.");
          continue;
        }
        console.log(`Logs for ${run2.id} (${run2.label}):`);
        for (const line of run2.logs) {
          console.log(`  ${line}`);
        }
        continue;
      }
      printAgentsHelp();
      continue;
    }
    const activeWorkers = options.subagents.getProgressEntries();
    if (activeWorkers.length > 0 && /\b(status|progress|done|update|what happened|what was done)\b/i.test(input)) {
      console.log("Subagents are still active. Use `/agents status` for live progress or `/agents wait` for final summary.");
      continue;
    }
    const spinner = new Spinner();
    try {
      spinner.start("Thinking...");
      const result = await options.agent.run(input, options.state, {
        onToolCallStart: (call) => {
          spinner.log(formatToolStart(call.name, call.arguments));
          spinner.setText(`Running ${call.name}...`);
        },
        onToolCallResult: (call, result2) => {
          spinner.log(formatToolResult(call.name, summarizeToolResult(result2)));
          spinner.setText("Thinking...");
        }
      });
      spinner.stop();
      if (result.text) {
        printAssistantText(result.text);
      } else {
        printAssistantText("(no assistant text returned)");
      }
      options.state.previousResponseId = result.responseId;
      await options.onResponseId(result.responseId, options.state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(formatError(message));
    } finally {
      spinner.stop();
    }
  }
  clearInterval(notificationTimer);
  rl.close();
}

// src/session.ts
import crypto2 from "crypto";
import fs4 from "fs/promises";
import os4 from "os";
import path4 from "path";
var SESSION_VERSION = 1;
function defaultSessionDir() {
  return path4.join(os4.homedir(), ".groking", "sessions");
}
function workspaceHash(workspace) {
  return crypto2.createHash("sha1").update(workspace).digest("hex").slice(0, 10);
}
function resolveSessionPath(sessionName, workspace) {
  const safeName = sessionName?.trim();
  if (safeName) {
    return path4.join(defaultSessionDir(), `${safeName}.json`);
  }
  const hash = workspaceHash(workspace);
  return path4.join(defaultSessionDir(), `workspace-${hash}.json`);
}
async function loadSession(sessionPath) {
  try {
    const raw = await fs4.readFile(sessionPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed.version !== SESSION_VERSION) {
      return void 0;
    }
    return parsed;
  } catch {
    return void 0;
  }
}
async function saveSession(sessionPath, data) {
  const payload = {
    ...data,
    version: SESSION_VERSION,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  await fs4.mkdir(path4.dirname(sessionPath), { recursive: true });
  await fs4.writeFile(sessionPath, `${JSON.stringify(payload, null, 2)}
`, "utf8");
}
async function clearSession(sessionPath) {
  try {
    await fs4.unlink(sessionPath);
    return true;
  } catch {
    return false;
  }
}

// src/cli.ts
async function readSystemOverride(options) {
  if (options.systemFile?.trim()) {
    const filePath = path5.resolve(process6.cwd(), options.systemFile);
    return await fs5.readFile(filePath, "utf8");
  }
  return options.system;
}
async function persistSession(sessionPath, sessionName, workspace, state, createdAt) {
  await saveSession(sessionPath, {
    name: sessionName,
    workspace,
    model: state.model,
    plannerModel: state.plannerModel,
    previousResponseId: state.previousResponseId,
    createdAt
  });
}
async function run() {
  printGrokingBanner();
  const program = new Command();
  program.name("groking").description("Grok terminal coding assistant powered by xAI Responses API").argument("[prompt...]", "Prompt text for one-shot mode. Leave empty for interactive mode.").option("-m, --model <model>", "Grok model to use", process6.env.GROK_MODEL ?? "grok-code-fast-1").option("--planner-model <model>", "Planner model for /agents run (defaults to --model)", process6.env.GROK_PLANNER_MODEL).option("--base-url <url>", "API base URL", process6.env.XAI_BASE_URL ?? "https://api.x.ai/v1").option("--session <name>", "Session name (defaults to workspace hash)").option("--system <text>", "Additional system prompt").option("--system-file <path>", "Read additional system prompt from file").option("--cwd <path>", "Workspace root for tools", process6.cwd()).option("--no-tools", "Disable local tool access").option("-p, --prompt <text>", "One-shot prompt").option("--reset", "Reset and clear local session state before starting", false).option("--allow-outside-workspace", "Allow file/shell operations outside workspace", false).option("--timeout-ms <ms>", "Default shell command timeout in ms", (v) => Number(v), 12e4).option("--max-file-bytes <bytes>", "Max readable file size in bytes", (v) => Number(v), 2e6).option("--max-output-chars <chars>", "Max captured stdout/stderr chars", (v) => Number(v), 4e4).showHelpAfterError();
  program.parse(process6.argv);
  const promptArgs = program.args ?? [];
  const options = program.opts();
  const apiKey = await resolveApiKeyInteractive();
  const workspace = path5.resolve(options.cwd);
  const sessionPath = resolveSessionPath(options.session, workspace);
  const sessionName = options.session ?? path5.basename(sessionPath, ".json");
  if (options.reset) {
    await clearSession(sessionPath);
  }
  const existingSession = await loadSession(sessionPath);
  const createdAt = existingSession?.createdAt ?? (/* @__PURE__ */ new Date()).toISOString();
  const state = {
    model: options.model,
    plannerModel: options.plannerModel?.trim() || existingSession?.plannerModel?.trim() || options.model,
    previousResponseId: existingSession?.workspace === workspace ? existingSession.previousResponseId : void 0,
    systemPromptOverride: await readSystemOverride(options),
    enableTools: options.tools
  };
  const toolContext = {
    workspaceCwd: workspace,
    allowOutsideWorkspace: options.allowOutsideWorkspace,
    defaultCommandTimeoutMs: options.timeoutMs,
    maxFileBytes: options.maxFileBytes,
    maxCommandOutputChars: options.maxOutputChars
  };
  const agent = new GrokAgent({
    apiKey,
    baseURL: options.baseUrl,
    toolContext
  });
  const oneShotPrompt = options.prompt?.trim() || promptArgs.join(" ").trim();
  const subagentNotifications = [];
  const subagents = new SubagentManager({
    agent,
    toolContext,
    maxConcurrent: 4,
    getBaseState: () => ({
      ...state,
      previousResponseId: void 0
    }),
    onEvent: (event) => {
      if (event.type === "queued") {
        subagentNotifications.push(`subagent> queued ${event.run.id} ${event.run.label}`);
        return;
      }
      if (event.type === "started") {
        subagentNotifications.push(`subagent> started ${event.run.id} ${event.run.label}`);
        return;
      }
      if (event.type === "completed") {
        subagentNotifications.push(`subagent> done ${event.run.id} ${event.run.label}`);
        return;
      }
      if (event.type === "merge_started") {
        subagentNotifications.push(`subagent> merging ${event.run.id} ${event.run.label}`);
        return;
      }
      if (event.type === "merged") {
        const files = event.run.patchFiles?.length ? ` (${event.run.patchFiles.length} files)` : "";
        subagentNotifications.push(`subagent> merged ${event.run.id} ${event.run.label}${files}`);
        const detail = describeSubagentRun(event.run);
        if (detail) {
          subagentNotifications.push(`subagent> summary ${event.run.id} ${detail}`);
        }
        return;
      }
      if (event.type === "merge_failed") {
        subagentNotifications.push(
          formatError(`subagent ${event.run.id} merge failed: ${event.run.mergeError ?? "unknown error"}`)
        );
        return;
      }
      if (event.type === "failed") {
        subagentNotifications.push(
          formatError(`subagent ${event.run.id} failed: ${event.run.error ?? "unknown error"}`)
        );
        return;
      }
      if (event.type === "tool_start") {
        subagentNotifications.push(`subagent:${event.run.id} ${formatToolStart(event.call.name, event.call.arguments)}`);
        return;
      }
      if (event.type === "tool_result") {
        const summary = summarizeToolResult(event.result);
        subagentNotifications.push(`subagent:${event.run.id} ${formatToolResult(event.call.name, summary)}`);
      }
    }
  });
  const onResponseId = async (responseId, latestState) => {
    latestState.previousResponseId = responseId;
    await persistSession(sessionPath, sessionName, workspace, latestState, createdAt);
  };
  const onReset = async () => {
    state.previousResponseId = void 0;
    await persistSession(sessionPath, sessionName, workspace, state, createdAt);
  };
  if (oneShotPrompt) {
    const spinner = new Spinner();
    spinner.start("Thinking...");
    let result;
    try {
      result = await agent.run(oneShotPrompt, state, {
        onToolCallStart: (call) => {
          spinner.log(formatToolStart(call.name, call.arguments));
          spinner.setText(`Running ${call.name}...`);
        },
        onToolCallResult: (call, result2) => {
          const summary = result2.ok ? "ok" : `error: ${result2.error ?? "unknown"}`;
          spinner.log(formatToolResult(call.name, summary));
          spinner.setText("Thinking...");
        }
      });
    } finally {
      spinner.stop();
    }
    if (result.text) {
      printAssistantText(result.text);
    }
    await onResponseId(result.responseId, state);
    return;
  }
  console.log(`Workspace: ${workspace}`);
  console.log(`Model: ${state.model}`);
  console.log(`Planner model: ${state.plannerModel ?? state.model}`);
  console.log(`Session file: ${sessionPath}`);
  if (state.previousResponseId) {
    console.log("Loaded existing session context.");
  }
  await startRepl({
    agent,
    subagents,
    state,
    onResponseId,
    onReset,
    pullNotifications: () => {
      const items = [...subagentNotifications];
      subagentNotifications.length = 0;
      return items;
    }
  });
}
run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`fatal: ${message}`);
  process6.exitCode = 1;
});
