新方式：用 ecosystem 配置

pm2 start ecosystem.config.cjs

旧方式

cd D:\wsl\ChatCCC
pm2 start node_modules/tsx/dist/cli.mjs --name chatccc --cwd D:\wsl\ChatCCC -- src/index.ts