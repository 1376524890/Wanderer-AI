/* 用途：提供跨模块复用的通用工具函数。
不负责：业务决策、网络请求或界面渲染。
输入：字符串、路径、配置值。
输出：解析后的值、截断文本与文件内容。
关联：src/config.js, src/journal.js, src/agent.js。
*/

const fs = require("fs");
const path = require("path");

function parseBool(value, defaultValue = false) {
  if (value === undefined || value === null) return defaultValue;
  return String(value).trim().toLowerCase() in { "1": true, "true": true, "yes": true, "y": true, "on": true };
}

function parseIntValue(value, defaultValue) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

function parseFloatValue(value, defaultValue) {
  const parsed = Number.parseFloat(value);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function truncate(text, maxChars) {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 3)) + "...";
}

function readTail(filePath, maxChars) {
  if (!fs.existsSync(filePath)) return "";
  const data = fs.readFileSync(filePath, "utf8");
  if (!maxChars || data.length <= maxChars) return data;
  return data.slice(-maxChars);
}

function safeJsonExtract(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    // continue
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    return null;
  }
}

function safeSnippet(text, maxChars) {
  if (!text) return "";
  const trimmed = String(text).trim();
  if (!maxChars || trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, Math.max(0, maxChars - 3)) + "...";
}

function countExperienceItems(text) {
  if (!text) return 0;
  return String(text)
    .split(/\r?\n/)
    .filter((line) => /^\s*-\s*[AB]\s*:/.test(line)).length;
}

function compressExperienceSection(text, maxItems = 10, maxChars = 900) {
  if (!text) return "";
  const lines = String(text).split(/\r?\n/);
  const summaryLines = [];
  const bullets = [];

  for (const line of lines) {
    if (/^\s*-\s*[AB]\s*:/.test(line)) {
      bullets.push(line.replace(/^\s*-\s+/, "").trim());
    } else if (line.trim()) {
      if (summaryLines.length < 3) summaryLines.push(line.trim());
    }
  }

  const picked = bullets.slice(-Math.max(1, maxItems));
  const summary = [
    "【经验压缩摘要】",
    summaryLines.length ? summaryLines.join(" | ") : "综合本段经验要点，保留可执行策略。",
    ...picked.map((item, index) => `- (${index + 1}) ${item}`)
  ].join("\n");

  return safeSnippet(summary, maxChars);
}

function formatUtc8(date = new Date()) {
  const utc8 = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  const yyyy = utc8.getUTCFullYear();
  const mm = pad(utc8.getUTCMonth() + 1);
  const dd = pad(utc8.getUTCDate());
  const hh = pad(utc8.getUTCHours());
  const mi = pad(utc8.getUTCMinutes());
  const ss = pad(utc8.getUTCSeconds());
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss} UTC+8`;
}

function normalizeForSimilarity(text) {
  if (!text) return "";
  return String(text)
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^\u4e00-\u9fa5a-z0-9]/gi, "");
}

function buildNgrams(text, n = 2, max = 400) {
  const source = normalizeForSimilarity(text);
  if (!source || source.length < n) return new Set();
  const grams = new Set();
  for (let i = 0; i <= source.length - n; i += 1) {
    grams.add(source.slice(i, i + n));
    if (grams.size >= max) break;
  }
  return grams;
}

function textSimilarity(a, b) {
  const gramsA = buildNgrams(a);
  const gramsB = buildNgrams(b);
  if (!gramsA.size || !gramsB.size) return 0;
  let intersection = 0;
  for (const gram of gramsA) {
    if (gramsB.has(gram)) intersection += 1;
  }
  const union = gramsA.size + gramsB.size - intersection;
  if (!union) return 0;
  return intersection / union;
}

module.exports = {
  parseBool,
  parseIntValue,
  parseFloatValue,
  ensureDir,
  nowIso,
  truncate,
  readTail,
  safeJsonExtract,
  safeSnippet,
  countExperienceItems,
  compressExperienceSection,
  formatUtc8,
  normalizeForSimilarity,
  buildNgrams,
  textSimilarity
};
