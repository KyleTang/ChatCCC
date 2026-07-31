import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, resolve } from "node:path";
import { stat } from "node:fs/promises";

import { readUtf8JsonBody } from "./agent-rpc-body.ts";
import {
  addRecentDir,
  resolveDefaultAgentTool,
  sessionPrefixForTool,
  setCwdLock,
  setDefaultCwd,
  toolDisplayName,
  ts,
} from "./config.ts";
import {
  getTenantAccessToken,
  updateChatInfo,
  applyGroupChatTag,
} from "./feishu-platform.ts";
import {
  bindChatToSession,
  unbindChatFromSession,
} from "./session-chat-binding.ts";
import {
  initClaudeSession,
  loadSessionRegistryForBinding,
  recordSessionRegistry,
  saveSessionTool,
  sessionInfoMap,
} from "./session.ts";

export const AGENT_BIND_CHAT_CWD_PATH = "/api/agent/bind-chat-cwd";

const MAX_REQUEST_BYTES = 64 * 1024;

function jsonReply(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function assertDir(cwd: string): Promise<string> {
  const abs = isAbsolute(cwd) ? resolve(cwd) : resolve(cwd);
  const st = await stat(abs);
  if (!st.isDirectory()) throw new Error("cwd is not a directory");
  return abs;
}

/**
 * MyWorkDesk / 外部编排：把飞书群 chat_id 绑定到固定工作目录，
 * 可选锁定（禁止 /cd），并确保群内已有 Agent session。
 */
export async function handleAgentBindChatCwdRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== AGENT_BIND_CHAT_CWD_PATH) return false;

  if (req.method !== "POST") {
    jsonReply(res, 405, { ok: false, error: "Method not allowed" });
    return true;
  }

  let payload: {
    chat_id?: unknown;
    cwd?: unknown;
    lock?: unknown;
    ensure_session?: unknown;
    chat_name?: unknown;
    tool?: unknown;
    project_slug?: unknown;
    source?: unknown;
  };
  try {
    payload = await readUtf8JsonBody(req, MAX_REQUEST_BYTES);
  } catch (err) {
    jsonReply(res, 400, { ok: false, error: (err as Error).message || "Invalid JSON" });
    return true;
  }

  const chatId = typeof payload.chat_id === "string" ? payload.chat_id.trim() : "";
  const rawCwd = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
  if (!chatId || !rawCwd) {
    jsonReply(res, 400, { ok: false, error: "chat_id and cwd are required" });
    return true;
  }

  const lock = payload.lock !== false;
  const ensureSession = payload.ensure_session !== false;
  const chatName =
    typeof payload.chat_name === "string" && payload.chat_name.trim()
      ? payload.chat_name.trim()
      : undefined;
  const tool =
    typeof payload.tool === "string" && payload.tool.trim()
      ? payload.tool.trim()
      : resolveDefaultAgentTool();

  let cwd: string;
  try {
    cwd = await assertDir(rawCwd);
  } catch (err) {
    jsonReply(res, 400, { ok: false, error: (err as Error).message || "invalid cwd" });
    return true;
  }

  try {
    await setDefaultCwd(cwd, chatId);
    await setCwdLock(chatId, lock, {
      project_slug:
        typeof payload.project_slug === "string" ? payload.project_slug : undefined,
      source: typeof payload.source === "string" ? payload.source : "myworkdesk",
    });
    await addRecentDir(cwd);

    let sessionId: string | undefined;
    let chatInfoUpdated = false;
    if (ensureSession) {
      // 解绑旧会话，避免群描述/registry 仍指向错误 cwd 的 session
      try {
        const registry = await loadSessionRegistryForBinding();
        const old = registry[chatId];
        if (old?.sessionId) {
          unbindChatFromSession(old.sessionId, chatId);
        }
      } catch {
        /* ignore */
      }
      sessionInfoMap.delete(chatId);

      const init = await initClaudeSession(tool, cwd, chatId);
      sessionId = init.sessionId;

      bindChatToSession(sessionId, chatId);
      sessionInfoMap.set(chatId, {
        sessionId,
        turnCount: 0,
        lastContextTokens: 0,
        startTime: Date.now(),
        tool,
      });

      const name = chatName || `${toolDisplayName(tool)} · ${cwd}`;
      const desc = `${sessionPrefixForTool(tool)} ${sessionId}`;

      // 先写 registry：即便改群资料失败，消息路由仍可按 chatId 落到正确 session
      await recordSessionRegistry({
        chatId,
        sessionId,
        tool,
        chatName: name,
        turnCount: 0,
        startTime: Date.now(),
        running: false,
      });
      await saveSessionTool(sessionId, tool, name);

      try {
        const token = await getTenantAccessToken();
        await updateChatInfo(token, chatId, name, desc);
        chatInfoUpdated = true;
      } catch (err) {
        const msg = (err as Error).message || "";
        console.warn(
          `[${ts()}] [bind-chat-cwd] updateChatInfo failed chat=${chatId}: ${msg}`,
        );
        if (/dissolved|232009|not found|不存在/i.test(msg)) {
          jsonReply(res, 409, {
            ok: false,
            error: "chat_dissolved",
            message: msg,
            chat_id: chatId,
            cwd,
            session_id: sessionId,
            lock,
          });
          return true;
        }
      }

      try {
        const token = await getTenantAccessToken();
        await applyGroupChatTag(token, chatId, cwd);
      } catch (err) {
        console.warn(
          `[${ts()}] [bind-chat-cwd] bindGroupTag failed chat=${chatId}: ${(err as Error).message}`,
        );
      }
    }

    console.log(
      `[${ts()}] [bind-chat-cwd] chat=${chatId} cwd=${cwd} lock=${lock} session=${sessionId || "(none)"} chatInfo=${chatInfoUpdated}`,
    );

    jsonReply(res, 200, {
      ok: true,
      chat_id: chatId,
      cwd,
      lock,
      session_id: sessionId || null,
      tool,
      chat_info_updated: chatInfoUpdated,
    });
  } catch (err) {
    console.error(`[${ts()}] [bind-chat-cwd] FAIL: ${(err as Error).message}`);
    jsonReply(res, 500, { ok: false, error: (err as Error).message });
  }
  return true;
}
