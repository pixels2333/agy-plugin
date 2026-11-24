/**
 * Inject the usage panel into a running Antigravity window over its own
 * DevTools port. Adds the script for future page loads and evaluates it in the
 * current page immediately. Nothing on disk is modified.
 *
 * Usage: node inject.js [--screenshot out.png] [--eject]
 */
const fs = require("node:fs");
const path = require("node:path");

const HERE = __dirname;
const PANEL = fs.readFileSync(path.join(HERE, "panel.js"), "utf8");

function readCdpPort() {
  const p = path.join(process.env.APPDATA || "", "Antigravity", "DevToolsActivePort");
  return Number(fs.readFileSync(p, "utf8").split(/\r?\n/)[0].trim());
}

async function findPage(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await res.json();
  return targets.find((t) => t.type === "page" && t.url.startsWith("https://127.0.0.1"));
}

function cdp(url) {
  const ws = new WebSocket(url);
  let id = 1;
  const waiters = new Map();
  const ready = new Promise((res, rej) => {
    ws.addEventListener("open", () => res());
    ws.addEventListener("error", (e) => rej(new Error(e.message || "ws error")));
  });
  ws.addEventListener("message", (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && waiters.has(msg.id)) {
      const { resolve, reject } = waiters.get(msg.id);
      waiters.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = id++;
    waiters.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  return { ready, send, close: () => ws.close() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const port = readCdpPort();
  const target = await findPage(port);
  if (!target) throw new Error("Antigravity window not found — is the app running?");
  console.log("attaching to", target.url);

  const { ready, send, close } = cdp(target.webSocketDebuggerUrl);
  await ready;
  await send("Page.enable");
  await send("Runtime.enable");

  const idsFile = path.join(HERE, ".inject-ids.json");
  const prevIds = fs.existsSync(idsFile) ? JSON.parse(fs.readFileSync(idsFile, "utf8")) : [];
  for (const identifier of prevIds) {
    try { await send("Page.removeScriptToEvaluateOnNewDocument", { identifier }); } catch {}
  }
  if (prevIds.length) console.log("removed", prevIds.length, "previous injection(s)");

  if (process.argv.includes("--eject")) {
    await send("Runtime.evaluate", {
      expression: `(()=>{const b=document.getElementById('agy-usage-btn');const p=document.getElementById('agy-usage-panel');b&&b.remove();p&&p.remove();window.__AGY_USAGE_PANEL__=false;return 'ejected'})()`,
      returnByValue: true,
    });
    fs.writeFileSync(idsFile, "[]");
    console.log("panel ejected");
    close();
    return;
  }

  // Reset the guard so the panel rebuilds cleanly, then install for future
  // loads and run immediately in the live page.
  await send("Runtime.evaluate", {
    expression: `(()=>{const b=document.getElementById('agy-usage-btn');const p=document.getElementById('agy-usage-panel');b&&b.remove();p&&p.remove();window.__AGY_USAGE_PANEL__=false;return 1})()`,
    returnByValue: true,
  });
  const install = await send("Page.addScriptToEvaluateOnNewDocument", { source: PANEL });
  fs.writeFileSync(idsFile, JSON.stringify([install.identifier]));
  const run = await send("Runtime.evaluate", { expression: PANEL, returnByValue: true, awaitPromise: false });
  console.log("eval:", JSON.stringify(run.result && run.result.value));
  console.log("persistent script id:", install.identifier);

  // Open the panel so it is visible for the screenshot.
  await send("Runtime.evaluate", {
    expression: `(()=>{const b=document.getElementById('agy-usage-btn'); if(b){b.click();} return document.getElementById('agy-usage-panel')?.style.display||'none'})()`,
    returnByValue: true,
  });

  const shotIdx = process.argv.indexOf("--screenshot");
  if (shotIdx > -1) {
    const out = process.argv[shotIdx + 1] || path.join(HERE, "panel-shot.png");
    await sleep(2000); // let the quota fetch settle
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
    console.log("screenshot ->", out);
  }

  close();
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
