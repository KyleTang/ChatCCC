/**
 * 飞书启动通知与私聊 open_id 发现提示。
 */

import { CONFIG_FILE, config } from "./config.ts";

let p2pOpenIdHintPrinted = false;

/** 测试用：重置「已打印 open_id 提示」标记 */
export function _resetP2pOpenIdHintForTest(): void {
  p2pOpenIdHintPrinted = false;
}

/** 飞书 WebSocket 就绪后打印 restartNotify / open_id 配置状态 */
export function printRestartNotifyStartupHint(): void {
  const mode = config.feishu.restartNotify;
  const openId = config.feishu.restartNotifyOpenId.trim();

  console.log(`[CONFIG] 飞书启动通知: restartNotify=${mode}`);

  if (mode === "off") {
    console.log("[CONFIG] 启动通知已关闭 (feishu.restartNotify=off)");
    return;
  }

  if (mode === "p2p") {
    if (openId) {
      console.log(`[CONFIG] 重启通知将发送到机器人私聊，open_id=${openId}`);
    } else {
      console.log("[CONFIG] 未配置 feishu.restartNotifyOpenId");
      console.log("       请在飞书机器人私聊中发送任意消息，服务端将打印你的 open_id；");
      console.log(`       填入 ${CONFIG_FILE} 的 feishu.restartNotifyOpenId 后重启生效。`);
    }
    return;
  }

  console.log("[CONFIG] 重启通知将发送到最近有消息的会话 (feishu.restartNotify=last)");
}

/**
 * 收到飞书私聊消息且尚未配置 restartNotifyOpenId 时，在控制台打印 open_id 与配置提示（每进程一次）。
 */
export function notifyFeishuP2pOpenId(openId: string): void {
  const trimmed = openId.trim();
  if (!trimmed) return;
  if (config.feishu.restartNotifyOpenId.trim()) return;
  if (p2pOpenIdHintPrinted) return;

  p2pOpenIdHintPrinted = true;
  console.log(`[P2P] 检测到飞书私聊，你的 open_id: ${trimmed}`);
  console.log(`      可将此值写入 ${CONFIG_FILE} → feishu.restartNotifyOpenId`);
  console.log('      并设置 feishu.restartNotify 为 "p2p"（若尚未设置），保存后重启 ChatCCC 生效。');
}
