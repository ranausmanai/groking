import readline from "node:readline/promises";
import * as nodeReadline from "node:readline";
import process from "node:process";

import { GrokAgent, type AgentState } from "./agent.js";
import { describeSubagentRun, type SubagentManager } from "./subagents.js";
import { summarizeToolResult } from "./tools.js";
import { Spinner, formatError, formatPrompt, formatToolResult, formatToolStart, printAssistantText } from "./ui.js";

export interface ReplOptions {
  agent: GrokAgent;
  subagents: SubagentManager;
  state: AgentState;
  onResponseId: (responseId: string, state: AgentState) => Promise<void>;
  onReset: () => Promise<void>;
  pullNotifications?: () => string[];
}

function printHelp(): void {
  console.log("Commands:");
  console.log("  /help              Show this help");
  console.log("  /reset             Clear server-side conversation link for this local session");
  console.log("  /model             Show current model");
  console.log("  /model <name>      Change model for next turns");
  console.log("  /planner           Show current planner model");
  console.log("  /planner <name>    Change planner model used by /agents run");
  console.log("  /planner auto      Let CLI auto-pick planner model");
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

function printAgentsHelp(): void {
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

function truncateForStatus(text: string, max = 220): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function formatElapsedShort(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m${remaining}s`;
}

function printRunSummary(runId: string, summary: string | undefined): void {
  if (!summary) {
    return;
  }

  console.log(`  ${runId}: ${summary}`);
}

function isTerminalRunStatus(status: string): boolean {
  return status === "completed" || status === "failed";
}

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;]*m/g, "");
}

function printLiveNotice(rl: readline.Interface, prompt: string, message: string, awaitingInput: boolean): void {
  if (!awaitingInput || !process.stdout.isTTY) {
    console.log(message);
    return;
  }

  const line = typeof (rl as any).line === "string" ? (rl as any).line : "";
  const cursor = typeof (rl as any).cursor === "number" ? (rl as any).cursor : line.length;
  const visiblePromptLength = stripAnsi(prompt).length;

  nodeReadline.clearLine(process.stdout, 0);
  nodeReadline.cursorTo(process.stdout, 0);
  process.stdout.write(`${message}\n`);
  process.stdout.write(prompt);
  process.stdout.write(line);
  nodeReadline.cursorTo(process.stdout, visiblePromptLength + cursor);
}

export async function startRepl(options: ReplOptions): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  });

  printHelp();
  let awaitingInput = false;
  const promptText = formatPrompt();
  const heartbeatFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let heartbeatIndex = 0;
  let lastHeartbeatAt = 0;
  let lastProgressSignature = "";
  const HEARTBEAT_INTERVAL_MS = 4500;
  const trackedRunIds = new Set<string>();
  let cachedAutoPlannerModel: string | undefined;

  const pickAutoPlannerModel = async (): Promise<string> => {
    if (cachedAutoPlannerModel) {
      return cachedAutoPlannerModel;
    }

    try {
      const models = await options.agent.listModels();
      const codingModel = options.state.model;
      const preferred = models
        .map((item) => item.id)
        .filter((id) => id !== codingModel)
        .find((id) => /reason|think|deep|grok-4/i.test(id));

      cachedAutoPlannerModel = preferred ?? codingModel;
      return cachedAutoPlannerModel;
    } catch {
      cachedAutoPlannerModel = options.state.model;
      return cachedAutoPlannerModel;
    }
  };

  const notificationTimer = setInterval(() => {
    const pending = options.pullNotifications?.() ?? [];
    if (pending.length === 0) {
      const progress = options.subagents.getProgressEntries();
      if (progress.length === 0) {
        lastProgressSignature = "";
        return;
      }

      const now = Date.now();
      const signature = progress
        .slice(0, 5)
        .map((entry) => `${entry.id}:${entry.phase}:${entry.action}`)
        .join("|");
      const changed = signature !== lastProgressSignature;
      if (!changed && now - lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) {
        return;
      }
      lastProgressSignature = signature;

      heartbeatIndex = (heartbeatIndex + 1) % heartbeatFrames.length;
      lastHeartbeatAt = now;
      const details = progress
        .slice(0, 3)
        .map((entry) => `${entry.id} ${entry.label} [${entry.phase}] ${entry.action} (${formatElapsedShort(entry.elapsedMs)})`)
        .join(" | ");
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

    const trackedRuns = [...trackedRunIds]
      .map((id) => options.subagents.getRun(id))
      .filter((run): run is NonNullable<typeof run> => Boolean(run));

    if (trackedRuns.length === 0) {
      trackedRunIds.clear();
      return;
    }

    const allTerminal = trackedRuns.every((run) => isTerminalRunStatus(run.status));
    if (!allTerminal) {
      return;
    }

    const completed = trackedRuns.filter((run) => run.status === "completed").length;
    const failed = trackedRuns.filter((run) => run.status === "failed").length;
    const mergeApplied = trackedRuns.filter((run) => run.mergeStatus === "applied").length;
    const mergeConflict = trackedRuns.filter((run) => run.mergeStatus === "conflict").length;
    const mergeSkipped = trackedRuns.filter((run) => run.mergeStatus === "skipped").length;
    const changedFiles = [...new Set(trackedRuns.flatMap((run) => run.patchFiles ?? []))];
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
    lastProgressSignature = "";
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
      options.state.previousResponseId = undefined;
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
      if (options.state.plannerModel) {
        console.log(`Current planner model: ${options.state.plannerModel}`);
      } else {
        const resolved = await pickAutoPlannerModel();
        console.log(`Current planner model: auto (${resolved})`);
      }
      console.log("Usage: /planner <name>");
      continue;
    }

    if (input.startsWith("/planner ")) {
      const model = input.replace("/planner", "").trim();
      if (!model) {
        console.log("Usage: /planner <name|auto>");
      } else {
        if (model.toLowerCase() === "auto") {
          options.state.plannerModel = undefined;
          console.log("Planner model set to auto");
        } else {
          options.state.plannerModel = model;
          console.log(`Planner model set to ${model}`);
        }
      }
      continue;
    }

    if (input === "/models") {
      const spinner = new Spinner();
      try {
        spinner.start("Fetching models...");
        const models = await options.agent.listModels();
        spinner.stop();

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
        spinner.stop();
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
        for (const run of runs) {
          const duration =
            typeof run.startedAt === "number" && typeof run.endedAt === "number"
              ? ` (${Math.max(0, run.endedAt - run.startedAt)}ms)`
              : "";
          const merge =
            run.status === "completed"
              ? ` merge=${run.mergeStatus ?? "n/a"}`
              : "";
          const action =
            run.currentAction && (run.status === "running" || run.status === "queued" || run.mergeStatus === "pending")
              ? ` action=${run.currentAction}`
              : "";
          const scope = run.scope?.length ? ` scope=${run.scope.join(",")}` : "";
          const deps = run.dependsOn?.length ? ` depends_on=${run.dependsOn.join(",")}` : "";
          console.log(`  - ${run.id} [${run.status}] ${run.label}${duration}${merge}${action}${scope}${deps}`);
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

        const latestCompleted = options
          .subagents
          .listRuns()
          .filter((run) => run.status === "completed" || run.status === "failed")
          .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
          .slice(0, 5);
        if (latestCompleted.length > 0) {
          console.log("Recent outcomes:");
          for (const run of latestCompleted) {
            const summary = describeSubagentRun(run) || "(no summary)";
            console.log(`  - ${run.id} [${run.status}] ${run.label}: ${summary}`);
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

        const run = options.subagents.spawn({ task, label: "worker" });
        trackedRunIds.add(run.id);
        console.log(`Spawned subagent ${run.id} [queued]`);
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

        const spinner = new Spinner();
        try {
          spinner.start("Planning worker tasks...");
          const plannerModel = options.state.plannerModel ?? await pickAutoPlannerModel();
          spinner.setText(`Planning worker tasks with ${plannerModel}...`);
          const plan = await options.agent.planSubtasks(goal, options.state, plannerModel);
          spinner.stop();

          const runs = options.subagents.spawnPlanned(plan);
          for (const run of runs) {
            trackedRunIds.add(run.id);
          }
          console.log(`Spawned ${runs.length} subagents from planner:`);
          for (const run of runs) {
            const scope = run.scope?.length ? ` scope=${run.scope.join(",")}` : "";
            const deps = run.dependsOn?.length ? ` depends_on=${run.dependsOn.join(",")}` : "";
            console.log(`  - ${run.id} [${run.status}] ${run.label}${scope}${deps}`);
          }
          console.log("Live output is summarized. Use /agents log <id> for detailed tool stream.");
        } catch (error) {
          spinner.stop();
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
        const spinner = new Spinner();
        try {
          spinner.start("Waiting for subagents...");
          await options.subagents.waitForIdle();
          spinner.stop();
          console.log("All subagents are idle.");
          const finishedRuns = options
            .subagents
            .listRuns()
            .filter((run) => run.status === "completed" || run.status === "failed")
            .sort((a, b) => a.sequence - b.sequence);
          if (finishedRuns.length > 0) {
            console.log("Run summary:");
            for (const run of finishedRuns) {
              printRunSummary(run.id, describeSubagentRun(run));
            }
          }
        } catch (error) {
          spinner.stop();
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

        const run = options.subagents.getRun(id);
        if (!run) {
          console.log(`Unknown subagent id: ${id}`);
          continue;
        }

        console.log(`Subagent ${run.id} [${run.status}] ${run.label}`);
        if (run.mergeStatus) {
          console.log(`Merge: ${run.mergeStatus}`);
        }
        if (run.error) {
          console.log(`Error: ${run.error}`);
        }
        if (run.mergeError) {
          console.log(`Merge error: ${run.mergeError}`);
        }
        if (run.patchFiles?.length) {
          console.log(`Patch files: ${run.patchFiles.join(", ")}`);
        }
        const summary = describeSubagentRun(run);
        if (summary) {
          console.log(`Summary: ${summary}`);
        }
        if (run.output) {
          printAssistantText(run.output);
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

        const run = options.subagents.getRun(id);
        if (!run) {
          console.log(`Unknown subagent id: ${id}`);
          continue;
        }

        if (run.logs.length === 0) {
          console.log("No logs recorded for this subagent.");
          continue;
        }

        console.log(`Logs for ${run.id} (${run.label}):`);
        for (const line of run.logs) {
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
        onToolCallResult: (call, result) => {
          spinner.log(formatToolResult(call.name, summarizeToolResult(result)));
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
