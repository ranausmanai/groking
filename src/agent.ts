import OpenAI from "openai";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";

import { withUserSystemOverride } from "./prompts.js";
import { executeToolCall, type ToolCall, type ToolContext, type ToolExecutionResult, TOOL_SCHEMAS } from "./tools.js";

interface AgentHooks {
  onToolCallStart?: (call: ToolCall) => void;
  onToolCallResult?: (call: ToolCall, result: ToolExecutionResult) => void;
}

export interface AgentRunOptions {
  maxToolRounds?: number;
}

export interface AgentState {
  model: string;
  plannerModel?: string;
  previousResponseId?: string;
  systemPromptOverride?: string;
  enableTools: boolean;
}

export interface AgentConfig {
  apiKey: string;
  baseURL: string;
  toolContext: ToolContext;
}

export interface AgentRunResult {
  text: string;
  responseId: string;
}

export interface AgentModelInfo {
  id: string;
}

export interface PlannedSubtask {
  label: string;
  task: string;
  scope?: string[];
  depends_on?: string[];
}

function parsePlannedSubtasksFromObject(parsed: Record<string, unknown> | undefined): PlannedSubtask[] {
  const tasksRaw = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
  if (tasksRaw.length === 0) {
    return [];
  }

  const intermediate = tasksRaw.reduce<Array<{ label: string; task: string; scope: string[]; depends_on: string[] }>>((acc, item, index) => {
    const record = item as Record<string, unknown>;
    const label = String(record.label ?? "").trim();
    const task = String(record.task ?? "").trim();
    if (!task) {
      return acc;
    }

    const scopeRaw = Array.isArray(record.scope) ? record.scope : [];
    const dependsRaw = Array.isArray(record.depends_on) ? record.depends_on : [];
    const scope = scopeRaw
      .map((part) => String(part ?? "").trim())
      .filter(Boolean)
      .slice(0, 8);
    const dependsOn = dependsRaw
      .map((part) => String(part ?? "").trim())
      .filter(Boolean)
      .slice(0, 8);

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

  const labelCounts = new Map<string, number>();
  const normalized = intermediate.map((item) => {
    const seen = (labelCounts.get(item.label) ?? 0) + 1;
    labelCounts.set(item.label, seen);
    const label = seen === 1 ? item.label : `${item.label}-${seen}`;
    return { ...item, label };
  });

  const allowedLabels = new Set(normalized.map((item) => item.label));
  return normalized.map((item) => {
    const depends = item.depends_on
      .filter((label) => label !== item.label && allowedLabels.has(label))
      .filter((label, index, arr) => arr.indexOf(label) === index)
      .slice(0, 8);

    const planned: PlannedSubtask = {
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

export function parsePlannedSubtasksText(text: string): PlannedSubtask[] {
  const parsed = extractJsonObject(text);
  return parsePlannedSubtasksFromObject(parsed);
}

function toToolCall(item: any): ToolCall {
  return {
    name: String(item.name),
    arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
    callId: String(item.call_id)
  };
}

function extractOutputText(response: any): string {
  if (typeof response.output_text === "string" && response.output_text.trim().length > 0) {
    return response.output_text;
  }

  const output = Array.isArray(response.output) ? response.output : [];
  const chunks: string[] = [];

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

function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const direct = JSON.parse(trimmed);
    if (direct && typeof direct === "object" && !Array.isArray(direct)) {
      return direct as Record<string, unknown>;
    }
  } catch {
    // continue
  }

  const fenceMatch = /```json\s*([\s\S]*?)```/i.exec(text);
  if (fenceMatch?.[1]) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // continue
    }
  }

  const objectMatch = /\{[\s\S]*\}/.exec(text);
  if (!objectMatch) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(objectMatch[0]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export class GrokAgent {
  private readonly client: OpenAI;
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly toolContext: ToolContext;
  private instructionsSupported = true;
  private instructionsWithPreviousResponseSupported = true;

  constructor(config: AgentConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL;
    this.client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
    this.toolContext = config.toolContext;
  }

  forkWithToolContext(toolContext: ToolContext): GrokAgent {
    const next = new GrokAgent({
      apiKey: this.apiKey,
      baseURL: this.baseURL,
      toolContext
    });
    next.instructionsSupported = this.instructionsSupported;
    next.instructionsWithPreviousResponseSupported = this.instructionsWithPreviousResponseSupported;
    return next;
  }

  private static isInstructionsUnsupportedError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("Parameter is not supported with reasoning models: instructions");
  }

  private static isInstructionsWithPreviousResponseUnsupportedError(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return message.includes("not supported") && message.includes("instructions") && message.includes("previous_response_id");
  }

  private async createResponse(
    request: Pick<ResponseCreateParamsNonStreaming, "model" | "input" | "previous_response_id" | "tools" | "tool_choice">,
    instructions: string
  ): Promise<any> {
    const includeInstructions =
      this.instructionsSupported &&
      (this.instructionsWithPreviousResponseSupported || request.previous_response_id === undefined);

    try {
      return await this.client.responses.create({
        ...request,
        instructions: includeInstructions ? instructions : undefined,
        store: true
      });
    } catch (error) {
      if (includeInstructions && GrokAgent.isInstructionsWithPreviousResponseUnsupportedError(error) && request.previous_response_id) {
        this.instructionsWithPreviousResponseSupported = false;
        return await this.client.responses.create({
          ...request,
          store: true
        });
      }

      if (!includeInstructions || !GrokAgent.isInstructionsUnsupportedError(error)) {
        throw error;
      }

      this.instructionsSupported = false;
      return await this.client.responses.create({
        ...request,
        store: true
      });
    }
  }

  async run(input: string, state: AgentState, hooks?: AgentHooks, options?: AgentRunOptions): Promise<AgentRunResult> {
    const instructions = withUserSystemOverride(state.systemPromptOverride);

    let response: any = await this.createResponse(
      {
        model: state.model,
        input,
        previous_response_id: state.previousResponseId,
        tools: state.enableTools ? TOOL_SCHEMAS : undefined,
        tool_choice: state.enableTools ? "auto" : "none"
      },
      instructions
    );

    const maxToolRounds = Math.max(1, options?.maxToolRounds ?? 24);
    let rounds = 0;

    while (state.enableTools) {
      const calls = (Array.isArray(response.output) ? response.output : [])
        .filter((item: any) => item?.type === "function_call")
        .map(toToolCall);

      if (calls.length === 0) {
        break;
      }

      rounds += 1;
      if (rounds > maxToolRounds) {
        throw new Error(`Tool loop exceeded ${maxToolRounds} rounds`);
      }

      const toolOutputs = [] as Array<{ type: "function_call_output"; call_id: string; output: string }>;
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

  async listModels(): Promise<AgentModelInfo[]> {
    const response = await this.client.models.list();
    const items = Array.isArray((response as any).data) ? (response as any).data : [];
    return items
      .map((item: any) => ({ id: String(item?.id ?? "") }))
      .filter((item: AgentModelInfo) => item.id.length > 0)
      .sort((a: AgentModelInfo, b: AgentModelInfo) => a.id.localeCompare(b.id));
  }

  async planSubtasks(goal: string, state: AgentState, plannerModel?: string): Promise<PlannedSubtask[]> {
    const instructions = withUserSystemOverride(state.systemPromptOverride);
    const planningModel = plannerModel?.trim() || state.plannerModel?.trim() || state.model;
    const basePrompt =
      `Break this engineering goal into 2-6 executable worker tasks.\n\n` +
      `Goal:\n${goal}\n\n` +
      `Output strict JSON only:\n` +
      `{"tasks":[{"label":"short label","task":"concrete engineering instruction","scope":["path/or/file"],"depends_on":["other label"]}]}\n\n` +
      `Rules:\n` +
      `- prefer the minimum useful number of tasks (often 1-3 for simple goals)\n` +
      `- include one setup task when needed (files/directories/bootstrap)\n` +
      `- do not add a separate test/verify task unless validation is explicitly requested or clearly necessary\n` +
      `- implementation tasks should have disjoint scope whenever possible\n` +
      `- test/verify tasks must depend_on implementation tasks\n` +
      `- scope should be specific paths (files or directories)\n` +
      `- depends_on values must reference labels from this same task list\n` +
      `- for visual/creative tasks (UI, animation, demos), require polished output and concrete run instructions in task wording\n` +
      `- do not include markdown`;
    const response: any = await this.createResponse(
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

    const repairPrompt =
      `Rewrite the following planner draft into strict JSON with this exact shape:\n` +
      `{"tasks":[{"label":"short label","task":"concrete engineering instruction","scope":["path/or/file"],"depends_on":["other label"]}]}\n\n` +
      `Return JSON only. No markdown.\n\n` +
      `Draft:\n${text || "(empty response)"}`;
    const repaired: any = await this.createResponse(
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
}
