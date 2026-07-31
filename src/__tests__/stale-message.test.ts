import { describe, expect, it } from "vitest";
import {
  isMessageTooDelayed,
  normalizeMessageCreateTimeMs,
  STALE_MESSAGE_MAX_DELAY_MS,
} from "../feishu-api.ts";

describe("stale message gate", () => {
  it("normalizeMessageCreateTimeMs 兼容秒级时间戳", () => {
    expect(normalizeMessageCreateTimeMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(normalizeMessageCreateTimeMs(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it("延迟超过 30 秒判定为过期", () => {
    const now = 1_800_000_000_000;
    expect(isMessageTooDelayed(now - 29_000, now)).toBe(false);
    expect(isMessageTooDelayed(now - 30_000, now)).toBe(false);
    expect(isMessageTooDelayed(now - 30_001, now)).toBe(true);
    expect(STALE_MESSAGE_MAX_DELAY_MS).toBe(30_000);
  });
});
