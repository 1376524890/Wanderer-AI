/* 用途：启动自主探索代理主循环的 CLI 入口。
不负责：渲染监控界面。
输入：来自 .env 的环境变量。
输出：运行代理直到被中断。
关联：src/agent.js, src/config.js, src/logger.js。
*/

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { loadConfig } = require("./src/config");
const { createLogger } = require("./src/logger");
const { Agent } = require("./src/agent");

const ENV_FILE = ".env";

function checkApiKey(config) {
  if (!config.vllmApiKey || config.vllmApiKey === "your-zhipu-api-key-here") {
    console.log("\n⚠️  未检测到有效的 ZHIPU_API_KEY");
    console.log("请按照提示配置 API Key\n");

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    return new Promise((resolve) => {
      rl.question("请输入您的智谱 AI API Key: ", (apiKey) => {
        if (!apiKey || apiKey.trim() === "") {
          console.log("\n❌ 未提供 API Key，程序退出");
          rl.close();
          process.exit(1);
        }

        rl.question("是否将 API Key 保存到 .env 文件？(y/N): ", (save) => {
          if (save.trim().toLowerCase() === "y") {
            try {
              let envContent = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
              const keyLine = `VLLM_API_KEY=${apiKey.trim()}`;
              const regex = /^VLLM_API_KEY=.*/m;

              if (regex.test(envContent)) {
                envContent = envContent.replace(regex, keyLine);
              } else {
                envContent += `\n${keyLine}`;
              }

              fs.writeFileSync(ENV_FILE, envContent, "utf8");
              console.log("✅ API Key 已保存到 .env 文件");
            } catch (err) {
              console.log(`❌ 保存失败: ${err.message}`);
            }
          }

          rl.close();
          config.vllmApiKey = apiKey.trim();
          resolve(config);
        });
      });
    });
  }
  return Promise.resolve(config);
}

async function main() {
  let config = loadConfig();

  console.log("\n🚀 Wanderer AI - 自主探索代理\n");
  console.log(`📌 配置:`);
  console.log(`   - API: ${config.vllmBaseUrl}`);
  console.log(`   - Model: ${config.vllmModel}`);
  console.log(`   - API Key: ${config.vllmApiKey ? "***" + config.vllmApiKey.slice(-4) : "未设置"}`);
  console.log("");

  config = await checkApiKey(config);

  const logger = createLogger(config);
  const agent = new Agent(config, logger);

  console.log("\n✅ 代理已启动，正在运行...\n");
  await agent.runForever();
}

main();
