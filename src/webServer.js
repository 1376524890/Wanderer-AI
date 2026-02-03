/* 用途：提供 Web UI 静态资源与实时 API（状态/身份/对话流）。
不负责：运行辩论主循环或 CLI 监控。
输入：state/ 输出文件与 .env 配置。
输出：HTTP + SSE 实时接口。
关联：src/config.js, src/utils.js。
*/

const http = require("http");
const fs = require("fs");
const path = require("path");
const { loadConfig } = require("./config");

const config = loadConfig();

const ROOT_DIR = path.join(__dirname, "..");
const STATIC_DIR = path.join(ROOT_DIR, "web");
const PORT = Number.parseInt(process.env.WEB_PORT || "3000", 10);
const HOST = process.env.WEB_HOST || "0.0.0.0";

const stateDir = config.stateDir;
const identityDir = config.identityDir || stateDir;
const statusPath = path.join(stateDir, "status.json");
const conversationPath = path.join(stateDir, "conversation.log");
const identityAPath = path.join(identityDir, config.identityAFile || "identity_a.md");
const identityBPath = path.join(identityDir, config.identityBFile || "identity_b.md");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const conversationCache = {
  mtimeMs: 0,
  size: 0,
  entries: []
};

const clients = new Set();

function sendJson(res, statusCode, data) {
  const payload = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(payload);
}

function sendText(res, statusCode, body, type) {
  res.writeHead(statusCode, {
    "Content-Type": type || "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(body);
}

function readTextSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return "";
    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    return "";
  }
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    return {};
  }
}

function parseConversation(text) {
  const lines = String(text || "").split(/\r?\n/);
  const entries = [];
  let current = null;

  const startEntry = (type, line) => {
    if (current) entries.push(current);
    current = { type, lines: [line] };
  };

  const flush = () => {
    if (current) entries.push(current);
    current = null;
  };

  for (const line of lines) {
    if (/^===\s*Round\s+\d+/i.test(line)) {
      startEntry("round", line);
      continue;
    }
    if (/^\[[^\]]+\]\s+[AB]\s+\(Round\s+\d+\)/.test(line)) {
      startEntry("message", line);
      continue;
    }
    if (!current) {
      if (line.trim()) {
        startEntry("text", line);
      }
      continue;
    }
    current.lines.push(line);
  }

  flush();

  return entries
    .map((entry, index) => formatEntry(entry, index + 1))
    .filter(Boolean);
}

function formatEntry(entry, id) {
  const first = entry.lines[0] || "";
  if (entry.type === "round") {
    const match = first.match(/Round\s+(\d+)/i);
    const topicMatch = first.match(/\|\s*Topic:\s*(.*)\s*===/i);
    return {
      id,
      type: "round",
      round: match ? Number.parseInt(match[1], 10) : null,
      topic: topicMatch ? topicMatch[1] : "",
      title: first.trim()
    };
  }

  if (entry.type === "message") {
    const headerMatch = first.match(/^\[([^\]]+)\]\s+([AB])\s+\(Round\s+(\d+)\)/);
    const timestamp = headerMatch ? headerMatch[1] : "";
    const agent = headerMatch ? headerMatch[2] : "";
    const round = headerMatch ? Number.parseInt(headerMatch[3], 10) : null;
    let topic = "";
    let bodyLines = entry.lines.slice(1);
    if (bodyLines.length && /^Topic:\s*/.test(bodyLines[0])) {
      topic = bodyLines[0].replace(/^Topic:\s*/, "").trim();
      bodyLines = bodyLines.slice(1);
    }
    const body = bodyLines.join("\n").trim();
    return {
      id,
      type: "message",
      agent,
      round,
      timestamp,
      topic,
      body
    };
  }

  return {
    id,
    type: "text",
    title: first.trim(),
    body: entry.lines.slice(1).join("\n").trim()
  };
}

function loadConversation() {
  if (!fs.existsSync(conversationPath)) {
    conversationCache.entries = [];
    conversationCache.mtimeMs = 0;
    conversationCache.size = 0;
    return conversationCache.entries;
  }
  try {
    const stat = fs.statSync(conversationPath);
    if (stat.mtimeMs === conversationCache.mtimeMs && stat.size === conversationCache.size) {
      return conversationCache.entries;
    }
    const text = fs.readFileSync(conversationPath, "utf8");
    conversationCache.entries = parseConversation(text);
    conversationCache.mtimeMs = stat.mtimeMs;
    conversationCache.size = stat.size;
    return conversationCache.entries;
  } catch (err) {
    return conversationCache.entries || [];
  }
}

