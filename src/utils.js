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
  return truncate(data, maxChars);
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

module.exports = {
  parseBool,
  parseIntValue,
  parseFloatValue,
  ensureDir,
  nowIso,
  truncate,
  readTail,
  safeJsonExtract,
  formatUtc8
};
