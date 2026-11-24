/**
 * Permanently patch Antigravity's app.asar so the usage panel is loaded natively.
 * Automatically backs up app.asar to app.asar.bak before modifying.
 *
 * Usage: node patch.js
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execSync } = require("node:child_process");

const HERE = __dirname;
const PANEL_FILE = path.join(HERE, "panel.js");
const ASAR_PATH = path.join(
  process.env.LOCALAPPDATA || "",
  "Programs",
  "antigravity",
  "resources",
  "app.asar"
);
const BAK_PATH = ASAR_PATH + ".bak";

function main() {
  if (!fs.existsSync(ASAR_PATH)) {
    console.error("❌ 未找到 Antigravity app.asar，请确认安装路径：", ASAR_PATH);
    process.exit(1);
  }

  if (!fs.existsSync(BAK_PATH)) {
    console.log("📦 正在备份原始 app.asar 到 app.asar.bak ...");
    fs.copyFileSync(ASAR_PATH, BAK_PATH);
    console.log("✅ 备份已保存至：", BAK_PATH);
  } else {
    console.log("ℹ️ 已存在原始备份：", BAK_PATH);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-patch-"));
  const tmpAsar = path.join(os.tmpdir(), `app-${Date.now()}.asar`);

  try {
    console.log("📂 正在解包 app.asar ...");
    execSync(`npx --yes @electron/asar extract "${ASAR_PATH}" "${tmpDir}"`, { stdio: "ignore" });

    const preloadPath = path.join(tmpDir, "dist", "preload.js");
    if (!fs.existsSync(preloadPath)) {
      throw new Error("未在 app.asar 中找到 dist/preload.js");
    }

    let preloadContent = fs.readFileSync(preloadPath, "utf8");
    if (preloadContent.includes("__AGY_USAGE_PANEL_PATCHED__")) {
      console.log("ℹ️ preload.js 已经打过补丁，正在使用最新的 panel.js 进行覆盖更新...");
      const patchStart = preloadContent.indexOf("/* __AGY_USAGE_PANEL_PATCHED_START__ */");
      const patchEnd = preloadContent.indexOf("/* __AGY_USAGE_PANEL_PATCHED_END__ */");
      if (patchStart !== -1 && patchEnd !== -1) {
        preloadContent = preloadContent.slice(0, patchStart) + preloadContent.slice(patchEnd + "/* __AGY_USAGE_PANEL_PATCHED_END__ */".length);
      }
    }

    const panelCode = fs.readFileSync(PANEL_FILE, "utf8");
    const patchSnippet = `
/* __AGY_USAGE_PANEL_PATCHED_START__ */
/* __AGY_USAGE_PANEL_PATCHED__ */
try {
  const injectUsagePanel = () => {
    if (document.getElementById('agy-usage-btn')) return;
    const script = document.createElement('script');
    script.textContent = ${JSON.stringify(panelCode)};
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectUsagePanel, { once: true });
  } else {
    injectUsagePanel();
  }
} catch (err) {
  console.error('[Antigravity Usage Panel Patch Error]:', err);
}
/* __AGY_USAGE_PANEL_PATCHED_END__ */
`;

    fs.writeFileSync(preloadPath, preloadContent + patchSnippet, "utf8");
    console.log("📝 已注入 panel.js 到 preload.js");

    console.log("📦 正在重新打包 app.asar ...");
    execSync(`npx --yes @electron/asar pack "${tmpDir}" "${tmpAsar}"`, { stdio: "ignore" });

    console.log("🔄 正在替换安装目录下的 app.asar ...");
    fs.copyFileSync(tmpAsar, ASAR_PATH);

    console.log("\n🎉 补丁安装成功！");
    console.log("👉 以后每次打开 Antigravity，右下角都将原生自带「📊 用量」悬浮监控面板。");
    console.log("👉 不需要运行任何 Node 守护脚本，不需要打开调试端口。");
    console.log("👉 如需还原，随时执行 node unpatch.js 即可。");
  } catch (err) {
    console.error("❌ 打补丁失败：", err.message);
    if (err.message.includes("EBUSY") || err.message.includes("locked")) {
      console.error("💡 提示：文件可能正被运行中的 Antigravity 占用，请彻底退出 Antigravity 客户端后重试。");
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    try { if (fs.existsSync(tmpAsar)) fs.unlinkSync(tmpAsar); } catch {}
  }
}

main();
