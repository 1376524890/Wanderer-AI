/* 用途：启动 Web 监控面板服务。
不负责：运行辩论主循环或 CLI 监控。
输入：.env 环境变量。
输出：HTTP 服务进程。
关联：src/webServer.js, src/config.js。
*/

require("./src/webServer");
