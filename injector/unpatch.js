/**
 * Restore original app.asar from app.asar.bak.
 *
 * Usage: node unpatch.js
 */
const fs = require("node:fs");
const path = require("node:path");

const ASAR_PATH = path.join(
  process.env.LOCALAPPDATA || "",
  "Programs",
  "antigravity",
  "resources",
  "app.asar"
);
const BAK_PATH = ASAR_PATH + ".bak";

function main() {
  if (!fs.existsSync(BAK_PATH)) {
    console.error("❌ 未找到备份文件 app.asar.bak：", BAK_PATH);
    process.exit(1);
  }

  try {
    console.log("🔄 正在从备份恢复原始 app.asar ...");
    fs.copyFileSync(BAK_PATH, ASAR_PATH);
    console.log("✅ 成功还原原始客户端文件！已移除内置监控面板。");
  } catch (err) {
    console.error("❌ 还原失败：", err.message);
    if (err.message.includes("EBUSY") || err.message.includes("locked")) {
      console.error("💡 提示：文件可能正被运行中的 Antigravity 占用，请彻底退出 Antigravity 客户端后重试。");
    }
  }
}

main();
