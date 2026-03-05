import crypto from "node:crypto";

import type { AgentState, GrokAgent, PlannedSubtask } from "./agent.js";
import { summarizeToolResult, type ToolCall, type ToolExecutionResult } from "./tools.js";

export type SubagentStatus = "queued" | "running" | "completed" | "failed";

export interface SubagentRunRecord {
  id: string;
  label: string;
  task: string;
  status: SubagentStatus;
  model: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  output?: string;
  error?: string;
  responseId?: string;
  logs: string[];
}

export type SubagentEvent =
  | { type: "queued"; run: SubagentRunRecord }
  | { type: "started"; run: SubagentRunRecord }
  | { type: "completed"; run: SubagentRunRecord }
  | { type: "failed"; run: SubagentRunRecord }
  | { type: "tool_start"; run: SubagentRunRecord; call: ToolCall }
  | { type: "tool_result"; run: SubagentRunRecord; call: ToolCall; result: ToolExecutionResult };

export interface SpawnSubagentParams {
  task: string;
  label?: string;
  model?: string;
}

export interface SubagentManagerOptions {
  agent: GrokAgent;
  getBaseState: () => AgentState;
  maxConcurrent?: number;
  onEvent?: (event: SubagentEvent) => void;
}

export class SubagentManager {
  private readonly agent: GrokAgent;
  private readonly getBaseState: () => AgentState;
  private readonly maxConcurrent: number;
  private readonly onEvent?: (event: SubagentEvent) => void;

  private readonly runs = new Map<string, SubagentRunRecord>();
  private readonly queue: string[] = [];
  private activeCount = 0;

  constructor(options: SubagentManagerOptions) {
    this.agent = options.agent;
    this.getBaseState = options.getBaseState;
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 1);
    this.onEvent = options.onEvent;
  }

  listRuns(): SubagentRunRecord[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  getRun(id: string): SubagentRunRecord | undefined {
    return this.runs.get(id);
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
    while (this.activeCount > 0 || this.queue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  spawn(params: SpawnSubagentParams): SubagentRunRecord {
    const base = this.getBaseState();
    const run: SubagentRunRecord = {
      id: crypto.randomUUID().slice(0, 8),
      label: params.label?.trim() || "worker",
      task: params.task.trim(),
      status: "queued",
      model: params.model?.trim() || base.model,
      createdAt: Date.now(),
      logs: []
    };

    this.runs.set(run.id, run);
    this.queue.push(run.id);
    this.emit({ type: "queued", run });
    this.pump();

    return run;
  }

  spawnPlanned(tasks: PlannedSubtask[], model?: string): SubagentRunRecord[] {
    return tasks.map((task, index) => {
      const safeLabel = task.label?.trim() || `worker-${index + 1}`;
      return this.spawn({
        task: task.task,
        label: safeLabel,
        model
      });
    });
  }

  private emit(event: SubagentEvent): void {
    this.onEvent?.(event);
  }

  private pump(): void {
    while (this.activeCount < this.maxConcurrent && this.queue.length > 0) {
      const nextId = this.queue.shift();
      if (!nextId) {
        break;
      }

      const run = this.runs.get(nextId);
      if (!run || run.status !== "queued") {
        continue;
      }

      this.activeCount += 1;
      void this.executeRun(run).finally(() => {
        this.activeCount -= 1;
        this.pump();
      });
    }
  }

  private async executeRun(run: SubagentRunRecord): Promise<void> {
    run.status = "running";
    run.startedAt = Date.now();
    this.emit({ type: "started", run });

    const base = this.getBaseState();
    const workerState: AgentState = {
      model: run.model,
      previousResponseId: undefined,
      enableTools: base.enableTools,
      systemPromptOverride: [
        base.systemPromptOverride?.trim(),
        "You are a spawned worker subagent.",
        `Worker label: ${run.label}`,
        "Execute only the assigned task and produce concise results."
      ]
        .filter(Boolean)
        .join("\n")
    };

    try {
      const result = await this.agent.run(run.task, workerState, {
        onToolCallStart: (call) => {
          run.logs.push(`tool> ${call.name} ${call.arguments}`);
          this.emit({ type: "tool_start", run, call });
        },
        onToolCallResult: (call, toolResult) => {
          run.logs.push(`tool< ${call.name} ${summarizeToolResult(toolResult)}`);
          this.emit({ type: "tool_result", run, call, result: toolResult });
        }
      });

      run.status = "completed";
      run.endedAt = Date.now();
      run.output = result.text;
      run.responseId = result.responseId;
      this.emit({ type: "completed", run });
    } catch (error) {
      run.status = "failed";
      run.endedAt = Date.now();
      run.error = error instanceof Error ? error.message : String(error);
      this.emit({ type: "failed", run });
    }
  }
}
