/**
 * Verify the injected panel on an EXISTING conversation: navigate the app to a
 * given conversation id (reuse, never create), wait for the panel to load that
 * conversation's data, then screenshot.
 *
 * Usage: node verify.js <conversationId> [out.png]
 */
const fs = require("node:fs");
const path = require("node:path");

const HERE = __dirname;
const CONV = process.argv[2];
const OUT = process.argv[3] || path.join(HERE, "panel-conv.png");
if (!CONV) { console.error("usage: node verify.js <conversationId> [out.png]"); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cdp(url) {
  const ws = new WebSocket(url);
  let id = 1;
  const waiters = new Map();
  const ready = new Promise((res, rej) => {
    ws.addEventListener("open", () => res());
    ws.addEventListener("error", (e) => rej(new Error(e.message || "ws error")));
  });
  ws.addEventListener("message", (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && waiters.has(m.id)) {
      const { resolve, reject } = waiters.get(m.id);
      waiters.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = id++;
    waiters.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  return { ready, send, close: () => ws.close() };
}

async function main() {
  const cdpPort = Number(
    fs.readFileSync(path.join(process.env.APPDATA, "Antigravity", "DevToolsActivePort"), "utf8").split(/\r?\n/)[0]
  );
  const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  const target = list.find((t) => t.type === "page" && t.url.startsWith("https://127.0.0.1"));
  if (!target) throw new Error("app window not found");
  const origin = new URL(target.url).origin;

  const { ready, send, close } = cdp(target.webSocketDebuggerUrl);
  await ready;
  await send("Page.enable");
  await send("Runtime.enable");

  const url = `${origin}/c/${CONV}`;
  console.log("navigating (reusing existing conversation):", url);
  await send("Page.navigate", { url });
  await sleep(4000);

  // The panel is installed via addScriptToEvaluateOnNewDocument, so it should
  // already exist on the freshly loaded page. Open it and give it time to fetch.
  await send("Runtime.evaluate", {
    expression: `(()=>{const p=document.getElementById('agy-usage-panel');
      if(!p) return 'panel-missing';
      if(p.style.display==='none'){document.getElementById('agy-usage-btn')?.click();}
      return 'opened';})()`,
    returnByValue: true,
  });
  await sleep(4000);

  const info = await send("Runtime.evaluate", {
    expression: `document.getElementById('agy-usage-panel')?.innerText || ''`,
    returnByValue: true,
  });
  console.log("---- panel text ----");
  console.log(info.result && info.result.value);

  const shot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(OUT, Buffer.from(shot.data, "base64"));
  console.log("screenshot ->", OUT);
  close();
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
