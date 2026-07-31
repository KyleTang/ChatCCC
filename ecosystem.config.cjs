module.exports = {
    apps: [{
      name: "chatccc",
      cwd: "D:/wsl/ChatCCC",
      script: "src/index.ts",
      interpreter: "node",
      node_args: "--import tsx",   // Node 20+ 直接加载 tsx，少一层 cli 包装
      windowsHide: true,           // 关键：不弹黑窗口
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
    }],
  };