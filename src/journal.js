/* 用途：读取与追加 Markdown 探索日志。
不负责：决定代理要做什么。
输入：日志条目与上下文长度限制。
输出：更新后的日志文件与上下文摘要。
关联：src/agent.js, src/prompts.js。
*/

const fs = require("fs");
const path = require("path");
const { ensureDir, readTail, truncate } = require("./utils");

class Journal {
  constructor(journalDir) {
    this.journalDir = journalDir;
    ensureDir(journalDir);
  }

  appendEntry(nowWork, outcomes, nextPlan) {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const time = now.toISOString().slice(11, 19) + " UTC";
    const entry = [
      `## ${time}`,
      "",
      "**正在进行的工作**",
      String(nowWork || "").trim(),
      "",
      "**达成的成果**",
      String(outcomes || "").trim(),
      "",
      "**下一步计划**",
      String(nextPlan || "").trim(),
      "",
      ""
    ].join("\n");
    const filePath = path.join(this.journalDir, `${day}.md`);
    fs.appendFileSync(filePath, entry, "utf8");
    return { filePath, entry };
  }

  readRecentContext(maxChars) {
    if (!fs.existsSync(this.journalDir)) return "(No history yet)";
    const files = fs.readdirSync(this.journalDir)
      .filter((name) => name.endsWith(".md") && name !== "README.md")
      .sort()
      .map((name) => path.join(this.journalDir, name));
    if (!files.length) return "(No history yet)";

    const collected = [];
    let remaining = maxChars;
    const recentFiles = files.slice(-3).reverse();
    for (const filePath of recentFiles) {
      let content = readTail(filePath, maxChars);
      content = truncate(content, remaining);
      if (content) {
        collected.push(`### ${path.basename(filePath)}\n${content}`);
        remaining -= content.length;
      }
      if (remaining <= 0) break;
    }
    return collected.reverse().join("\n\n");
  }
}

module.exports = { Journal };
