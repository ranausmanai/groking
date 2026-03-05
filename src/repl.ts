import readline from "node:readline/promises";
import process from "node:process";

import { GrokAgent, type AgentState } from "./agent.js";
import type { SubagentManager } from "./subagents.js";
import { summarizeToolResult } from "./tools.js";
import { Spinner, formatError, formatPrompt, formatToolResult, formatToolStart, printAssistantText } from "./ui.js";

export interface ReplOptions {
  agent: GrokAgent;
  subagents: SubagentManager;
  state: AgentState;
  onResponseId: (responseId: string, state: AgentState) => Promise<void>;
  onReset: () => Promise<void>;
}

function printHelp(): void {
  console.log("Commands:");
  console.log("  /help              Show this help");
  console.log("  /reset             Clear server-side conversation link for this local session");
  console.log("  /model             Show current model");
  console.log("  /model <name>      Change model for next turns");
  console.log("  /models            List available models from API");
  console.log("  /agents help       Show subagent commands");
  console.log("  /agents run <goal> Planner splits goal and spawns workers");
  console.log("  /agents spawn <task> Spawn one worker subagent");
  console.log("  /agents list       List worker runs");
  console.log("  /agents result <id> Show one worker result");
  console.log("  /agents wait       Wait until workers are done");
  console.log("  /agents clear      Remove completed/failed runs from list");
  console.log("  /tools on|off      Enable or disable local tool access");
  console.log("  /exit              Exit REPL");
}

function printAgentsHelp(): void {
  console.log("Subagent commands:");
  console.log("  /agents run <goal>");
  console.log("  /agents spawn <task>");
  console.log("  /agents list");
  console.log("  /agents result <id>");
  console.log("  /agents wait");
  console.log("  /agents clear");
}

export async function startRepl(options: ReplOptions): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  });

  printHelp();

  while (true) {
    const raw = await rl.question(formatPrompt());
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
          console.log(`  - ${run.id} [${run.status}] ${run.label}${duration}`);
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
        console.log(`Spawned subagent ${run.id} [queued]`);
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
          const plan = await options.agent.planSubtasks(goal, options.state);
          spinner.stop();

          const runs = options.subagents.spawnPlanned(plan);
          console.log(`Spawned ${runs.length} subagents from planner:`);
          for (const run of runs) {
            console.log(`  - ${run.id} [${run.status}] ${run.label}`);
          }
        } catch (error) {
          spinner.stop();
          const message = error instanceof Error ? error.message : String(error);
          console.error(formatError(`Failed to run planner: ${message}`));
        }
        continue;
      }

      if (command === "wait") {
        const spinner = new Spinner();
        try {
          spinner.start("Waiting for subagents...");
          await options.subagents.waitForIdle();
          spinner.stop();
          console.log("All subagents are idle.");
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
        if (run.error) {
          console.log(`Error: ${run.error}`);
        }
        if (run.output) {
          printAssistantText(run.output);
        } else {
          console.log("(no output yet)");
        }
        continue;
      }

      printAgentsHelp();
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

  rl.close();
}
