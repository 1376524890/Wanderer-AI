/* 用途：提供统一的文件日志记录与滚动控制。
不负责：业务决策或提示词生成。
输入：日志级别、消息与可选元数据。
输出：写入日志文件并按大小滚动。
关联：src/agent.js, src/llmClient.js, src/config.js。
*/

const fs = require("fs");
const path = require("path");
const { ensureDir, truncate } = require("./utils");

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

function normalizeLevel(level) {
  const key = String(level || "info").toLowerCase();
  return LEVELS[key] !== undefined ? key : "info";
}

function createLogger(config) {
  const levelKey = normalizeLevel(config.logLevel || "info");
  const minLevel = LEVELS[levelKey];
  const logDir = config.logDir || "logs";
  const logFile = config.logFile || path.join(logDir, "wanderer.log");
  const maxBytes = Number.isFinite(config.logMaxBytes) ? config.logMaxBytes : 5 * 1024 * 1024;
  const maxFiles = Number.isFinite(config.logMaxFiles) ? config.logMaxFiles : 5;

  ensureDir(path.dirname(logFile));

  function rotateIfNeeded() {
    if (maxBytes <= 0) return;
    if (!fs.existsSync(logFile)) return;
    const size = fs.statSync(logFile).size;
    if (size < maxBytes) return;

    if (maxFiles <= 0) {
      fs.truncateSync(logFile, 0);
      return;
    }

    for (let i = maxFiles - 1; i >= 1; i -= 1) {
      const src = `${logFile}.${i}`;
      const dest = `${logFile}.${i + 1}`;
      if (fs.existsSync(src)) {
        fs.renameSync(src, dest);
      }
    }
    fs.renameSync(logFile, `${logFile}.1`);
  }

  function buildMeta(meta) {
    if (!meta || typeof meta !== "object") return undefined;
    const safeMeta = {};
    for (const [key, value] of Object.entries(meta)) {
      if (typeof value === "string") {
        safeMeta[key] = truncate(value, 2000);
      } else {
        safeMeta[key] = value;
      }
    }
    return Object.keys(safeMeta).length ? safeMeta : undefined;
  }

  function write(level, message, meta) {
    const levelKey = normalizeLevel(level);
    if (LEVELS[levelKey] < minLevel) return;

    rotateIfNeeded();
    const record = {
      ts: new Date().toISOString(),
      level: levelKey,
      message: String(message || "")
    };
    const safeMeta = buildMeta(meta);
    if (safeMeta) record.meta = safeMeta;

    fs.appendFileSync(logFile, `${JSON.stringify(record)}\n`, "utf8");
  }

  return {
    debug: (message, meta) => write("debug", message, meta),
    info: (message, meta) => write("info", message, meta),
    warn: (message, meta) => write("warn", message, meta),
    error: (message, meta) => write("error", message, meta)
  };
}

module.exports = { createLogger };
