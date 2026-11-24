/**
 * Capture the renderer <-> language server traffic of a running Antigravity
 * instance through its own DevTools port. Read-only: attaches, enables the
 * Network domain, records requests/responses, and looks for token / context
 * usage payloads. Writes findings to capture-report.json.
 *
 * Usage: node capture.js [seconds] [cdpPort]
 */
const fs = require("node:fs");
const path = require("node:path");

const DURATION_S = Number(process.argv[2] || 45);
const OUT_DIR = __dirname;

const MARKERS = [
  "inputTokens", "outputTokens", "thinkingOutputTokens", "responseOutputTokens",
  "cacheReadTokens", "estimatedTokensUsed", "maxContextTokens", "tokenBreakdown",
  "creditUsageSummary", "costSummary", "consumedCredits",
  "deltaTokens", "usage", "totalTokens", "tokens",
];

function readCdpPort() {
  if (process.argv[3]) return Number(process.argv[3]);
  const p = path.join(process.env.APPDATA || "", "Antigravity", "DevToolsActivePort");
  return Number(fs.readFileSync(p, "utf8").split(/\r?\n/)[0].trim());
}

async function findPageTarget(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await res.json();
  return targets.find((t) => t.type === "page" && t.url.startsWith("https://127.0.0.1"));
}

function main() {
  const cdpPort = readCdpPort();
  console.log("CDP port:", cdpPort);

  findPageTarget(cdpPort).then((target) => {
    if (!target) throw new Error("no page target found");
    const uiOrigin = new URL(target.url).origin;
    console.log("UI origin:", uiOrigin);

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let nextId = 1;
    const pendingMethod = new Map();   // id -> method name
    const bodyWaiters = new Map();     // id -> request record
    const inflight = new Map();        // requestId -> record
    const report = {
      cdpPort, uiOrigin, capturedAt: new Date().toISOString(),
      requests: [], bodies: [], sseMarkers: [],
    };

    const send = (method, params = {}) => {
      const id = nextId++;
      pendingMethod.set(id, method);
      ws.send(JSON.stringify({ id, method, params }));
      return id;
    };

    ws.addEventListener("open", () => {
      console.log("connected; enabling Network domain");
      send("Network.enable", { maxTotalBufferSize: 50_000_000, maxResourceBufferSize: 5_000_000 });
      if (process.env.RELOAD === "1") {
        // A reload replays the UI's full initialisation traffic, which is what
        // we need when the app is sitting idle.
        console.log("triggering page reload to capture initialisation traffic");
        send("Page.enable");
        setTimeout(() => send("Page.reload", { ignoreCache: false }), 500);
      }
    });

    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.id) {
        const waiter = bodyWaiters.get(msg.id);
        if (waiter) {
          bodyWaiters.delete(msg.id);
          const body = msg.result && msg.result.body;
          if (typeof body === "string" && body.length) {
            const markers = MARKERS.filter((m) => body.includes(m));
            report.bodies.push({
              url: waiter.url, mimeType: waiter.mimeType, bytes: body.length,
              markers, sample: body.slice(0, 1500),
            });
          }
        } else {
          pendingMethod.delete(msg.id);
        }
        return;
      }

      const { method, params } = msg;
      if (method === "Network.requestWillBeSent") {
        const { requestId, request } = params;
        if (request.url.startsWith(uiOrigin)) {
          const names = Object.keys(request.headers || {});
          const csrf = {};
          for (const [k, v] of Object.entries(request.headers || {})) {
            // Record only CSRF-ish header names/values; never cookies or auth.
            if (/csrf/i.test(k)) csrf[k] = v;
          }
          inflight.set(requestId, {
            method: request.method,
            url: request.url,
            headerNames: names,
            csrfHeaders: csrf,
            postData: request.postData ? request.postData.slice(0, 800) : null,
          });
        }
      } else if (method === "Network.responseReceived") {
        const rec = inflight.get(params.requestId);
        if (rec) { rec.status = params.response.status; rec.mimeType = params.response.mimeType; }
      } else if (method === "Network.loadingFinished") {
        const rec = inflight.get(params.requestId);
        if (!rec) return;
        inflight.delete(params.requestId);
        report.requests.push(rec);
        const mt = rec.mimeType || "";
        if (mt.includes("json") || mt.includes("text")) {
          const id = send("Network.getResponseBody", { requestId: params.requestId });
          bodyWaiters.set(id, rec);
        }
      } else if (method === "Network.eventSourceMessageReceived") {
        const data = params.data || "";
        const markers = MARKERS.filter((m) => data.includes(m));
        if (markers.length) {
          report.sseMarkers.push({ markers, sample: data.slice(0, 1000) });
        }
      }
    });

    ws.addEventListener("error", (e) => console.error("ws error:", e.message));

    setTimeout(() => {
      const counts = new Map();
      for (const r of report.requests) {
        let p;
        try { p = new URL(r.url).pathname; } catch { p = r.url; }
        const k = `${r.method} ${p}`;
        counts.set(k, (counts.get(k) || 0) + 1);
      }
      report.endpointSummary = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      const out = path.join(OUT_DIR, "capture-report.json");
      fs.writeFileSync(out, JSON.stringify(report, null, 2));

      console.log(`\nwrote ${out}`);
      console.log(`requests=${report.requests.length} bodies=${report.bodies.length} sseMarkerEvents=${report.sseMarkers.length}`);
      console.log("\n=== endpoints ===");
      for (const [k, n] of report.endpointSummary.slice(0, 40)) console.log(`  ${String(n).padStart(4)}  ${k}`);
      const hits = report.bodies.filter((b) => b.markers.length);
      console.log(`\n=== responses with token/usage markers: ${hits.length} ===`);
      for (const b of hits.slice(0, 10)) {
        console.log(`  ${new URL(b.url).pathname} [${b.mimeType}] ${b.bytes}B -> ${[...new Set(b.markers)].join(",")}`);
      }
      ws.close();
      process.exit(0);
    }, DURATION_S * 1000);
  }).catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
}

main();
