/* 用途：启动自主探索代理主循环的 CLI 入口。
不负责：渲染监控界面。
输入：来自 .env 的环境变量。
输出：运行代理直到被中断。
关联：src/agent.js, src/config.js, src/logger.js。
*/

const { loadConfig } = require("./src/config");
const { createLogger } = require("./src/logger");
const { Agent } = require("./src/agent");

async function main() {
  const config = loadConfig();
  const logger = createLogger(config);
  const agent = new Agent(config, logger);
  await agent.runForever();
}

main();
