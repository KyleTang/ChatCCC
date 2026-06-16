import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const { TEST_DATA_DIR } = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || "/tmp";
  return {
    TEST_DATA_DIR: `${base}/chatccc-feishu-tag-${process.pid}-${Date.now()}`,
  };
});

vi.mock("../config.ts", async () => {
  const actual = await vi.importActual<typeof import("../config.ts")>("../config.ts");
  return {
    ...actual,
    USER_DATA_DIR: TEST_DATA_DIR,
    BASE_URL: "https://open.feishu.cn/open-apis",
    ts: () => "test-ts",
  };
});

import {
  applyGroupChatTag,
  buildGroupChatTagName,
  createOrGetTenantTag,
  FEISHU_GROUP_TAG_NAME,
  projectNameFromCwd,
} from "../feishu-api.ts";

describe("feishu chat tag", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it("buildGroupChatTagName is always chatccc regardless of cwd", () => {
    expect(FEISHU_GROUP_TAG_NAME).toBe("chatccc");
    expect(buildGroupChatTagName("D:\\work\\ChatCCC")).toBe("chatccc");
    expect(buildGroupChatTagName("/home/user/repo/")).toBe("chatccc");
    expect(buildGroupChatTagName()).toBe("chatccc");
  });

  it("projectNameFromCwd still parses basename for debug logging", () => {
    expect(projectNameFromCwd("D:\\work\\very\\long\\path\\ChatCCC")).toBe("ChatCCC");
    expect(projectNameFromCwd("/home/user/projects/demo")).toBe("demo");
  });

  it("createOrGetTenantTag creates tag and caches id", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce({
      json: async () => ({
        code: 0,
        data: { id: "tag-123" },
      }),
    } as Response);

    const id = await createOrGetTenantTag("token", "chatccc");
    expect(id).toBe("tag-123");

    fetchMock.mockResolvedValueOnce({
      json: async () => ({ code: 0, data: { id: "tag-should-not-use" } }),
    } as Response);
    const cached = await createOrGetTenantTag("token", "chatccc");
    expect(cached).toBe("tag-123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("createOrGetTenantTag reuses duplicate_id when name exists", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      json: async () => ({
        code: 0,
        data: { create_tag_fail_reason: { duplicate_id: "tag-dup" } },
      }),
    } as Response);

    const id = await createOrGetTenantTag("token", "chatccc");
    expect(id).toBe("tag-dup");
  });

  it("applyGroupChatTag creates tag then binds to chat", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce({
        json: async () => ({ code: 0, data: { id: "tag-abc" } }),
      } as Response)
      .mockResolvedValueOnce({
        json: async () => ({ code: 0, data: {} }),
      } as Response);

    await applyGroupChatTag("token", "oc_test", "D:\\work\\ChatCCC");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const createBody = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(createBody.create_tag.name).toBe("chatccc");

    const bindBody = JSON.parse(
      (fetchMock.mock.calls[1][1] as RequestInit).body as string,
    );
    expect(bindBody).toEqual({
      tag_biz_type: "chat",
      biz_entity_id: "oc_test",
      tag_ids: ["tag-abc"],
    });
  });

  it("persists tag id mapping under USER_DATA_DIR/state", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      json: async () => ({ code: 0, data: { id: "tag-persist" } }),
    } as Response);

    await createOrGetTenantTag("token", "chatccc");

    const raw = await readFile(
      join(TEST_DATA_DIR, "state", "feishu-tag-cache.json"),
      "utf-8",
    );
    expect(JSON.parse(raw)).toEqual({ chatccc: "tag-persist" });
  });
});
