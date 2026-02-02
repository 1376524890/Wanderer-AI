/* 用途：启动辩论监控仪表盘的 CLI 入口。
不负责：运行辩论主循环。
输入：来自 .env 的环境变量。
输出：实时终端仪表盘直到被中断。
关联：src/monitor.js, src/config.js。
*/

const { loadConfig } = require("./src/config");
const { Monitor } = require("./src/monitor");

function main() {
  const config = loadConfig();
  const monitor = new Monitor(config);
  monitor.run();
}

main();
