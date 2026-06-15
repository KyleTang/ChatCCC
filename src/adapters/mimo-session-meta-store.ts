// =============================================================================
// mimo-session-meta-store.ts — MiMo Code 会话 sessionId → meta 持久化映射
// =============================================================================

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { USER_DATA_DIR } from "../config.ts";

export const MIMO_SESSION_META_FILE = join(
  USER_DATA_DIR,
  "state",
  "mimo-session-meta.json",
);

export interface MimoSessionMeta {
  cwd: string;
  threadId?: string;
}

export interface MimoSessionMetaStore {
  get(sessionId: string): Promise<MimoSessionMeta | undefined>;
  set(sessionId: string, partial: Partial<MimoSessionMeta>): Promise<void>;
  setThreadId(sessionId: string, threadId: string): Promise<void>;
}

interface RawEntry {
  cwd?: string;
  threadId?: string;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function parseEntry(raw: unknown): RawEntry | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const out: RawEntry = {};
    if (isNonEmptyString(obj.cwd)) out.cwd = obj.cwd;
    if (isNonEmptyString(obj.threadId)) out.threadId = obj.threadId;
    return out;
  }
  return null;
}

export function createMimoSessionMetaStore(
  filePath: string = MIMO_SESSION_META_FILE,
): MimoSessionMetaStore {
  let cache: Record<string, RawEntry> | null = null;

  async function load(): Promise<Record<string, RawEntry>> {
    if (cache) return cache;
    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const out: Record<string, RawEntry> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          const entry = parseEntry(v);
          if (entry) out[k] = entry;
        }
        cache = out;
        return out;
      }
    } catch {
      // 文件不存在或损坏
    }
    cache = {};
    return cache;
  }

  async function save(map: Record<string, RawEntry>): Promise<void> {
    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(map, null, 2), "utf-8");
    } catch (err) {
      console.error(
        `[mimo-session-meta] failed to persist ${filePath}: ${(err as Error).message}`,
      );
    }
  }

  return {
    async get(sessionId: string): Promise<MimoSessionMeta | undefined> {
      const map = await load();
      const entry = map[sessionId];
      if (!entry || !isNonEmptyString(entry.cwd)) return undefined;
      return entry.threadId
        ? { cwd: entry.cwd, threadId: entry.threadId }
        : { cwd: entry.cwd };
    },

    async set(
      sessionId: string,
      partial: Partial<MimoSessionMeta>,
    ): Promise<void> {
      const map = await load();
      const existing = map[sessionId] ?? {};
      const merged: RawEntry = { ...existing };
      if (isNonEmptyString(partial.cwd)) merged.cwd = partial.cwd;
      if (isNonEmptyString(partial.threadId)) merged.threadId = partial.threadId;

      if (existing.cwd === merged.cwd && existing.threadId === merged.threadId) return;

      map[sessionId] = merged;
      await save(map);
    },

    async setThreadId(
      sessionId: string,
      threadId: string,
    ): Promise<void> {
      const map = await load();
      const existing = map[sessionId] ?? {};
      if (existing.threadId === threadId) return;
      const merged: RawEntry = { ...existing, threadId };
      map[sessionId] = merged;
      await save(map);
    },
  };
}

export const defaultMimoSessionMetaStore = createMimoSessionMetaStore();
