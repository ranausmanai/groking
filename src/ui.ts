import * as readline from "node:readline";
import process from "node:process";

type Tone = "muted" | "accent" | "ok" | "warn" | "error" | "title" | "text";

const COLORS: Record<Tone, string> = {
  muted: "\x1b[2m",
  accent: "\x1b[96m",
  ok: "\x1b[92m",
  warn: "\x1b[93m",
  error: "\x1b[91m",
  title: "\x1b[95m",
  text: "\x1b[97m"
};

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const ITALIC = "\x1b[3m";

function canColor(): boolean {
  return Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
}

function paint(text: string, tone: Tone): string {
  if (!canColor()) {
    return text;
  }
  return `${COLORS[tone]}${text}${RESET}`;
}

function truncate(input: string, max = 180): string {
  if (input.length <= max) {
    return input;
  }
  return `${input.slice(0, max)} …[${input.length - max} more chars]`;
}

function compactArguments(raw: string): string {
  const text = raw.trim();
  if (!text) {
    return "{}";
  }

  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      return truncate(text);
    }

    const compacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        compacted[key] = value.length > 80 ? `<string ${value.length} chars>` : value;
        continue;
      }
      compacted[key] = value;
    }
    return truncate(JSON.stringify(compacted));
  } catch {
    return truncate(text.replace(/\s+/g, " "));
  }
}

export function formatPrompt(): string {
  return `${paint("groking", "accent")}${paint(">", "title")} `;
}

export function formatToolStart(name: string, argsRaw: string): string {
  return `${paint("tool>", "title")} ${paint(name, "text")} ${paint(compactArguments(argsRaw), "muted")}`;
}

export function formatToolResult(name: string, summary: string): string {
  return `${paint("tool<", "title")} ${paint(name, "text")} ${paint(truncate(summary, 220), "muted")}`;
}

export function formatError(message: string): string {
  return `${paint("error:", "error")} ${message}`;
}

function stylizeInlineMarkdown(line: string): string {
  if (!canColor()) {
    return line;
  }

  const codeSegments: string[] = [];
  let transformed = line.replace(/`([^`]+)`/g, (_, code: string) => {
    const token = `@@CODE_${codeSegments.length}@@`;
    codeSegments.push(code);
    return token;
  });

  transformed = transformed.replace(/\*\*(.+?)\*\*/g, (_, boldText: string) => {
    return `${BOLD}${boldText}${RESET}${COLORS.text}`;
  });

  transformed = transformed.replace(/(^|[^*])\*(?!\*)([^*]+)\*(?!\*)/g, (_, prefix: string, italicText: string) => {
    return `${prefix}${ITALIC}${italicText}${RESET}${COLORS.text}`;
  });

  transformed = transformed.replace(/@@CODE_(\d+)@@/g, (_, idx: string) => {
    const code = codeSegments[Number(idx)] ?? "";
    return `\x1b[38;5;229m\x1b[48;5;238m ${code} ${RESET}${COLORS.text}`;
  });

  return transformed;
}

function renderAssistantBody(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      const label = trimmed.replace(/```/, "").trim();
      if (inCodeBlock) {
        out.push(paint(`┌─ code${label ? ` (${label})` : ""}`, "muted"));
      } else {
        out.push(paint("└─ end code", "muted"));
      }
      continue;
    }

    if (inCodeBlock) {
      out.push(canColor() ? `\x1b[38;5;120m${line}${RESET}` : line);
      continue;
    }

    if (/^#{1,6}\s+/.test(trimmed)) {
      const heading = trimmed.replace(/^#{1,6}\s+/, "");
      out.push(canColor() ? `${BOLD}${paint(heading, "title")}${RESET}` : heading);
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const item = trimmed.replace(/^[-*]\s+/, "");
      const styled = stylizeInlineMarkdown(item);
      out.push(canColor() ? `${COLORS.text}• ${styled}${RESET}` : `• ${item}`);
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const styled = stylizeInlineMarkdown(trimmed);
      out.push(canColor() ? `${COLORS.text}${styled}${RESET}` : trimmed);
      continue;
    }

    const styled = stylizeInlineMarkdown(line);
    out.push(canColor() ? `${COLORS.text}${styled}${RESET}` : styled);
  }

  return out.join("\n");
}

export function printAssistantText(text: string): void {
  const header = paint("assistant", "accent");
  const body = renderAssistantBody(text);
  process.stdout.write(`\n${header}\n${body}\n\n`);
}

export class Spinner {
  private readonly frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private timer?: NodeJS.Timeout;
  private index = 0;
  private text = "Thinking...";
  private active = false;
  private printedFallback = false;

  start(text?: string): void {
    if (text) {
      this.text = text;
    }
    if (!process.stdout.isTTY) {
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

  setText(text: string): void {
    this.text = text;
    if (this.active) {
      this.render();
    }
  }

  log(line: string): void {
    if (!process.stdout.isTTY || !this.active) {
      console.log(line);
      return;
    }

    this.clearLine();
    console.log(line);
    this.render();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    if (process.stdout.isTTY && this.active) {
      this.clearLine();
    }

    this.active = false;
    this.printedFallback = false;
  }

  private render(): void {
    if (!process.stdout.isTTY || !this.active) {
      return;
    }

    const frame = this.frames[this.index];
    const text = `${paint(frame, "title")} ${paint(this.text, "muted")}`;
    process.stdout.write(`\r${text}`);
  }

  private clearLine(): void {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  }
}
