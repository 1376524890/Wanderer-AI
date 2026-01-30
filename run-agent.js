/* 用途：启动自主探索代理主循环的 CLI 入口。
不负责：渲染监控界面。
输入：来自 .env 的环境变量。
输出：运行代理直到被中断。
关联：src/agent.js, src/config.js。
*/

const { loadConfig } = require("./src/config");
const { Agent } = require("./src/agent");

async function main() {
  const config = loadConfig();
  const agent = new Agent(config);
  await agent.runForever();
}

main();
