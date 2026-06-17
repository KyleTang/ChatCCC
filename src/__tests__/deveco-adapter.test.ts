import { describe, it, expect } from "vitest";
import {
  normalizeDevecoMessage,
  createDevecoAdapter,
} from "../adapters/deveco-adapter.ts";
import {
  type DevecoSessionMeta,
  type DevecoSessionMetaStore,
} from "../adapters/deveco-session-meta-store.ts";

function createInMemoryMetaStore(
  initial: Record<string, DevecoSessionMeta> = {},
): DevecoSessionMetaStore & { snapshot(): Record<string, DevecoSessionMeta> } {
  const map = new Map<string, DevecoSessionMeta>(Object.entries(initial));
  return {
    async get(sid) {
      return map.get(sid);
    },
    async set(sid, partial) {
      const existing = map.get(sid) ?? { cwd: "" };
      const merged: DevecoSessionMeta = { ...existing, ...partial };
      if (typeof merged.cwd !== "string" || merged.cwd.length === 0) return;
      map.set(sid, merged);
    },
    async setThreadId(sid, threadId) {
      const existing = map.get(sid);
      if (existing) {
        map.set(sid, { ...existing, threadId });
      }
    },
    snapshot() {
      return Object.fromEntries(map);
    },
  };
}

describe("normalizeDevecoMessage", () => {
  it("maps text event to assistant text block", () => {
    const result = normalizeDevecoMessage({
      type: "text",
      sessionID: "sess-1",
      part: { type: "text", text: "hello harmony" },
    });
    expect(result).not.toBeNull();
    expect(result!.blocks).toEqual([{ type: "text", text: "hello harmony" }]);
  });

  it("maps reasoning event to thinking block", () => {
    const result = normalizeDevecoMessage({
      type: "reasoning",
      part: { type: "reasoning", text: "thinking..." },
    });
    expect(result!.blocks).toEqual([{ type: "thinking", thinking: "thinking..." }]);
  });

  it("maps completed tool_use to tool_use + tool_result", () => {
    const result = normalizeDevecoMessage({
      type: "tool_use",
      part: {
        type: "tool",
        callID: "call-1",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "hvigorw assembleApp" },
          output: "BUILD SUCCESS",
        },
      },
    });
    expect(result!.blocks).toEqual([
      {
        type: "tool_use",
        id: "call-1",
        name: "bash",
        input: { command: "hvigorw assembleApp" },
      },
      {
        type: "tool_result",
        tool_use_id: "call-1",
        content: "BUILD SUCCESS",
      },
    ]);
  });

  it("maps error tool_use to tool_result with is_error", () => {
    const result = normalizeDevecoMessage({
      type: "tool_use",
      part: {
        type: "tool",
        callID: "call-2",
        tool: "build_project",
        state: {
          status: "error",
          input: {},
          error: "build failed",
        },
      },
    });
    expect(result!.blocks[1]).toEqual({
      type: "tool_result",
      tool_use_id: "call-2",
      content: "build failed",
      is_error: true,
    });
  });

  it("maps error event to text block", () => {
    const result = normalizeDevecoMessage({
      type: "error",
      error: { message: "session failed" },
    });
    expect(result!.blocks).toEqual([{ type: "text", text: "session failed" }]);
  });

  it("ignores step_start / step_finish", () => {
    expect(normalizeDevecoMessage({ type: "step_start", part: { type: "step-start" } })).toBeNull();
    expect(normalizeDevecoMessage({ type: "step_finish", part: { type: "step-finish" } })).toBeNull();
  });
});

describe("createDevecoAdapter", () => {
  it("createSession returns uuid and stores cwd", async () => {
    const store = createInMemoryMetaStore();
    const adapter = createDevecoAdapter({ metaStore: store });
    const { sessionId } = await adapter.createSession("/proj/harmony");
    expect(sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(await adapter.getSessionInfo(sessionId)).toEqual({
      sessionId,
      cwd: "/proj/harmony",
    });
  });

  it("exposes display name and session prefix", () => {
    const adapter = createDevecoAdapter();
    expect(adapter.displayName).toBe("Deveco Code");
    expect(adapter.sessionDescPrefix).toBe("Deveco Code Session:");
  });
});
