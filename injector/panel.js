/**
 * Antigravity in-app usage panel.
 *
 * Injected into the app's own renderer, so it is same-origin with the local
 * language server and can read window.__APP_CONFIG__.csrfToken directly.
 *
 * Data sources (all local, no extra upstream traffic):
 *  - GetUserStatus: plan credits, remaining fraction, reset time
 *  - responses the UI already receives, tapped via fetch/XHR wrapping:
 *    usage.inputTokens/outputTokens/thinkingOutputTokens and
 *    chatStartMetadata.contextWindowMetadata.{estimatedTokensUsed,maxContextTokens}
 */
(() => {
  if (window.__AGY_USAGE_PANEL__) return;
  window.__AGY_USAGE_PANEL__ = true;

  const RPC = "/exa.language_server_pb.LanguageServerService";
  const state = {
    quota: null,
    calls: [],
    models: {},
    contextUsed: 0,
    contextMax: 0,
    contextPeak: 0,
    lastError: null,
    updatedAt: null,
  };

  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const fmt = (n) => n.toLocaleString("en-US");
  const fmtK = (n) =>
    n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);

  function harvest(obj) {
    // Walk any JSON payload the UI receives and pick out usage/context records.
    let found = 0;
    const seen = new Set();
    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { node.forEach(visit); return; }
      const cm = node.chatModel || node;
      const usage = cm.usage || cm.modelUsage;
      if (usage && (usage.inputTokens || usage.outputTokens)) {
        const key = `${usage.responseId || ""}|${usage.messageId || ""}|${usage.inputTokens}`;
        if (!seen.has(key)) {
          seen.add(key);
          const model = cm.responseModel || usage.model || "unknown";
          state.calls.push({
            model,
            input: num(usage.inputTokens),
            cache: num(usage.cacheReadTokens),
            output: num(usage.outputTokens),
            thinking: num(usage.thinkingOutputTokens),
            at: Date.now(),
          });
          state.models[model] = (state.models[model] || 0) + num(usage.inputTokens) + num(usage.outputTokens);
          found++;
        }
      }
      const cwm = (cm.chatStartMetadata && cm.chatStartMetadata.contextWindowMetadata) || cm.contextWindowMetadata;
      if (cwm) {
        const used = num(cwm.estimatedTokensUsed);
        const max = num(cwm.maxContextTokens);
        if (used) state.contextUsed = used;
        if (max) state.contextMax = max;
        if (used > state.contextPeak) state.contextPeak = used;
        found++;
      }
      for (const k in node) visit(node[k]);
    };
    visit(obj);
    if (found) render();
    return found;
  }

  function wrapFetch() {
    const orig = window.fetch;
    window.fetch = async function (...args) {
      const res = await orig.apply(this, args);
      try {
        const url = typeof args[0] === "string" ? args[0] : args[0] && args[0].url;
        const ct = res.headers.get("content-type") || "";
        if (url && url.includes("LanguageServerService") && /json/.test(ct)) {
          res.clone().text().then((t) => {
            const i = t.indexOf("{");
            if (i < 0) return;
            try { harvest(JSON.parse(t.slice(i))); } catch {}
          }).catch(() => {});
        }
      } catch {}
      return res;
    };
  }

  function wrapXHR() {
    const open = XMLHttpRequest.prototype.open;
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u, ...rest) {
      this.__agyUrl = u;
      return open.call(this, m, u, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...a) {
      this.addEventListener("load", () => {
        try {
          if (this.__agyUrl && this.__agyUrl.includes("LanguageServerService") && typeof this.responseText === "string") {
            const i = this.responseText.indexOf("{");
            if (i >= 0) harvest(JSON.parse(this.responseText.slice(i)));
          }
        } catch {}
      });
      return send.apply(this, a);
    };
  }

  function currentConversationId() {
    const m = location.pathname.match(/^\/c\/([0-9a-fA-F-]{8,})/);
    return m ? m[1] : null;
  }

  async function loadConversation() {
    const cid = currentConversationId();
    if (!cid) return;
    if (state.loadingConv === cid) return;
    state.loadingConv = cid;
    try {
      const cfg = window.__APP_CONFIG__ || {};
      // GetCascadeTrajectory carries everything in one call: per-call usage,
      // context window metadata, step count and tool calls. The compact
      // PROD_UI verbosity strips tool calls, so the default (full) is required.
      const res = await window.fetch(`${RPC}/GetCascadeTrajectory`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-codeium-csrf-token": cfg.csrfToken || "",
          "x-grpc-web": "1",
          "x-user-agent": "antigravity",
        },
        body: JSON.stringify({ cascade_id: cid }),
      });
      const text = await res.text();
      const i = text.indexOf("{");
      if (i < 0) return;
      const data = JSON.parse(text.slice(i));
      const traj = data.trajectory || {};
      const gens = traj.generatorMetadata || [];
      const steps = traj.steps || [];

      const models = {};
      const ttfts = [];
      let ttftLast = null;
      let calls = 0, input = 0, cache = 0, output = 0, thinking = 0, ctxUsed = 0, ctxMax = 0, ctxPeak = 0;
      for (const gen of gens) {
        const cm = gen.chatModel || {};
        const u = cm.usage || {};
        if (!u.inputTokens && !u.outputTokens) continue;
        calls++;
        const n = (v) => Number(v) || 0;
        input += n(u.inputTokens);
        cache += n(u.cacheReadTokens);
        output += n(u.outputTokens);
        thinking += n(u.thinkingOutputTokens);
        // timeToFirstToken comes as e.g. "3.672178s"
        if (typeof cm.timeToFirstToken === "string") {
          const v = parseFloat(cm.timeToFirstToken);
          if (Number.isFinite(v)) { ttfts.push(v); ttftLast = v; }
        }
        const name = cm.responseModel || u.model || "unknown";
        models[name] = (models[name] || 0) + n(u.inputTokens) + n(u.cacheReadTokens) + n(u.outputTokens);
        const cwm = (cm.chatStartMetadata && cm.chatStartMetadata.contextWindowMetadata) || {};
        const cu = n(cwm.estimatedTokensUsed), cx = n(cwm.maxContextTokens);
        if (cu) { ctxUsed = cu; if (cu > ctxPeak) ctxPeak = cu; }
        if (cx) ctxMax = cx;
      }

      // Tool calls are the elements of every toolCalls array in the steps.
      let toolCalls = 0;
      const stepTypes = {};
      const visit = (node) => {
        if (Array.isArray(node)) { node.forEach(visit); return; }
        if (!node || typeof node !== "object") return;
        for (const k in node) {
          if (k === "toolCalls" && Array.isArray(node[k])) toolCalls += node[k].length;
          visit(node[k]);
        }
      };
      for (const st of steps) {
        const t = st.type || "UNKNOWN";
        stepTypes[t] = (stepTypes[t] || 0) + 1;
        visit(st);
      }

      const sorted = [...ttfts].sort((a, b) => a - b);
      const at = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null;
      const round3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);

      state.conv = {
        id: cid,
        calls,
        toolCalls,
        steps: data.numTotalSteps != null ? data.numTotalSteps : steps.length,
        models,
        ctxUsed, ctxMax, ctxPeak,
        ttft: {
          p50: round3(at(0.5)),
          p90: round3(at(0.9)),
          last: round3(ttftLast),
          samples: sorted.length,
        },
      };
      state.contextUsed = ctxUsed;
      state.contextMax = ctxMax;
      state.contextPeak = ctxPeak;
      state.models = models;
      state.convTotals = { input, cache, output, thinking };
      state.lastError = null;
      render();
    } catch (e) {
      state.lastError = String((e && e.message) || e);
    } finally {
      state.loadingConv = null;
    }
  }

  async function loadQuota() {
    try {
      const cfg = window.__APP_CONFIG__ || {};
      const res = await window.fetch(`${RPC}/GetUserStatus`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-codeium-csrf-token": cfg.csrfToken || "",
          "x-grpc-web": "1",
          "x-user-agent": "antigravity",
        },
        body: JSON.stringify({ metadata: {} }),
      });
      const text = await res.text();
      const i = text.indexOf("{");
      const data = JSON.parse(text.slice(i));
      const us = data.userStatus || {};
      const ps = us.planStatus || {};
      // quotaInfo is attached per model config (same account-level value).
      const cfgs = (us.cascadeModelConfigData && us.cascadeModelConfigData.clientModelConfigs) || [];
      const perModel = cfgs
        .map((c) => ({ label: c.label, q: c.quotaInfo }))
        .filter((c) => c.q);
      const fracs = perModel.map((c) => c.q.remainingFraction).filter((v) => typeof v === "number");
      // Model order is not stable and pools differ (Gemini vs Claude/GPT), so the
      // headline must be the most constrained pool, not configs[0].
      const minFrac = fracs.length ? Math.min(...fracs) : null;
      const minCfg = perModel.find((c) => c.q.remainingFraction === minFrac);
      state.quota = {
        plan: (ps.planInfo && ps.planInfo.planName) || us.userTier || "?",
        remaining: minFrac,
        remainingLabel: minCfg ? minCfg.label : null,
        reset: (minCfg && minCfg.q.resetTime) || null,
        prompt: ps.availablePromptCredits,
        flow: ps.availableFlowCredits,
        monthlyPrompt: ps.planInfo && ps.planInfo.monthlyPromptCredits,
        monthlyFlow: ps.planInfo && ps.planInfo.monthlyFlowCredits,
        modelQuotas: perModel.slice(0, 8).map((c) => ({
          label: c.label,
          remaining: c.q.remainingFraction,
        })),
      };
      state.lastError = null;
      render();
    } catch (e) {
      state.lastError = String(e && e.message || e);
      render();
    }
  }

  const svg = (pathD, size = 13, extra = "") =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="apple-svg" ${extra}>${pathD}</svg>`;

  const ICONS = {
    chart: svg('<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>', 13),
    refresh: svg('<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 21h5v-5"/>', 12),
    close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', 12),
    chevronDown: svg('<path d="m6 9 6 6 6-6"/>', 11),
    chevronUp: svg('<path d="m18 15-6-6-6 6"/>', 11),
    shield: svg('<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>', 12),
    cpu: svg('<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>', 12),
    terminal: svg('<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>', 12),
    zap: svg('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>', 12),
    database: svg('<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>', 11),
    clock: svg('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>', 11),
    check: svg('<polyline points="20 6 9 17 4 12"/>', 11)
  };

  const CSS = `
  /* Apple System Design Language */
  #agy-usage-btn{
    position:fixed;right:16px;bottom:16px;z-index:2147483000;
    background:rgba(30,30,32,0.85);backdrop-filter:blur(25px) saturate(180%);-webkit-backdrop-filter:blur(25px) saturate(180%);
    color:#ffffff;border:0.5px solid rgba(255,255,255,0.18);border-radius:999px;
    padding:6px 12px;font:500 12px/1 -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",sans-serif;
    cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,0.35),inset 0 0.5px 0 rgba(255,255,255,0.2);
    display:flex;align-items:center;gap:7px;transition:all .2s cubic-bezier(0.16,1,0.3,1);user-select:none;
  }
  #agy-usage-btn:hover{
    background:rgba(44,44,46,0.92);transform:scale(1.02);
    box-shadow:0 6px 20px rgba(0,0,0,0.45),inset 0 0.5px 0 rgba(255,255,255,0.3);
  }
  #agy-usage-btn:active{transform:scale(0.98)}
  #agy-usage-btn .apple-dot{width:6px;height:6px;border-radius:50%;background:#30d158;box-shadow:0 0 6px rgba(48,209,88,0.8)}

  #agy-usage-panel{
    position:fixed;right:16px;bottom:56px;width:352px;max-height:calc(85vh - 65px);
    overflow-y:auto;overflow-x:hidden;z-index:2147483000;
    background:rgba(28,28,30,0.86);backdrop-filter:blur(35px) saturate(190%);-webkit-backdrop-filter:blur(35px) saturate(190%);
    color:#f5f5f7;border:0.5px solid rgba(255,255,255,0.15);border-radius:18px;padding:14px;
    font:12px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Helvetica Neue",sans-serif;
    box-shadow:0 20px 48px rgba(0,0,0,0.6),inset 0 0.5px 0 rgba(255,255,255,0.15);
  }
  #agy-usage-panel::-webkit-scrollbar{width:4px}
  #agy-usage-panel::-webkit-scrollbar-track{background:transparent}
  #agy-usage-panel::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.15);border-radius:4px}
  #agy-usage-panel::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,0.3)}

  /* Apple System Header */
  .apple-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:11px;padding-bottom:9px;border-bottom:0.5px solid rgba(255,255,255,0.1)}
  .apple-title-wrap{display:flex;align-items:center;gap:7px}
  .apple-hdr-icon{display:inline-flex;color:#0a84ff}
  .apple-title{font-size:13px;font-weight:600;color:#fff;letter-spacing:-0.2px}
  .apple-live-badge{display:inline-flex;align-items:center;gap:4px;font-size:9.5px;font-weight:600;color:#30d158;background:rgba(48,209,88,0.12);padding:1px 6px;border-radius:999px}
  .apple-live-dot{width:4px;height:4px;border-radius:50%;background:#30d158}
  .apple-actions{display:flex;align-items:center;gap:6px}
  .apple-btn-icon{width:24px;height:24px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;color:rgba(235,235,245,0.6);background:rgba(255,255,255,0.06);border:0.5px solid rgba(255,255,255,0.08);transition:all .15s ease}
  .apple-btn-icon:hover{color:#fff;background:rgba(255,255,255,0.14)}

  /* Apple Inset Card */
  .apple-card{background:rgba(44,44,46,0.6);border:0.5px solid rgba(255,255,255,0.1);border-radius:14px;padding:11px 12px;margin-bottom:9px}
  .apple-card-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
  .apple-card-title{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:600;letter-spacing:-0.1px;color:rgba(235,235,245,0.6)}
  .apple-card-title .apple-svg{color:#0a84ff}
  .apple-pill{font-size:10px;font-weight:600;padding:1px 7px;border-radius:999px;font-variant-numeric:tabular-nums}
  .apple-pill-gray{background:rgba(255,255,255,0.08);color:rgba(235,235,245,0.7)}
  .apple-pill-blue{background:rgba(10,132,255,0.15);color:#0a84ff}
  .apple-pill-green{background:rgba(48,209,88,0.15);color:#30d158}

  /* Apple Ring Widget (Activity / Battery style) */
  .apple-ring-layout{display:flex;align-items:center;gap:12px;margin:2px 0 8px}
  .apple-ring-box{position:relative;width:58px;height:58px;flex-shrink:0}
  .apple-ring-info{flex:1;min-width:0}
  .apple-ring-headline{font-size:13px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .apple-ring-sub{font-size:10.5px;color:rgba(235,235,245,0.6);margin-top:2px}
  .apple-ring-meta{font-size:10px;color:rgba(235,235,245,0.4);margin-top:3px}

  /* Apple Segmented Bar (Storage / Battery / Screen Time) */
  .apple-seg-bar{display:flex;height:8px;border-radius:999px;background:rgba(255,255,255,0.08);overflow:hidden;margin:8px 0 10px;gap:1.5px}
  .apple-seg-item{height:100%;border-radius:2px;transition:width .3s ease}
  .apple-legend-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:6px}
  .apple-legend-box{background:rgba(255,255,255,0.03);border:0.5px solid rgba(255,255,255,0.05);border-radius:8px;padding:6px 8px}
  .apple-legend-top{display:flex;align-items:center;gap:5px;font-size:10px;color:rgba(235,235,245,0.6)}
  .apple-legend-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
  .apple-legend-val{font-size:12.5px;font-weight:600;font-variant-numeric:tabular-nums;color:#fff;margin-top:2px}

  /* Apple 2x2 Credit Grid */
  .apple-grid-2{display:grid;grid-template-columns:repeat(2,1fr);gap:6px}
  .apple-mini-stat{background:rgba(255,255,255,0.03);border:0.5px solid rgba(255,255,255,0.05);border-radius:8px;padding:6px 8px}
  .apple-mini-val{font-size:12.5px;font-weight:600;font-variant-numeric:tabular-nums;color:#fff}
  .apple-mini-lbl{font-size:9.5px;color:rgba(235,235,245,0.5);margin-top:1px}

  /* Context bar */
  .apple-progress-track{height:6px;border-radius:999px;background:rgba(255,255,255,0.08);overflow:hidden;margin:6px 0}
  .apple-progress-fill{height:100%;border-radius:999px;background:#0a84ff;transition:width .3s ease}
  .apple-progress-meta{display:flex;justify-content:space-between;font-size:10.5px;color:rgba(235,235,245,0.5);font-variant-numeric:tabular-nums}

  /* 3 Metric Columns (Apple Activity Style) */
  .apple-grid-3{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:2px 0 7px}
  .apple-stat-card{background:rgba(255,255,255,0.03);border:0.5px solid rgba(255,255,255,0.05);border-radius:9px;padding:7px 4px;text-align:center}
  .apple-stat-num{font-size:16px;font-weight:700;font-variant-numeric:tabular-nums;color:#fff}
  .apple-stat-lbl{font-size:9.5px;color:rgba(235,235,245,0.5);margin-top:1px}

  /* Accordion */
  .apple-disclosure{margin-top:7px;padding-top:6px;border-top:0.5px solid rgba(255,255,255,0.06);font-size:10.5px;color:#0a84ff;cursor:pointer;display:flex;justify-content:space-between;align-items:center;user-select:none}
  .apple-disclosure:hover{opacity:.85}
  .apple-disclosure-list{display:grid;grid-template-columns:1fr;gap:3px;margin-top:5px}
  .apple-list-row{display:flex;justify-content:space-between;align-items:center;background:rgba(255,255,255,0.02);border-radius:6px;padding:3px 7px;font-size:10px}

  .apple-foot{font-size:9.5px;color:rgba(235,235,245,0.35);display:flex;align-items:center;justify-content:center;gap:4px;margin-top:8px}
  .apple-spin{animation:apple-spinning .6s linear infinite}
  @keyframes apple-spinning{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
  `;

  let panel, listEl, pollTimer;

  function el(tag, attrs, text) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    return n;
  }

  function htmlEl(tag, attrs, html) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (html != null) n.innerHTML = html;
    return n;
  }

  function makeRingSvg(pct) {
    const r = 23;
    const c = 2 * Math.PI * r;
    const offset = c * (1 - Math.min(100, Math.max(0, pct)) / 100);
    const color = pct >= 50 ? "#30d158" : pct >= 20 ? "#ff9f0a" : "#ff453a";
    return `
      <svg width="58" height="58" viewBox="0 0 60 60" style="display:block">
        <circle cx="30" cy="30" r="${r}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="5"/>
        <circle cx="30" cy="30" r="${r}" fill="none" stroke="${color}" stroke-width="5"
          stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"
          transform="rotate(-90 30 30)" style="transition:stroke-dashoffset .4s ease"/>
        <text x="30" y="29" text-anchor="middle" font-size="13" font-weight="700" fill="#ffffff" font-family="-apple-system, sans-serif">${pct}%</text>
        <text x="30" y="41" text-anchor="middle" font-size="8.5" font-weight="500" fill="rgba(235,235,245,0.6)" font-family="-apple-system, sans-serif">剩余</text>
      </svg>
    `;
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      if (panel && panel.style.display !== "none") {
        loadQuota();
        loadConversation();
      } else {
        stopPolling();
      }
    }, 4000);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function build() {
    const style = el("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    const btn = el("button", { id: "agy-usage-btn" });
    const dot = el("span", { class: "apple-dot" });
    const icon = htmlEl("span", { style: "display:inline-flex;color:#0a84ff" }, ICONS.chart);
    const label = el("span", { style: "font-weight:500" }, "用量");
    const pct = el("span", { id: "agy-btn-pct", class: "apple-pill apple-pill-blue" });
    btn.appendChild(dot);
    btn.appendChild(icon);
    btn.appendChild(label);
    btn.appendChild(pct);

    panel = el("div", { id: "agy-usage-panel" });
    panel.style.display = "none";
    document.body.appendChild(btn);
    document.body.appendChild(panel);

    btn.onclick = () => {
      const showing = panel.style.display !== "none";
      panel.style.display = showing ? "none" : "block";
      if (!showing) {
        loadQuota();
        render();
        loadConversation();
        startPolling();
      } else {
        stopPolling();
      }
    };

    panel.addEventListener("click", (e) => {
      if (e.target && (e.target.classList.contains("x") || e.target.closest(".x"))) {
        panel.style.display = "none";
        stopPolling();
      }
    });
  }

  function render() {
    if (!panel) return;
    panel.textContent = "";
    const conv = state.conv;

    // Update button percentage badge
    const btnPct = document.getElementById("agy-btn-pct");
    if (btnPct && state.quota && state.quota.remaining != null) {
      btnPct.textContent = `${Math.round(state.quota.remaining * 1000) / 10}%`;
    }

    // --- Apple Header ---
    const hdr = el("div", { class: "apple-hdr" });
    const titleWrap = el("div", { class: "apple-title-wrap" });
    titleWrap.appendChild(htmlEl("span", { class: "apple-hdr-icon" }, ICONS.chart));
    titleWrap.appendChild(el("span", { class: "apple-title" }, "Antigravity 监控"));
    const live = htmlEl("span", { class: "apple-live-badge" }, '<span class="apple-live-dot"></span>实时');
    titleWrap.appendChild(live);
    hdr.appendChild(titleWrap);

    const actions = el("div", { class: "apple-actions" });
    const refreshBtn = htmlEl("div", { class: "apple-btn-icon", title: "刷新数据" }, ICONS.refresh);
    refreshBtn.onclick = (e) => {
      e.stopPropagation();
      refreshBtn.classList.add("apple-spin");
      loadQuota();
      loadConversation();
      setTimeout(() => refreshBtn.classList.remove("apple-spin"), 600);
    };
    actions.appendChild(refreshBtn);

    const closeBtn = htmlEl("div", { class: "apple-btn-icon x", title: "关闭面板" }, ICONS.close);
    actions.appendChild(closeBtn);
    hdr.appendChild(actions);
    panel.appendChild(hdr);

    // --- Card 1: Apple Watch Style Ring Chart for Quota ---
    const qCard = el("div", { class: "apple-card" });
    const qTop = el("div", { class: "apple-card-hdr" });
    qTop.appendChild(htmlEl("span", { class: "apple-card-title" }, `${ICONS.shield} <span>套餐与额度</span>`));
    if (state.quota) {
      qTop.appendChild(el("span", { class: "apple-pill apple-pill-gray" }, state.quota.plan || "Pro"));
    }
    qCard.appendChild(qTop);

    if (state.quota) {
      const r = state.quota.remaining;
      const pctVal = r == null ? 0 : Math.round(r * 1000) / 10;
      
      const ringLayout = el("div", { class: "apple-ring-layout" });
      const ringBox = htmlEl("div", { class: "apple-ring-box" }, makeRingSvg(pctVal));
      ringLayout.appendChild(ringBox);

      const ringInfo = el("div", { class: "apple-ring-info" });
      ringInfo.appendChild(el("div", { class: "apple-ring-headline" }, state.quota.remainingLabel ? state.quota.remainingLabel : "额度充足"));
      ringInfo.appendChild(el("div", { class: "apple-ring-sub" }, `最低额度池 · 剩余 ${pctVal}%`));
      if (state.quota.reset) {
        const d = new Date(state.quota.reset);
        const resetStr = isNaN(d) ? state.quota.reset : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        ringInfo.appendChild(htmlEl("div", { class: "apple-ring-meta" }, `${ICONS.clock} <span>${resetStr} 重置 · 周期内有效</span>`));
      }
      ringLayout.appendChild(ringInfo);
      qCard.appendChild(ringLayout);

      // 2x2 Credit Grid
      const cGrid = el("div", { class: "apple-grid-2" });
      const addCredit = (val, lbl) => {
        const box = el("div", { class: "apple-mini-stat" });
        box.appendChild(el("div", { class: "apple-mini-val" }, fmt(val)));
        box.appendChild(el("div", { class: "apple-mini-lbl" }, lbl));
        cGrid.appendChild(box);
      };
      if (state.quota.prompt != null) addCredit(state.quota.prompt, "可用 Prompt 积分");
      if (state.quota.flow != null) addCredit(state.quota.flow, "可用 Flow 积分");
      if (state.quota.monthlyPrompt != null) addCredit(state.quota.monthlyPrompt, "月度 Prompt 额度");
      if (state.quota.monthlyFlow != null) addCredit(state.quota.monthlyFlow, "月度 Flow 额度");
      qCard.appendChild(cGrid);

      // Collapsible models quota
      const mq = state.quota.modelQuotas || [];
      const distinct = new Set(mq.map((m) => m.remaining));
      if (mq.length && distinct.size > 1) {
        const toggle = el("div", { class: "apple-disclosure" });
        toggle.appendChild(el("span", null, `分模型额度池 (${mq.length})`));
        toggle.appendChild(htmlEl("span", { style: "display:inline-flex" }, state.showModels ? ICONS.chevronUp : ICONS.chevronDown));
        toggle.onclick = () => {
          state.showModels = !state.showModels;
          render();
        };
        qCard.appendChild(toggle);

        if (state.showModels) {
          const mList = el("div", { class: "apple-disclosure-list" });
          for (const m of mq) {
            const row = el("div", { class: "apple-list-row" });
            row.appendChild(el("span", { style: "color:rgba(235,235,245,0.8)", title: m.label }, m.label));
            row.appendChild(el("span", { style: "font-weight:600;color:#0a84ff;font-variant-numeric:tabular-nums" }, m.remaining == null ? "—" : Math.round(m.remaining * 1000) / 10 + "%"));
            mList.appendChild(row);
          }
          qCard.appendChild(mList);
        }
      }
    } else {
      qCard.appendChild(el("div", { class: "apple-mini-lbl" }, state.lastError ? "读取失败" : "读取中…"));
      if (state.lastError) qCard.appendChild(el("div", { style: "color:#ff453a;font-size:10px" }, state.lastError));
    }
    panel.appendChild(qCard);

    // --- Card 2: Apple Storage / RAM Style Context Window ---
    const cCard = el("div", { class: "apple-card" });
    const cTop = el("div", { class: "apple-card-hdr" });
    cTop.appendChild(htmlEl("span", { class: "apple-card-title" }, `${ICONS.cpu} <span>上下文窗口占用</span>`));
    if (state.contextMax) {
      const pctVal = Math.min(100, Math.round((state.contextUsed / state.contextMax) * 1000) / 10);
      cTop.appendChild(el("span", { class: "apple-pill apple-pill-blue" }, `${pctVal}%`));
      cCard.appendChild(cTop);

      const track = el("div", { class: "apple-progress-track" });
      const fill = el("div", { class: "apple-progress-fill" });
      fill.style.width = `${pctVal}%`;
      track.appendChild(fill);
      cCard.appendChild(track);

      const meta = el("div", { class: "apple-progress-meta" });
      meta.appendChild(el("span", null, `${fmtK(state.contextUsed)} / ${fmtK(state.contextMax)} tokens`));
      meta.appendChild(el("span", null, `会话峰值 ${fmtK(state.contextPeak)}`));
      cCard.appendChild(meta);
    } else {
      cTop.appendChild(el("span", { class: "apple-pill apple-pill-gray" }, "待机"));
      cCard.appendChild(cTop);
      cCard.appendChild(el("div", { class: "apple-mini-lbl" }, "打开会话后展示"));
    }
    panel.appendChild(cCard);

    // --- Card 3: Apple Activity / Health Style Metric Columns ---
    const sCard = el("div", { class: "apple-card" });
    const sTop = el("div", { class: "apple-card-hdr" });
    sTop.appendChild(htmlEl("span", { class: "apple-card-title" }, `${ICONS.terminal} <span>本会话执行统计</span>`));
    if (conv) {
      sTop.appendChild(el("span", { class: "apple-pill apple-pill-green" }, "活跃"));
      sCard.appendChild(sTop);

      const sGrid = el("div", { class: "apple-grid-3" });
      const addStat = (val, lbl, color) => {
        const cell = el("div", { class: "apple-stat-card" });
        const numEl = el("div", { class: "apple-stat-num" }, fmtK(val));
        if (color) numEl.style.color = color;
        cell.appendChild(numEl);
        cell.appendChild(el("div", { class: "apple-stat-lbl" }, lbl));
        sGrid.appendChild(cell);
      };
      addStat(conv.calls, "模型调用", "#0a84ff");
      addStat(conv.toolCalls, "工具调用", "#bf5af2");
      addStat(conv.steps, "Agent 步骤", "#30d158");
      sCard.appendChild(sGrid);

      if (conv.ttft && conv.ttft.samples) {
        const lat = htmlEl("div", { class: "apple-mini-stat", style: "display:flex;justify-content:space-between;font-size:10px;color:rgba(235,235,245,0.6)" },
          `<span>${ICONS.clock} 首字延迟 TTFT</span><span>p50: ${conv.ttft.p50}s · p90: ${conv.ttft.p90}s · 最新: ${conv.ttft.last}s</span>`);
        sCard.appendChild(lat);
      }
    } else {
      sTop.appendChild(el("span", { class: "apple-pill apple-pill-gray" }, "无数据"));
      sCard.appendChild(sTop);
      sCard.appendChild(el("div", { class: "apple-mini-lbl" }, "打开会话后展示"));
    }
    panel.appendChild(sCard);

    // --- Card 4: Apple Storage / Battery Segmented Bar Chart for Tokens ---
    const tCard = el("div", { class: "apple-card" });
    const tTop = el("div", { class: "apple-card-hdr" });
    tTop.appendChild(htmlEl("span", { class: "apple-card-title" }, `${ICONS.zap} <span>Token 消耗分布</span>`));

    let sums = null, models = null;
    if (conv) {
      sums = state.convTotals;
      models = conv.models;
    } else if (state.calls.length) {
      sums = state.calls.reduce(
        (a, x) => ({ input: a.input + x.input, cache: a.cache + (x.cache || 0), output: a.output + x.output, thinking: a.thinking + x.thinking }),
        { input: 0, cache: 0, output: 0, thinking: 0 });
      models = state.models;
    }

    if (sums) {
      const total = sums.input + (sums.cache || 0) + sums.output;
      tTop.appendChild(el("span", { class: "apple-pill apple-pill-gray" }, `共 ${fmtK(total)}`));
      tCard.appendChild(tTop);

      // Stacked segmented bar (Apple Storage / Battery style)
      const cachePct = total > 0 ? (((sums.cache || 0) / total) * 100).toFixed(1) : 0;
      const inputPct = total > 0 ? ((sums.input / total) * 100).toFixed(1) : 0;
      const outputPct = total > 0 ? ((sums.output / total) * 100).toFixed(1) : 0;
      const thinkingPct = total > 0 ? ((sums.thinking / total) * 100).toFixed(1) : 0;

      const segBar = el("div", { class: "apple-seg-bar" });
      const addSeg = (pct, color, title) => {
        if (Number(pct) <= 0) return;
        const seg = el("div", { class: "apple-seg-item" });
        seg.style.width = `${pct}%`;
        seg.style.background = color;
        seg.title = `${title}: ${pct}%`;
        segBar.appendChild(seg);
      };
      addSeg(cachePct, "#30d158", "缓存复用");
      addSeg(inputPct, "#0a84ff", "新增输入");
      addSeg(outputPct, "#bf5af2", "模型输出");
      addSeg(thinkingPct, "#ff9f0a", "思考推理");
      tCard.appendChild(segBar);

      // Apple Style Legend Grid (2x2)
      const lGrid = el("div", { class: "apple-legend-grid" });
      const addLegendBox = (color, lbl, val, badge) => {
        const box = el("div", { class: "apple-legend-box" });
        const topRow = el("div", { class: "apple-legend-top" });
        const dot = el("span", { class: "apple-legend-dot" });
        dot.style.background = color;
        topRow.appendChild(dot);
        topRow.appendChild(el("span", null, lbl));
        if (badge) {
          const b = el("span", { class: "apple-pill apple-pill-green", style: "margin-left:auto;font-size:9px" }, badge);
          topRow.appendChild(b);
        }
        box.appendChild(topRow);
        box.appendChild(el("div", { class: "apple-legend-val" }, fmtK(val)));
        lGrid.appendChild(box);
      };

      const cacheRate = sums.cache ? Math.round((sums.cache / (sums.input + sums.cache)) * 1000) / 10 : 0;
      addLegendBox("#30d158", "缓存复用", sums.cache, cacheRate ? `${cacheRate}%` : null);
      addLegendBox("#0a84ff", "新增输入", sums.input);
      addLegendBox("#bf5af2", "模型输出", sums.output);
      addLegendBox("#ff9f0a", "思考推理", sums.thinking);
      tCard.appendChild(lGrid);

      const topModels = Object.entries(models || {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
      if (topModels.length) {
        const tagList = el("div", { style: "display:flex;flex-wrap:wrap;gap:4px;margin-top:6px" });
        for (const [m, v] of topModels) {
          tagList.appendChild(el("span", { class: "apple-pill apple-pill-gray", style: "font-size:9.5px" }, `${m}: ${fmtK(v)}`));
        }
        tCard.appendChild(tagList);
      }
    } else {
      tTop.appendChild(el("span", { class: "apple-pill apple-pill-gray" }, "待机"));
      tCard.appendChild(tTop);
      tCard.appendChild(el("div", { class: "apple-mini-lbl" }, "暂无 Token 消耗数据"));
    }
    panel.appendChild(tCard);

    // --- Apple Footer ---
    const foot = htmlEl("div", { class: "apple-foot" }, `${ICONS.check} <span>本地直连通信 · 0 云端配额损耗</span>`);
    panel.appendChild(foot);
  }

  // Response taps can be installed immediately...
  wrapFetch();
  wrapXHR();

  // ...but DOM nodes must wait for <body> to exist. When injected at document
  // start (Page.addScriptToEvaluateOnNewDocument) the body is still null.
  function boot() {
    if (document.getElementById("agy-usage-btn")) return;
    build();

    // The app is a SPA: watch its history so switching conversations refreshes.
    const onNav = () => { if (panel && panel.style.display !== "none") loadConversation(); };
    for (const m of ["pushState", "replaceState"]) {
      const orig = history[m];
      history[m] = function (...a) { const r = orig.apply(this, a); onNav(); return r; };
    }
    window.addEventListener("popstate", onNav);

    render();
    loadQuota();
    loadConversation();
  }

  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot, { once: true });
})();
