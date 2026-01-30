/* 用途：从环境变量加载并校验配置。
不负责：运行代理循环或渲染界面。
输入：环境变量与可选的 .env 文件。
输出：带类型字段的配置对象。
关联：src/agent.js, src/llmClient.js, src/monitor.js。
*/

const dotenv = require("dotenv");
const { parseBool, parseFloatValue, parseIntValue } = require("./utils");

dotenv.config();

function loadConfig() {
  const commandAllowlistRaw = (process.env.COMMAND_ALLOWLIST || "").trim();
  const allowlist = commandAllowlistRaw
    ? commandAllowlistRaw.split(",").map((item) => item.trim()).filter(Boolean)
    : [];

  return {
    vllmBaseUrl: process.env.VLLM_BASE_URL || "http://vllm.plk161211.top",
    vllmModel: process.env.VLLM_MODEL || "qwen3-8b",
    vllmApiKey: process.env.VLLM_API_KEY || "",
    temperature: parseFloatValue(process.env.TEMPERATURE, 0.4),
    topP: parseFloatValue(process.env.TOP_P, 0.9),
    maxTokens: parseIntValue(process.env.MAX_TOKENS, 512),
    requestTimeoutSeconds: parseIntValue(process.env.REQUEST_TIMEOUT_SECONDS, 60),
    maxRetries: parseIntValue(process.env.MAX_RETRIES, 12),
    retryBaseSeconds: parseFloatValue(process.env.RETRY_BASE_SECONDS, 2),
    retryMaxSeconds: parseFloatValue(process.env.RETRY_MAX_SECONDS, 90),
    retryBackoffMultiplier: parseFloatValue(process.env.RETRY_BACKOFF_MULTIPLIER, 2),
    retryJitterSeconds: parseFloatValue(process.env.RETRY_JITTER_SECONDS, 1.5),
    loopSleepSeconds: parseIntValue(process.env.LOOP_SLEEP_SECONDS, 10),
    contextMaxChars: parseIntValue(process.env.CONTEXT_MAX_CHARS, 6000),
    allowCommandExecution: parseBool(process.env.ALLOW_COMMAND_EXECUTION, true),
    allowUnsafeCommands: parseBool(process.env.ALLOW_UNSAFE_COMMANDS, true),
    commandAllowlist: allowlist,
    maxCommandsPerCycle: parseIntValue(process.env.MAX_COMMANDS_PER_CYCLE, 0),
    commandTimeoutSeconds: parseIntValue(process.env.COMMAND_TIMEOUT_SECONDS, 300),
    pythonBin: process.env.PYTHON_BIN || "python3",
    journalDir: process.env.JOURNAL_DIR || "journal",
    stateDir: process.env.STATE_DIR || "state",
    logLevel: process.env.LOG_LEVEL || "INFO",
    logDir: process.env.LOG_DIR || "logs",
    logFile: process.env.LOG_FILE || "",
    logMaxBytes: parseIntValue(process.env.LOG_MAX_BYTES, 5 * 1024 * 1024),
    logMaxFiles: parseIntValue(process.env.LOG_MAX_FILES, 5)
  };
}

module.exports = { loadConfig };
