/**
 * Antigravity usage-panel host.
 *
 * Keeps the panel alive in the running app without modifying any installed
 * file: attaches to the app's own DevTools port, injects the panel now, and
 * re-injects whenever the window navigates (the app is a SPA, and CDP's
 * addScriptToEvaluateOnNewDocument registration does not survive a detached
 * session, so we re-evaluate on load instead).
 *
 * Usage:
 *   node panel-host.js            # run in the background while you use the app
 *   node panel-host.js --once     # inject once and exit
 */
const fs = require("node:fs");
const path = require("node:path");

const HERE = __dirname;
const PANEL = fs.readFileSync(path.join(HERE, "panel.js"), "utf8");
const ONCE = process.argv.includes("--once");
const RESCAN_MS = 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readCdpPort() {
  const p = path.join(process.env.APPDATA || "", "Antigravity", "DevToolsActivePort");
  return Number(fs.readFileSync(p, "utf8").split(/\r?\n/)[0].trim());
}

async function findPage(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);
    const list = await res.json();
    return list.find((t) => t.type === "page" && t.url.startsWith("https://127.0.0.1"));
  } catch {
    return null;
  }
}

async function main() {
  const port = readCdpPort();
  console.log(`[panel-host] CDP port ${port}`);
  const target = await findPage(port);
  if (!target) throw new Error("app window not found — start Antigravity first");

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 1;
  const waiters = new Map();
  await new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", (e) => rej(new Error(e.message || "ws error")));
  });
  ws.addEventListener("message", (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && waiters.has(m.id)) {
      const { resolve } = waiters.get(m.id);
      waiters.delete(m.id);
      resolve(m.result);
      return;
    }
    if (m.method === "Page.loadEventFired" || m.method === "Page.frameNavigated") {
      setTimeout(inject, 800);
    }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const i = id++;
    waiters.set(i, { resolve });
    ws.send(JSON.stringify({ id: i, method, params }));
  });

  async function inject() {
    const r = await send("Runtime.evaluate", { expression: PANEL, returnByValue: true });
    const ok = !(r && r.exceptionDetails);
    console.log(`[panel-host] injected ${new Date().toLocaleTimeString()}${ok ? "" : " (with exception)"}`);
  }

  await send("Page.enable");
  await send("Runtime.enable");
  await inject();

  if (ONCE) { ws.close(); return; }

  console.log("[panel-host] watching for navigations; Ctrl+C to stop");
  // Periodically make sure the panel is present (covers target re-creation).
  setInterval(async () => {
    const r = await send("Runtime.evaluate", {
      expression: `!!document.getElementById('agy-usage-btn')`,
      returnByValue: true,
    });
    if (r && r.result && r.result.value === false) await inject();
  }, RESCAN_MS);
}

main().catch((e) => { console.error("[panel-host] ERROR:", e.message); process.exit(1); });
