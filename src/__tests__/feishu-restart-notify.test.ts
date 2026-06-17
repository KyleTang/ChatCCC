import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyLoadedConfig, config, type AppConfig } from "../config.ts";
import {
  _resetP2pOpenIdHintForTest,
  notifyFeishuP2pOpenId,
  printRestartNotifyStartupHint,
} from "../feishu-restart-notify.ts";

const minimalAppConfig = (feishu: AppConfig["feishu"]): AppConfig => ({
  feishu,
  platforms: { feishu: { enabled: true }, ilink: { enabled: true } },
  port: 18080,
  gitTimeoutSeconds: 180,
  allowInterrupt: false,
  claude: {
    enabled: false,
    defaultAgent: true,
    model: "",
    subagentModel: "",
    effort: "",
    apiKey: "",
    baseUrl: "",
    maxTurn: 0,
  },
  cursor: { enabled: false, defaultAgent: false, path: "", model: "" },
  codex: { enabled: false, defaultAgent: false, path: "", model: "", effort: "" },
  mimo: { enabled: false, defaultAgent: false, path: "", model: "", apiKey: "", baseUrl: "" },
  deveco: { enabled: false, defaultAgent: false, path: "", model: "", agent: "" },
});

describe("feishu-restart-notify", () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    _resetP2pOpenIdHintForTest();
    applyLoadedConfig(
      minimalAppConfig({
        appId: "app",
        appSecret: "secret",
        restartNotifyOpenId: "",
        restartNotify: "p2p",
        autoNewFromP2p: false,
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints configured open_id on startup when restartNotify=p2p", () => {
    applyLoadedConfig(
      minimalAppConfig({
        appId: "app",
        appSecret: "secret",
        restartNotifyOpenId: "ou_test_user",
        restartNotify: "p2p",
        autoNewFromP2p: false,
      }),
    );
    printRestartNotifyStartupHint();
    expect(logs.some((l) => l.includes("open_id=ou_test_user"))).toBe(true);
  });

  it("prompts user to send p2p message when open_id missing", () => {
    printRestartNotifyStartupHint();
    expect(logs.some((l) => l.includes("restartNotifyOpenId"))).toBe(true);
  });

  it("prints open_id hint once when p2p message received and not configured", () => {
    notifyFeishuP2pOpenId("ou_discovered");
    notifyFeishuP2pOpenId("ou_discovered");
    const hintLines = logs.filter((l) => l.includes("ou_discovered"));
    expect(hintLines.length).toBe(1);
  });

  it("does not print discovery hint when open_id already configured", () => {
    applyLoadedConfig(
      minimalAppConfig({
        appId: "app",
        appSecret: "secret",
        restartNotifyOpenId: "ou_existing",
        restartNotify: "p2p",
        autoNewFromP2p: false,
      }),
    );
    notifyFeishuP2pOpenId("ou_new_message");
    expect(logs.some((l) => l.includes("ou_new_message"))).toBe(false);
  });

  it("reports restartNotify=off on startup", () => {
    applyLoadedConfig(
      minimalAppConfig({
        appId: "app",
        appSecret: "secret",
        restartNotifyOpenId: "",
        restartNotify: "off",
        autoNewFromP2p: false,
      }),
    );
    printRestartNotifyStartupHint();
    expect(logs.some((l) => l.includes("restartNotify=off"))).toBe(true);
  });
});

describe("feishu.autoNewFromP2p config", () => {
  it("defaults autoNewFromP2p to false in loaded config object", () => {
    expect(config.feishu.autoNewFromP2p).toBe(false);
  });
});
