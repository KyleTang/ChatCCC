// =============================================================================
// mimo-adapter.ts — MiMo Code CLI 适配器
// =============================================================================
// 通过 mimo exec --json 与 MiMo Code CLI 交互。
// - createSession: 生成 UUID sessionId，记录 cwd，不创建线程（延迟到首次 prompt）
// - prompt: 首次调用用 mimo exec 创建线程，后续用 mimo exec resume 恢复
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
  defaultMimoSessionMetaStore,
  type MimoSessionMetaStore,
} from "./mimo-session-meta-store.ts";
import { killProcessTree } from "./proc-tree-kill.ts";
import { config } from "../config.ts";

// ---------------------------------------------------------------------------
// 特殊注入提示
// ---------------------------------------------------------------------------

const PROJECT_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const MIMO_SPECIFIC_PROMPT_PATH = join(
  PROJECT_ROOT,
  "agent-prompts",
  "mimo_specific.md",
);

function readMimoSpecificInjectionPrompt(): string | null {
  try {
    if (!existsSync(MIMO_SPECIFIC_PROMPT_PATH)) return null;
    const prompt = readFileSync(MIMO_SPECIFIC_PROMPT_PATH, "utf-8").trim();
    return prompt.length > 0 ? prompt : null;
  } catch {
    return null;
  }
}

function buildMimoPromptText(userText: string): string {
  const prompt = readMimoSpecificInjectionPrompt();
  if (!prompt) return userText;

  return [
    "[ChatCCC MiMo-specific injection prompt]",
    prompt,
    "[/ChatCCC MiMo-specific injection prompt]",
    "",
    userText,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 命令与参数
// ---------------------------------------------------------------------------

function detectMimoCommand(): string {
  return config.mimo.path || "mimo";
}
const MIMO_COMMAND = detectMimoCommand();

const MIMO_BASE_ARGS = [
  "exec",
  "--json",
  "--dangerously-bypass-approvals-and-sandbox",
  "--skip-git-repo-check",
];

function resolveMimoModel(): string | null {
  const m = config.mimo.model;
  return m.trim() !== "" ? m : null;
}

function resolveMimoApiKey(): string | null {
  const k = config.mimo.apiKey;
  return k.trim() !== "" ? k : null;
}

function resolveMimoBaseUrl(): string | null {
  const b = config.mimo.baseUrl;
  return b.trim() !== "" ? b : null;
}

// ---------------------------------------------------------------------------
// 类型：MiMo JSONL 消息行
// ---------------------------------------------------------------------------

interface MimoItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
}

interface MimoEvent {
  type: string;
  thread_id?: string;
  item?: MimoItem;
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
}

// ---------------------------------------------------------------------------
// normalizeMimoMessage — MiMo 事件 → UnifiedStreamMessage | null
// ---------------------------------------------------------------------------

export function normalizeMimoMessage(
  msg: MimoEvent,
): UnifiedStreamMessage | null {
  // agent_message 文本回复
  if (
    msg.type === "item.completed" &&
    msg.item?.type === "agent_message" &&
    msg.item.text
  ) {
    return {
      type: "assistant",
      blocks: [{ type: "text", text: msg.item.text }],
    };
  }

  // command_execution 工具调用开始
  if (
    msg.type === "item.started" &&
    msg.item?.type === "command_execution" &&
    msg.item.command
  ) {
    return {
      type: "assistant",
      blocks: [
        {
          type: "tool_use",
          name: "Bash",
          input: { command: msg.item.command },
        },
      ],
    };
  }

  // command_execution 工具调用完成
  if (
    msg.type === "item.completed" &&
    msg.item?.type === "command_execution"
  ) {
    const exitCode = msg.item.exit_code;
    return {
      type: "assistant",
      blocks: [
        {
          type: "tool_result",
          tool_use_id: msg.item.id ?? "",
          content: msg.item.aggregated_output ?? "",
          is_error: exitCode != null && exitCode !== 0 ? true : undefined,
        },
      ],
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// 子进程辅助函数
// ---------------------------------------------------------------------------

function spawnMimo(
  args: string[],
  cwd?: string,
  stdinText?: string,
  modelOverride?: string,
): ChildProcess {
  const allArgs = [...args];
  const model = modelOverride ?? resolveMimoModel();
  if (model) {
    const execIdx = allArgs.indexOf("exec");
    allArgs.splice(execIdx + 1, 0, "-m", model);
  }

  const env = { ...process.env };
  const apiKey = resolveMimoApiKey();
  if (apiKey) env.MIMO_API_KEY = apiKey;
  const baseUrl = resolveMimoBaseUrl();
  if (baseUrl) env.MIMO_BASE_URL = baseUrl;

  const proc = spawn(MIMO_COMMAND, allArgs, {
    cwd,
    stdio: [stdinText !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: true,
    env,
  });

  let stderr = "";
  proc.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  proc.on("close", (code) => {
    if (code !== 0 && stderr.trim()) {
      console.error(
        `[MiMo stderr] exit=${code}: ${stderr.trim().slice(0, 2000)}`,
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
): AsyncGenerator<MimoEvent> {
  const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
  const onAbort = () => { rl.close(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for await (const line of rl) {
      if (signal?.aborted) break;
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        yield JSON.parse(trimmed) as MimoEvent;
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

class MimoAdapter implements ToolAdapter {
  readonly displayName = "MiMo Code";
  readonly sessionDescPrefix = "MiMo Session:";
  private metaStore: MimoSessionMetaStore;
  private modelOverride: string | undefined;

  constructor(metaStore: MimoSessionMetaStore, modelOverride?: string) {
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
    let meta = await this.metaStore.get(sessionId);
    const threadId = meta?.threadId;
    const isFirstPrompt = !threadId;

    const cmd = parseUserCommand(userText);
    const baseArgs = cmd.mode
      ? ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check"]
      : MIMO_BASE_ARGS;
    const args = isFirstPrompt
      ? [...baseArgs, "-C", cwd, "-"]
      : [...baseArgs, "resume", threadId, "-"];

    const proc = spawnMimo(args, cwd, buildMimoPromptText(userText), this.modelOverride);
    if (proc.pid !== undefined) options?.onProcessStart?.({ pid: proc.pid });

    const onAbort = () => { void killProcessTree(proc.pid); };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      for await (const raw of readJsonLines(proc, signal)) {
        if (signal?.aborted) break;

        if (
          isFirstPrompt &&
          raw.type === "thread.started" &&
          raw.thread_id
        ) {
          void this.metaStore
            .setThreadId(sessionId, raw.thread_id)
            .catch(() => {});
        }

        const normalized = normalizeMimoMessage(raw);
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

export interface CreateMimoAdapterOptions {
  metaStore?: MimoSessionMetaStore;
  model?: string;
}

export function createMimoAdapter(
  options: CreateMimoAdapterOptions = {},
): ToolAdapter {
  return new MimoAdapter(
    options.metaStore ?? defaultMimoSessionMetaStore,
    options.model,
  );
}
