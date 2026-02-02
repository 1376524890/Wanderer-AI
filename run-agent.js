/* 用途：启动双代理辩论主循环的 CLI 入口。
不负责：渲染监控界面。
输入：来自 .env 的环境变量。
输出：运行辩论直到被中断。
关联：src/agent.js, src/config.js, src/logger.js。
*/

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { loadConfig } = require("./src/config");
const { createLogger } = require("./src/logger");
const { DebateAgent } = require("./src/agent");

const ENV_FILE = ".env";

function isProcessAlive(pid) {
  if (!pid || !Number.isFinite(Number(pid))) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (err) {
    return false;
  }
}

function acquireLock(lockPath) {
  const payload = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }, null, 2);
  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(fd, payload, "utf8");
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }

  let existing = null;
  try {
    existing = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch (err) {
    existing = null;
  }

  if (existing && isProcessAlive(existing.pid)) {
    console.log(`\n⚠️  检测到已有运行中的辩论进程 (pid ${existing.pid})。为避免 API 并发限制，本次启动已取消。`);
    console.log("如需重新启动，请先停止已有进程或删除锁文件。\n");
    return false;
  }

  fs.writeFileSync(lockPath, payload, "utf8");
  return true;
}

function setupLockCleanup(lockPath) {
  const cleanup = () => {
    try {
      if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    } catch (err) {
      // ignore cleanup errors
    }
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  process.on("uncaughtException", (err) => {
    cleanup();
    throw err;
  });
}

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
  fs.mkdirSync(config.stateDir, { recursive: true });
  const lockPath = path.join(config.stateDir, "agent.lock");
  if (!acquireLock(lockPath)) {
    process.exit(1);
  }
  setupLockCleanup(lockPath);

  console.log("\n🗣️  Debate Agents - 双代理永续辩论\n");
  console.log(`📌 配置:`);
  console.log(`   - API: ${config.vllmBaseUrl}`);
  console.log(`   - Model: ${config.vllmModel}`);
  console.log(`   - API Key: ${config.vllmApiKey ? "***" + config.vllmApiKey.slice(-4) : "未设置"}`);
  console.log(`   - 身份更新间隔: ${config.identityUpdateInterval} 轮`);
  console.log("");

  config = await checkApiKey(config);

  const logger = createLogger(config);
  const agent = new DebateAgent(config, logger);

  console.log("\n✅ 辩论引擎已启动，正在运行...\n");
  await agent.runForever();
}

main();