function getConversationSlice(beforeId, limit) {
  const entries = loadConversation();
  const total = entries.length;
  const safeLimit = Math.max(1, Math.min(Number.parseInt(limit || "50", 10) || 50, 200));
  let endIndex = total;
  if (beforeId) {
    const before = Number.parseInt(beforeId, 10);
    if (Number.isFinite(before)) {
      endIndex = Math.max(0, Math.min(before - 1, total));
    }
  }
  const startIndex = Math.max(0, endIndex - safeLimit);
  const slice = entries.slice(startIndex, endIndex);
  return {
    entries: slice,
    hasMore: startIndex > 0,
    lastId: total
  };
}

function loadStatus() {
  const status = readJsonSafe(statusPath);
  return {
    ...status,
    server_time: new Date().toISOString()
  };
}

function loadIdentities() {
  return {
    identityA: readTextSafe(identityAPath).trim(),
    identityB: readTextSafe(identityBPath).trim()
  };
}

function serveStatic(req, res, pathname) {
  let filePath = path.normalize(path.join(STATIC_DIR, pathname));
  if (!filePath.startsWith(STATIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, "index.html");
  }

  if (!fs.existsSync(filePath)) {
    sendText(res, 404, "Not Found");
    return;
  }

  try {
    const ext = path.extname(filePath);
    const type = mimeTypes[ext] || "application/octet-stream";
    const data = fs.readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-store"
    });
    res.end(data);
  } catch (err) {
    sendText(res, 500, "Internal Server Error");
  }
}

function sendEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function handleStream(req, res, query) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*"
  });
  res.write("\n");

  const client = {
    res,
    lastEntryId: 0,
    lastStatusHash: "",
    lastIdentityHash: "",
    lastHeartbeat: Date.now()
  };

  const cursor = Number.parseInt(query.cursor || "0", 10);
  if (Number.isFinite(cursor) && cursor > 0) {
    client.lastEntryId = cursor;
  }

  clients.add(client);

  const snapshotEntries = getConversationSlice(null, 80);
  sendEvent(res, "snapshot", {
    status: loadStatus(),
    identities: loadIdentities(),
    entries: snapshotEntries.entries,
    lastEntryId: snapshotEntries.lastId,
    hasMore: snapshotEntries.hasMore
  });

  client.lastEntryId = snapshotEntries.lastId;
  client.lastStatusHash = JSON.stringify(loadStatus());
  client.lastIdentityHash = JSON.stringify(loadIdentities());

  req.on("close", () => {
    clients.delete(client);
  });
}

function broadcastUpdates() {
  if (clients.size === 0) return;
  const status = loadStatus();
  const identities = loadIdentities();
  const entries = loadConversation();
  const statusHash = JSON.stringify(status);
  const identityHash = JSON.stringify(identities);
  const now = Date.now();

  for (const client of clients) {
    const { res } = client;
    if (statusHash !== client.lastStatusHash) {
      sendEvent(res, "status", status);
      client.lastStatusHash = statusHash;
    }

    if (identityHash !== client.lastIdentityHash) {
      sendEvent(res, "identities", identities);
      client.lastIdentityHash = identityHash;
    }

    if (entries.length < client.lastEntryId) {
      client.lastEntryId = 0;
    }
    if (entries.length > client.lastEntryId) {
      const newEntries = entries.slice(client.lastEntryId);
      sendEvent(res, "entries", {
        entries: newEntries,
        lastEntryId: entries.length
      });
      client.lastEntryId = entries.length;
    }

    if (now - client.lastHeartbeat > 15000) {
      sendEvent(res, "heartbeat", { now: new Date().toISOString() });
      client.lastHeartbeat = now;
    }
  }
}

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname || "/";

  if (pathname.startsWith("/api/")) {
    if (pathname === "/api/status") {
      return sendJson(res, 200, loadStatus());
    }
    if (pathname === "/api/identities") {
      return sendJson(res, 200, loadIdentities());
    }
    if (pathname === "/api/conversation") {
      const before = urlObj.searchParams.get("before");
      const limit = urlObj.searchParams.get("limit") || "50";
      return sendJson(res, 200, getConversationSlice(before, limit));
    }
    if (pathname === "/api/stream") {
      handleStream(req, res, {
        cursor: urlObj.searchParams.get("cursor")
      });
      return;
    }
    return sendJson(res, 404, { error: "Not Found" });
  }

  const safePath = pathname === "/" ? "/index.html" : pathname;
  serveStatic(req, res, safePath);
});

server.listen(PORT, HOST, () => {
  console.log(`[web] UI server listening on http://${HOST}:${PORT}`);
});

setInterval(broadcastUpdates, 1000);

module.exports = { server };
