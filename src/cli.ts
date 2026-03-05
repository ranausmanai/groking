#!/usr/bin/env node
import "dotenv/config";

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { Command } from "commander";

import { GrokAgent, type AgentState } from "./agent.js";
import { resolveApiKeyInteractive } from "./auth.js";
import { printGrokingBanner } from "./banner.js";
import { startRepl } from "./repl.js";
import { clearSession, loadSession, resolveSessionPath, saveSession } from "./session.js";
import { describeSubagentRun, SubagentManager } from "./subagents.js";
import { summarizeToolResult } from "./tools.js";
import { Spinner, formatError, formatToolResult, formatToolStart, printAssistantText } from "./ui.js";

interface CliOptions {
  model: string;
  baseUrl: string;
  session?: string;
  system?: string;
  systemFile?: string;
  cwd: string;
  tools: boolean;
  prompt?: string;
  reset: boolean;
  allowOutsideWorkspace: boolean;
  timeoutMs: number;
  maxFileBytes: number;
  maxOutputChars: number;
}

async function readSystemOverride(options: CliOptions): Promise<string | undefined> {
  if (options.systemFile?.trim()) {
    const filePath = path.resolve(process.cwd(), options.systemFile);
    return await fs.readFile(filePath, "utf8");
  }

  return options.system;
}

async function persistSession(
  sessionPath: string,
  sessionName: string,
  workspace: string,
  state: AgentState,
  createdAt: string
): Promise<void> {
  await saveSession(sessionPath, {
    name: sessionName,
    workspace,
    model: state.model,
    previousResponseId: state.previousResponseId,
    createdAt
  });
}

async function run(): Promise<void> {
  printGrokingBanner();

  const program = new Command();

  program
    .name("groking")
    .description("Grok terminal coding assistant powered by xAI Responses API")
    .argument("[prompt...]", "Prompt text for one-shot mode. Leave empty for interactive mode.")
    .option("-m, --model <model>", "Grok model to use", process.env.GROK_MODEL ?? "grok-code-fast-1")
    .option("--base-url <url>", "API base URL", process.env.XAI_BASE_URL ?? "https://api.x.ai/v1")
    .option("--session <name>", "Session name (defaults to workspace hash)")
    .option("--system <text>", "Additional system prompt")
    .option("--system-file <path>", "Read additional system prompt from file")
    .option("--cwd <path>", "Workspace root for tools", process.cwd())
    .option("--no-tools", "Disable local tool access")
    .option("-p, --prompt <text>", "One-shot prompt")
    .option("--reset", "Reset and clear local session state before starting", false)
    .option("--allow-outside-workspace", "Allow file/shell operations outside workspace", false)
    .option("--timeout-ms <ms>", "Default shell command timeout in ms", (v) => Number(v), 120000)
    .option("--max-file-bytes <bytes>", "Max readable file size in bytes", (v) => Number(v), 2_000_000)
    .option("--max-output-chars <chars>", "Max captured stdout/stderr chars", (v) => Number(v), 40_000)
    .showHelpAfterError();

  program.parse(process.argv);

  const promptArgs = (program.args as string[]) ?? [];
  const options = program.opts<CliOptions>();

  const apiKey = await resolveApiKeyInteractive();
  const workspace = path.resolve(options.cwd);
  const sessionPath = resolveSessionPath(options.session, workspace);
  const sessionName = options.session ?? path.basename(sessionPath, ".json");

  if (options.reset) {
    await clearSession(sessionPath);
  }

  const existingSession = await loadSession(sessionPath);
  const createdAt = existingSession?.createdAt ?? new Date().toISOString();

  const state: AgentState = {
    model: options.model,
    previousResponseId: existingSession?.workspace === workspace ? existingSession.previousResponseId : undefined,
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
  const subagentNotifications: string[] = [];
  const subagents = new SubagentManager({
    agent,
    toolContext,
    maxConcurrent: 4,
    getBaseState: () => ({
      ...state,
      previousResponseId: undefined
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

  const onResponseId = async (responseId: string, latestState: AgentState): Promise<void> => {
    latestState.previousResponseId = responseId;
    await persistSession(sessionPath, sessionName, workspace, latestState, createdAt);
  };

  const onReset = async (): Promise<void> => {
    state.previousResponseId = undefined;
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
        onToolCallResult: (call, result) => {
          const summary = result.ok ? "ok" : `error: ${result.error ?? "unknown"}`;
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
  process.exitCode = 1;
});
