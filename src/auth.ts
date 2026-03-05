import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";

interface GrokingConfig {
  xai_api_key?: string;
}

function configPath(): string {
  return path.join(os.homedir(), ".groking", "config.json");
}

async function readConfig(): Promise<GrokingConfig> {
  try {
    const raw = await fs.readFile(configPath(), "utf8");
    const parsed = JSON.parse(raw) as GrokingConfig;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeConfig(next: GrokingConfig): Promise<void> {
  const file = configPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

async function promptVisible(promptText: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  });
  try {
    return (await rl.question(promptText)).trim();
  } finally {
    rl.close();
  }
}

async function promptHidden(promptText: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return await promptVisible(promptText);
  }

  const stdin = process.stdin;
  const stdout = process.stdout;
  const chunks: string[] = [];

  return await new Promise<string>((resolve, reject) => {
    const restoreRawMode = stdin.isRaw;
    const cleanup = (): void => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(restoreRawMode ?? false);
      stdin.pause();
    };

    const onData = (buf: Buffer): void => {
      const text = buf.toString("utf8");
      if (text === "\u0003") {
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

      if (text === "\u007f") {
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

export async function resolveApiKeyInteractive(): Promise<string> {
  const fromEnv = process.env.XAI_API_KEY?.trim();
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
