// =============================================================================
// deveco-adapter.ts — Deveco Code CLI 适配器（基于 OpenCode）
// =============================================================================
// 通过 deveco run --format json 与 Deveco Code CLI 交互。
// - createSession: 生成 UUID sessionId，记录 cwd，不创建 OpenCode 会话（延迟到首次 prompt）
// - prompt: 首次调用创建新会话，后续用 --session 恢复
// - getSessionInfo: 从持久化映射读取 cwd / threadId
// =============================================================================

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

import type {
  ToolAdapter,
  ToolPromptOptions,
  UnifiedBlock,
  UnifiedStreamMessage,
  CreateSessionResult,
  SessionInfo,
} from "./adapter-interface.ts";
import { parseUserCommand } from "./adapter-interface.ts";
import {
  defaultDevecoSessionMetaStore,
  type DevecoSessionMetaStore,
} from "./deveco-session-meta-store.ts";
import { killProcessTree } from "./proc-tree-kill.ts";
import { config } from "../config.ts";

// ---------------------------------------------------------------------------
// 特殊注入提示
// ---------------------------------------------------------------------------

const PROJECT_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const DEVECO_SPECIFIC_PROMPT_PATH = join(
  PROJECT_ROOT,
  "agent-prompts",
  "deveco_specific.md",
);

function readDevecoSpecificInjectionPrompt(): string | null {
  try {
    if (!existsSync(DEVECO_SPECIFIC_PROMPT_PATH)) return null;
    const prompt = readFileSync(DEVECO_SPECIFIC_PROMPT_PATH, "utf-8").trim();
    return prompt.length > 0 ? prompt : null;
  } catch {
    return null;
  }
}

