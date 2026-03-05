import OpenAI from "openai";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";

import { withUserSystemOverride } from "./prompts.js";
import { executeToolCall, type ToolCall, type ToolContext, type ToolExecutionResult, TOOL_SCHEMAS } from "./tools.js";

interface AgentHooks {
  onToolCallStart?: (call: ToolCall) => void;
  onToolCallResult?: (call: ToolCall, result: ToolExecutionResult) => void;
}

export interface AgentState {
  model: string;
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
  private readonly toolContext: ToolContext;
  private instructionsSupported = true;
  private instructionsWithPreviousResponseSupported = true;

  constructor(config: AgentConfig) {
    this.client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
    this.toolContext = config.toolContext;
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

  async run(input: string, state: AgentState, hooks?: AgentHooks): Promise<AgentRunResult> {
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

    const maxToolRounds = 12;
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

  async planSubtasks(goal: string, state: AgentState): Promise<PlannedSubtask[]> {
    const instructions = withUserSystemOverride(state.systemPromptOverride);
    const response: any = await this.client.responses.create({
      model: state.model,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                `Break this engineering goal into 2-5 executable worker tasks.\n\n` +
                `Goal:\n${goal}\n\n` +
                `Output strict JSON only:\n` +
                `{"tasks":[{"label":"short label","task":"concrete engineering instruction"}]}\n\n` +
                `Rules:\n` +
                `- tasks must be independently executable by subagents\n` +
                `- include explicit file/test scope when possible\n` +
                `- do not include markdown`
            }
          ]
        }
      ],
      instructions,
      store: false
    });

    const text = extractOutputText(response);
    const parsed = extractJsonObject(text);
    const tasksRaw = Array.isArray(parsed?.tasks) ? parsed?.tasks : [];

    const tasks = tasksRaw
      .map((item) => {
        const record = item as Record<string, unknown>;
        const label = String(record.label ?? "").trim();
        const task = String(record.task ?? "").trim();
        if (!task) {
          return undefined;
        }
        return {
          label: label || "worker-task",
          task
        };
      })
      .filter((item): item is PlannedSubtask => Boolean(item))
      .slice(0, 8);

    if (tasks.length > 0) {
      return tasks;
    }

    return [{ label: "implementation", task: goal.trim() }];
  }
}
