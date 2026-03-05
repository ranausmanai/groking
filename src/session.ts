import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface SessionData {
  version: number;
  name: string;
  workspace: string;
  model: string;
  plannerModel?: string;
  previousResponseId?: string;
  createdAt: string;
  updatedAt: string;
}

const SESSION_VERSION = 1;

function defaultSessionDir(): string {
  return path.join(os.homedir(), ".groking", "sessions");
}

function workspaceHash(workspace: string): string {
  return crypto.createHash("sha1").update(workspace).digest("hex").slice(0, 10);
}

export function resolveSessionPath(sessionName: string | undefined, workspace: string): string {
  const safeName = sessionName?.trim();
  if (safeName) {
    return path.join(defaultSessionDir(), `${safeName}.json`);
  }

  const hash = workspaceHash(workspace);
  return path.join(defaultSessionDir(), `workspace-${hash}.json`);
}

export async function loadSession(sessionPath: string): Promise<SessionData | undefined> {
  try {
    const raw = await fs.readFile(sessionPath, "utf8");
    const parsed = JSON.parse(raw) as SessionData;
    if (parsed.version !== SESSION_VERSION) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export async function saveSession(sessionPath: string, data: Omit<SessionData, "version" | "updatedAt"> & { updatedAt?: string }): Promise<void> {
  const payload: SessionData = {
    ...data,
    version: SESSION_VERSION,
    updatedAt: new Date().toISOString()
  };

  await fs.mkdir(path.dirname(sessionPath), { recursive: true });
  await fs.writeFile(sessionPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export async function clearSession(sessionPath: string): Promise<boolean> {
  try {
    await fs.unlink(sessionPath);
    return true;
  } catch {
    return false;
  }
}