function buildDevecoPromptText(userText: string): string {
  const prompt = readDevecoSpecificInjectionPrompt();
  if (!prompt) return userText;

  return [
    "[ChatCCC Deveco-specific injection prompt]",
    prompt,
    "[/ChatCCC Deveco-specific injection prompt]",
    "",
    userText,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 命令与参数
// ---------------------------------------------------------------------------

function detectDevecoCommand(): string {
  return config.deveco.path || "deveco";
}

function resolveDevecoModel(): string | null {
  const m = config.deveco.model;
  return m.trim() !== "" ? m : null;
}

function resolveDevecoAgent(): string | null {
  const a = config.deveco.agent;
  return a.trim() !== "" ? a : null;
}

// ---------------------------------------------------------------------------
// 类型：Deveco / OpenCode run --format json 输出行
// ---------------------------------------------------------------------------

interface DevecoToolState {
  status?: string;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
}

interface DevecoPart {
  id?: string;
  callID?: string;
  type?: string;
  tool?: string;
  text?: string;
  state?: DevecoToolState;
}

export interface DevecoEvent {
  type: string;
  sessionID?: string;
  timestamp?: number;
  part?: DevecoPart;
  error?: unknown;
}

// ---------------------------------------------------------------------------
// normalizeDevecoMessage — Deveco JSON 事件 → UnifiedStreamMessage | null
// ---------------------------------------------------------------------------

export function normalizeDevecoMessage(
  msg: DevecoEvent,
): UnifiedStreamMessage | null {
  if (msg.type === "text" && msg.part?.text) {
    return {
      type: "assistant",
      blocks: [{ type: "text", text: msg.part.text }],
    };
  }

  if (msg.type === "reasoning" && msg.part?.text) {
    return {
      type: "assistant",
      blocks: [{ type: "thinking", thinking: msg.part.text }],
    };
  }

  if (msg.type === "tool_use" && msg.part?.type === "tool") {
    const part = msg.part;
    const toolId = part.callID || part.id || "";
    const blocks: UnifiedBlock[] = [
      {
        type: "tool_use",
        id: toolId || undefined,
        name: part.tool || "tool",
        input: part.state?.input ?? {},
      },
    ];
    const status = part.state?.status;
    if (status === "completed") {
      blocks.push({
        type: "tool_result",
        tool_use_id: toolId,
        content: part.state?.output ?? "",
      });
    } else if (status === "error") {
      blocks.push({
        type: "tool_result",
        tool_use_id: toolId,
        content: part.state?.error ?? "",
        is_error: true,
      });
    }
    return { type: "assistant", blocks };
  }

  if (msg.type === "error") {
    const text =
      typeof msg.error === "string"
        ? msg.error
        : msg.error && typeof msg.error === "object" && "message" in msg.error
          ? String((msg.error as { message?: unknown }).message ?? "Unknown error")
          : "Deveco Code error";
    return {
      type: "assistant",
      blocks: [{ type: "text", text }],
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// 子进程辅助函数
// ---------------------------------------------------------------------------

function spawnDeveco(
  args: string[],
  cwd?: string,
  stdinText?: string,
  modelOverride?: string,
): ChildProcess {
  const allArgs = ["run", "--format", "json", ...args];
  const model = modelOverride ?? resolveDevecoModel();
  if (model) {
    allArgs.push("-m", model);
  }
  const agent = resolveDevecoAgent();
  if (agent) {
    allArgs.push("--agent", agent);
  }

  const proc = spawn(detectDevecoCommand(), allArgs, {
    cwd,
    stdio: [stdinText !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: true,
  });

  let stderr = "";
  proc.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  proc.on("close", (code) => {
    if (code !== 0 && stderr.trim()) {
      console.error(
        `[Deveco stderr] exit=${code}: ${stderr.trim().slice(0, 2000)}`,
      );
    }
  });

  if (stdinText !== undefined) {
    proc.stdin!.write(stdinText);
    proc.stdin!.end();
  }
  return proc;
}

async function* readJsonLines(
  proc: ChildProcess,
  signal?: AbortSignal,
): AsyncGenerator<DevecoEvent> {
  const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
  const onAbort = () => { rl.close(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for await (const line of rl) {
      if (signal?.aborted) break;
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        yield JSON.parse(trimmed) as DevecoEvent;
      } catch {
        // 非 JSON 行静默跳过
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// 适配器实现
// ---------------------------------------------------------------------------

class DevecoAdapter implements ToolAdapter {
  readonly displayName = "Deveco Code";
  readonly sessionDescPrefix = "Deveco Code Session:";
  private metaStore: DevecoSessionMetaStore;
  private modelOverride: string | undefined;

  constructor(metaStore: DevecoSessionMetaStore, modelOverride?: string) {
    this.metaStore = metaStore;
    this.modelOverride = modelOverride;
  }

  async createSession(cwd: string): Promise<CreateSessionResult> {
    const sessionId = randomUUID();
    await this.metaStore.set(sessionId, { cwd });
    return { sessionId };
  }

  async *prompt(
    sessionId: string,
    userText: string,
    cwd: string,
    signal?: AbortSignal,
    options?: ToolPromptOptions,
  ): AsyncIterable<UnifiedStreamMessage> {
    const meta = await this.metaStore.get(sessionId);
    const threadId = meta?.threadId;
    const isFirstPrompt = !threadId;

    const cmd = parseUserCommand(userText);
    const runArgs = isFirstPrompt
      ? cmd.mode
        ? ["--dir", cwd]
        : ["--dangerously-skip-permissions", "--dir", cwd]
      : cmd.mode
        ? ["--session", threadId!]
        : ["--dangerously-skip-permissions", "--session", threadId!];

    const proc = spawnDeveco(runArgs, cwd, buildDevecoPromptText(userText), this.modelOverride);
    if (proc.pid !== undefined) options?.onProcessStart?.({ pid: proc.pid });

    const onAbort = () => { void killProcessTree(proc.pid); };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      for await (const raw of readJsonLines(proc, signal)) {
        if (signal?.aborted) break;

        if (
          isFirstPrompt &&
          raw.sessionID &&
          typeof raw.sessionID === "string"
        ) {
          void this.metaStore
            .setThreadId(sessionId, raw.sessionID)
            .catch(() => {});
        }

        const normalized = normalizeDevecoMessage(raw);
        if (normalized) yield normalized;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await killProcessTree(proc.pid);
      if (proc.pid !== undefined) options?.onProcessExit?.({ pid: proc.pid });
    }
  }

  async getSessionInfo(
    sessionId: string,
  ): Promise<SessionInfo | undefined> {
    const meta = await this.metaStore.get(sessionId);
    if (!meta) return undefined;
    return { sessionId, cwd: meta.cwd };
  }

  async closeSession(_sessionId: string): Promise<void> {
    // no-op：子进程由 prompt 的 finally 自动 kill
  }
}

// ---------------------------------------------------------------------------
// 工厂函数
// ---------------------------------------------------------------------------

export interface CreateDevecoAdapterOptions {
  metaStore?: DevecoSessionMetaStore;
  model?: string;
}

export function createDevecoAdapter(
  options: CreateDevecoAdapterOptions = {},
): ToolAdapter {
  return new DevecoAdapter(
    options.metaStore ?? defaultDevecoSessionMetaStore,
    options.model,
  );
}
