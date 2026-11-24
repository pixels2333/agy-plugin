// Frontend controller for Antigravity Stream Stats (Enhanced Analytics Edition)

const sidecar = window.sidecar;
const $ = (id) => document.getElementById(id);

let currentTab = 'tab-conv';
let autoRefreshEnabled = true;
let autoRefreshTimer = null;
let lastKnownConvId = null;
let fallbackConvId = null;
let selectedConvId = ''; // '' = 自动跟随当前/最新会话
let cachedConversations = [];
let cachedGlobalStats = null;
let chartRangeDays = 14;
let quotaShowLeft = false;
let quotaPlotRange = 'cycle'; // 'cycle' | '2d'
let lastQuotaData = null;

// ---------------------------------------------------------------------------
// Helpers & API Caller
// ---------------------------------------------------------------------------

async function callApi(path, { method = 'GET', body } = {}) {
  const fetcher = sidecar?.fetch ? sidecar.fetch.bind(sidecar) : window.fetch.bind(window);
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }
  const res = await fetcher(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `${res.status} ${res.statusText}`);
  }
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const el = $('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 2400);
}

function fmtNum(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '0';
  if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(1) + 'k';
  return num.toLocaleString('en-US');
}

function fmtBytes(bytes) {
  const b = Number(bytes);
  if (!Number.isFinite(b) || b <= 0) return '--';
  if (b >= 1024 * 1024 * 1024) return (b / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  if (b >= 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
  return b + ' B';
}

function fmtMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return '--';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtDuration(sec) {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '--';
  if (sec < 60) return `${Math.round(sec)}s`;
  const mins = Math.floor(sec / 60);
  if (mins < 60) return `${mins}m ${Math.round(sec % 60)}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function fmtResetRelative(isoStr) {
  if (!isoStr) return '--';
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return isoStr;
  const diffMs = d.getTime() - Date.now();
  if (diffMs <= 0) return '即将重置';
  const mins = Math.floor(diffMs / 60000);
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return hrs > 0 ? `${hrs}h ${remMins}m` : `${remMins}m`;
}

function fmtResetCountdown(isoStr) {
  if (!isoStr) return '下次重置: --';
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return `下次重置: ${isoStr}`;
  const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const rel = fmtResetRelative(isoStr);
  return rel === '即将重置' ? `即将重置 (${timeStr})` : `下次重置: ${timeStr} (${rel})`;
}

function makeRingSvg(pct) {
  const safePct = Math.min(100, Math.max(0, Number(pct) || 0));
  const r = 23;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - safePct / 100);
  const color =
    safePct < 20 ? 'var(--status-err)' : safePct < 50 ? 'var(--status-warn)' : 'var(--primary-color)';
  return `
    <svg width="64" height="64" viewBox="0 0 64 64" style="display:block">
      <circle cx="32" cy="32" r="29" fill="none" stroke="var(--border-color)" stroke-width="1" stroke-dasharray="2 3"/>
      <circle cx="32" cy="32" r="${r}" fill="none" stroke="var(--surface-recessed)" stroke-width="5"/>
      <circle cx="32" cy="32" r="${r}" fill="none" stroke="${color}" stroke-width="5"
        stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"
        transform="rotate(-90 32 32)" style="transition:stroke-dashoffset .3s ease"/>
      <text x="32" y="35" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor" font-family="ui-monospace, monospace">${safePct}%</text>
    </svg>
  `;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

function getActiveConvId() {
  return selectedConvId || sidecar?.conversationId || lastKnownConvId || fallbackConvId;
}

function renderInlineBarList(container, items, { emptyText, buildRow }) {
  if (!container) return;
  container.innerHTML = '';
  if (!items || items.length === 0) {
    container.innerHTML = `<div class="empty-box">${escapeHtml(emptyText)}</div>`;
    return;
  }
  items.forEach((item, idx) => {
    const cfg = buildRow(item, idx);
    const row = document.createElement('div');
    row.className = `inline-bar-row${cfg.className ? ' ' + cfg.className : ''}`;
    if (cfg.title) row.title = cfg.title;
    const toneClass = cfg.tone ? ` ${cfg.tone}` : '';
    const fillPct = Math.min(100, Math.max(2, Number(cfg.fillPct) || 0));
    row.innerHTML = `
      <div class="inline-bar-fill${toneClass}" style="width:${fillPct}%"></div>
      <div class="inline-bar-left">
        <span class="rank-num">${pad2(idx + 1)}</span>
        ${cfg.leftHtml}
      </div>
      <div class="inline-bar-right">
        ${cfg.rightHtml}
      </div>
    `;
    if (cfg.onClick) row.addEventListener('click', cfg.onClick);
    container.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// 会话下拉切换器
// ---------------------------------------------------------------------------

async function refreshConversationList() {
  const select = $('conv-select');
  if (!select) return;
  try {
    const res = await callApi('/api/conversations', { method: 'GET' });
    if (!res.success || !Array.isArray(res.conversations)) return;
    cachedConversations = res.conversations;

    const currentAutoId = sidecar?.conversationId || fallbackConvId || '';
    const prevValue = selectedConvId;

    select.innerHTML = '';
    const autoOpt = document.createElement('option');
    autoOpt.value = '';
    const autoShort = currentAutoId ? currentAutoId.slice(0, 8) : '未关联';
    autoOpt.textContent = `自动跟随 (${autoShort})`;
    select.appendChild(autoOpt);

    for (const c of cachedConversations) {
      const opt = document.createElement('option');
      opt.value = c.id;
      const title = c.title.length > 22 ? c.title.slice(0, 22) + '…' : c.title;
      opt.textContent = `${title} (${c.stepCount}步)`;
      opt.title = `${c.title} [${c.id}]`;
      select.appendChild(opt);
    }

    select.value = prevValue;
    if (select.value !== prevValue) {
      selectedConvId = '';
      select.value = '';
    }
  } catch {}
}

function switchToConversation(convId) {
  selectedConvId = convId || '';
  const select = $('conv-select');
  if (select) {
    if (selectedConvId && !Array.from(select.options).some((o) => o.value === selectedConvId)) {
      const opt = document.createElement('option');
      opt.value = selectedConvId;
      opt.textContent = `会话 ${selectedConvId.slice(0, 8)}`;
      select.appendChild(opt);
    }
    select.value = selectedConvId;
  }

  document.querySelectorAll('.nav-tab').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.view-panel').forEach((p) => {
    p.classList.remove('active');
    p.hidden = true;
  });
  const convTabBtn = document.querySelector('.nav-tab[data-tab="tab-conv"]');
  const convPane = $('tab-conv');
  if (convTabBtn) convTabBtn.classList.add('active');
  if (convPane) {
    convPane.hidden = false;
    convPane.classList.add('active');
  }
  currentTab = 'tab-conv';
  refreshConversation();
}

// ---------------------------------------------------------------------------
// Render Tab 1: 当前会话
// ---------------------------------------------------------------------------

const BD_GROUP_LABELS = {
  TOKEN_TYPE_SYSTEM_PROMPT: 'System Prompt',
  TOKEN_TYPE_TOOLS: '工具定义',
  TOKEN_TYPE_CHAT_MESSAGES: '对话消息',
};

function renderContextBreakdown(bd) {
  const box = $('ctx-breakdown-box');
  const bar = $('ctx-breakdown-bar');
  const groupsEl = $('ctx-bd-groups');
  const chipsEl = $('ctx-bd-chips');
  if (!box || !bar || !groupsEl || !chipsEl) return;

  if (!bd || !Array.isArray(bd.groups) || bd.groups.length === 0) {
    box.hidden = true;
    return;
  }
  box.hidden = false;

  const total = bd.totalTokens || bd.groups.reduce((a, g) => a + g.numTokens, 0) || 1;
  const segClasses = ['seg-1', 'seg-2', 'seg-3', 'seg-4'];

  bar.innerHTML = '';
  groupsEl.innerHTML = '';
  const allChildren = [];

  bd.groups.forEach((g, i) => {
    const pct = ((g.numTokens / total) * 100).toFixed(1);
    const label = BD_GROUP_LABELS[g.type] || g.name;
    const segCls = segClasses[i % segClasses.length];

    const seg = document.createElement('div');
    seg.className = `seg-item ${segCls}`;
    seg.style.width = `${pct}%`;
    seg.title = `${label}: ${fmtNum(g.numTokens)} (${pct}%)`;
    bar.appendChild(seg);

    const item = document.createElement('span');
    item.className = 'ctx-bd-item';
    item.innerHTML = `<span class="swatch swatch-${(i % 4) + 1}"></span><span>${escapeHtml(label)}</span><strong>${fmtNum(g.numTokens)}</strong><span class="tile-pct">${pct}%</span>`;
    groupsEl.appendChild(item);

    for (const ch of g.children || []) {
      if (!/^\d+:/.test(ch.name)) {
        allChildren.push(ch);
      }
    }
  });

  chipsEl.innerHTML = '';
  allChildren
    .sort((a, b) => b.numTokens - a.numTokens)
    .slice(0, 5)
    .forEach((ch) => {
      const chip = document.createElement('span');
      chip.className = 'bd-chip';
      chip.textContent = `${ch.name} ${fmtNum(ch.numTokens)}`;
      chipsEl.appendChild(chip);
    });
}

async function refreshConversation() {
  const activeId = getActiveConvId();

  if (!activeId) {
    $('ctx-summary').textContent = '等待进入对话';
    return;
  }

  if (!selectedConvId) lastKnownConvId = activeId;
  if ($('conv-id-pill')) {
    $('conv-id-pill').title = `复制会话 ID: ${activeId}`;
  }

  try {
    const res = await callApi('/api/conversation', {
      method: 'POST',
      body: { conversationId: activeId },
    });

    if (!res.success) {
      $('ctx-summary').textContent = `获取失败: ${res.error}`;
      return;
    }

    // 1. 上下文窗口刻度仪表 + 构成拆解
    const ctx = res.context || {};
    const pct = Math.min(100, Math.max(0, Number(ctx.percent) || 0));
    const maxTok = Number(ctx.max) || 0;
    const peakTok = Number(ctx.peak) || 0;
    const peakPct = maxTok > 0 ? Math.min(100, Math.max(0, (peakTok / maxTok) * 100)) : 0;

    $('ctx-used-big').textContent = fmtNum(ctx.used);
    $('ctx-max').textContent = fmtNum(maxTok);
    $('ctx-pct-badge').textContent = `${pct.toFixed(1)}%`;
    $('ctx-peak').textContent = fmtNum(peakTok);
    $('ctx-summary').textContent = pct >= 85 ? '接近容量上限' : pct >= 60 ? '中等水位' : '水位正常';

    const fillEl = $('ctx-progress-fill');
    fillEl.style.width = `${pct}%`;
    fillEl.classList.toggle('warn', pct >= 65 && pct < 85);
    fillEl.classList.toggle('danger', pct >= 85);

    const pinEl = $('ctx-peak-pin');
    if (pinEl) pinEl.style.left = `${peakPct}%`;

    renderContextBreakdown(res.contextBreakdown);

    // 2. Token 消耗构成（互斥四段之和 = 100%）
    const tok = res.tokens || {};
    const tIn = Number(tok.input) || 0;
    const tCache = Number(tok.cache) || 0;
    const tThink = Number(tok.thinking) || 0;
    const tResp = tok.responseOutput != null ? Number(tok.responseOutput) || 0 : Math.max(0, (Number(tok.output) || 0) - tThink);
    const sumTok = tIn + tCache + tResp + tThink || 1;
    const callsCount = Number(res.callsCount) || 0;

    if ($('ctx-avg-call')) {
      $('ctx-avg-call').textContent = callsCount > 0 ? `${fmtNum(Math.round((tok.total || 0) / callsCount))} / 次` : '--';
    }

    const promptTotal = tIn + tCache;
    const cacheHitNum = promptTotal > 0 ? (tCache / promptTotal) * 100 : 0;
    $('tok-cache-rate-pill').textContent = `${cacheHitNum.toFixed(1)}%`;
    if ($('cache-hit-bar')) $('cache-hit-bar').style.width = `${Math.min(100, cacheHitNum)}%`;
    $('tok-total-pill').textContent = `总计 ${fmtNum(tok.total)}`;

    const act = res.activity || {};
    if ($('tok-think-ratio')) {
      $('tok-think-ratio').textContent = `${act.thinkingRatio ?? 0}%`;
    }

    $('tok-input').textContent = fmtNum(tIn);
    $('tok-cache').textContent = fmtNum(tCache);
    $('tok-output').textContent = fmtNum(tResp);
    $('tok-thinking').textContent = fmtNum(tThink);

    const pIn = ((tIn / sumTok) * 100).toFixed(1);
    const pCache = ((tCache / sumTok) * 100).toFixed(1);
    const pResp = ((tResp / sumTok) * 100).toFixed(1);
    const pThink = ((tThink / sumTok) * 100).toFixed(1);

    $('tok-input-pct').textContent = `${pIn}%`;
    $('tok-cache-pct').textContent = `${pCache}%`;
    $('tok-output-pct').textContent = `${pResp}%`;
    $('tok-thinking-pct').textContent = `${pThink}%`;

    $('seg-input').style.width = `${pIn}%`;
    $('seg-cache').style.width = `${pCache}%`;
    $('seg-output').style.width = `${pResp}%`;
    $('seg-thinking').style.width = `${pThink}%`;

    // 2.5 分模型 Token 消耗构成明细（嵌入 Token 消耗构成卡片）
    const mbEl = $('tok-model-breakdown');
    const models = res.models || {};
    const details = res.modelDetails || {};
    const entries = Object.entries(models).sort((a, b) => b[1] - a[1]);
    const totalModelToks = entries.reduce((acc, [, v]) => acc + v, 0) || 1;
    if (mbEl) {
      if (entries.length === 0) {
        mbEl.hidden = true;
        mbEl.innerHTML = '';
      } else {
        mbEl.hidden = false;
        const totalCostUsd = entries.reduce((acc, [n]) => acc + (Number(details[n]?.costUsd) || 0), 0);
        mbEl.innerHTML = `
          <div class="tok-mb-head">
            <span>分模型消耗构成 (${entries.length} 个模型)</span>
            <span>标准 API 约 ${escapeHtml(fmtUsd(totalCostUsd))}</span>
          </div>
          ${entries
            .map(([mName, mToks]) => {
              const md = details[mName] || {};
              const share = ((mToks / totalModelToks) * 100).toFixed(1);
              const mIn = Number(md.input) || 0;
              const mCa = Number(md.cache) || 0;
              const mTh = Number(md.thinking) || 0;
              const mRe =
                md.responseOutput != null
                  ? Number(md.responseOutput) || 0
                  : Math.max(0, (Number(md.output) || 0) - mTh);
              const mSum = mIn + mCa + mRe + mTh || 1;
              const wIn = ((mIn / mSum) * 100).toFixed(1);
              const wCa = ((mCa / mSum) * 100).toFixed(1);
              const wRe = ((mRe / mSum) * 100).toFixed(1);
              const wTh = ((mTh / mSum) * 100).toFixed(1);
              const costTag = md.costUsd != null ? `<span class="tok-mb-cost">${escapeHtml(fmtUsd(md.costUsd))}</span>` : '';
              const tpsTag = md.tpsAvg != null ? ` · ${md.tpsAvg}/s` : '';
              return `
                <div class="tok-mb-item" title="${escapeHtml(mName)}: ${md.calls || 0}次 | 输入 ${fmtNum(mIn)} | 缓存 ${fmtNum(mCa)} | 回复 ${fmtNum(mRe)} | 思考 ${fmtNum(mTh)} | 约 ${fmtUsd(md.costUsd || 0)}">
                  <div class="tok-mb-row">
                    <span class="tok-mb-name">${escapeHtml(mName)}</span>
                    <span class="tok-mb-right">
                      <span class="sub-meta-tag">${md.calls || 0}次 · ${share}%</span>
                      ${costTag}
                      <span class="tok-mb-total">${fmtNum(mToks)}</span>
                    </span>
                  </div>
                  <div class="tok-mb-bar">
                    <div class="seg-1" style="width:${wIn}%"></div>
                    <div class="seg-2" style="width:${wCa}%"></div>
                    <div class="seg-3" style="width:${wRe}%"></div>
                    <div class="seg-4" style="width:${wTh}%"></div>
                  </div>
                  <div class="tok-mb-sub">
                    <span>入 ${fmtNum(mIn)} · 缓 ${fmtNum(mCa)}</span>
                    <span>回 ${fmtNum(mRe)} · 思 ${fmtNum(mTh)}${escapeHtml(tpsTag)}</span>
                  </div>
                </div>
              `;
            })
            .join('')}
        `;
      }
    }

    // 3. 响应时延、TPS 与执行量
    const lat = res.latency || {};
    $('calls-count-pill').textContent = `${callsCount} 次调用`;
    $('stat-ttft-last').textContent = fmtMs(lat.lastMs);
    $('stat-ttft-p50').textContent = fmtMs(lat.p50Ms);
    $('stat-ttft-avg').textContent = fmtMs(lat.avgMs);
    $('stat-ttft-p90').textContent = fmtMs(lat.p90Ms);

    if ($('stat-tps-avg')) $('stat-tps-avg').textContent = lat.tpsAvg != null ? `${lat.tpsAvg}/s` : '--';
    if ($('stat-tps-peak')) $('stat-tps-peak').textContent = lat.tpsPeak != null ? `${lat.tpsPeak}/s` : '--';
    if ($('stat-total-lat')) $('stat-total-lat').textContent = fmtMs(lat.totalLatencyAvgMs);
    if ($('stat-retries')) $('stat-retries').textContent = String(act.retries ?? 0);

    const turns = act.userTurns ?? 0;
    $('stat-steps').textContent = `${turns}轮 · ${fmtNum(res.stepsCount || 0)}步`;
    const errSuffix = act.errorSteps > 0 ? ` (${act.errorSteps}错)` : '';
    $('stat-tools').textContent = `${fmtNum(res.toolCallsCount || 0)}${errSuffix}`;
    if ($('stat-duration')) $('stat-duration').textContent = fmtDuration(act.durationSec);

    // 4. 会话工具调用与耗时
    const toolsList = res.toolBreakdown || [];
    if ($('conv-tools-count')) $('conv-tools-count').textContent = `${toolsList.length} 种`;
    const maxToolCnt = toolsList.length ? Math.max(...toolsList.map((t) => t.count), 1) : 1;
    renderInlineBarList($('conv-tools-list'), toolsList, {
      emptyText: '暂无工具调用数据',
      buildRow: (t) => {
        const avgStr = t.avgMs != null ? `均 ${fmtMs(t.avgMs)}` : '';
        const errTag = t.errors > 0 ? `<span class="err-badge">${t.errors}错</span>` : '';
        return {
          fillPct: (t.count / maxToolCnt) * 100,
          title: `${t.name}: ${t.count} 次 | 累计耗时 ${fmtMs(t.totalMs)} | 错误 ${t.errors}`,
          leftHtml: `<span class="inline-bar-name mono" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</span>`,
          rightHtml: `
            ${errTag}
            ${avgStr ? `<span class="sub-meta-tag">${avgStr}</span>` : ''}
            <span class="inline-bar-val">${t.count} 次</span>
          `,
        };
      },
    });

    // 5. 会话模型分布
    renderInlineBarList($('conv-models-list'), entries, {
      emptyText: '暂无模型调用数据',
      buildRow: ([mName, mToks]) => {
        const share = ((mToks / totalModelToks) * 100).toFixed(1);
        const md = details[mName];
        const callsTag = md ? `${md.calls}次 · ` : '';
        const tpsTag = md?.tpsAvg != null ? ` · ${md.tpsAvg}/s` : '';
        const tip = md
          ? `${mName}: ${md.calls}次 | 输入 ${fmtNum(md.input)} | 缓存 ${fmtNum(md.cache)} | 输出 ${fmtNum(md.output)} | 约 ${fmtUsd(md.costUsd || 0)}${tpsTag}`
          : mName;
        return {
          fillPct: Number(share),
          title: tip,
          leftHtml: `<span class="inline-bar-name" title="${escapeHtml(mName)}">${escapeHtml(mName)}</span>`,
          rightHtml: `
            <span class="inline-bar-pct">${callsTag}${share}%${escapeHtml(tpsTag)}</span>
            <span class="inline-bar-val">${fmtNum(mToks)}</span>
          `,
        };
      },
    });

    // 6. 最近请求流水微表格
    const recentEl = $('conv-recent-calls');
    if (recentEl) {
      recentEl.innerHTML = '';
      const recent = res.recentCalls || [];
      if ($('recent-calls-badge')) {
        $('recent-calls-badge').textContent = `最新 ${recent.length} 笔`;
      }
      if (recent.length === 0) {
        recentEl.innerHTML = '<div class="empty-box">暂无请求记录</div>';
      } else {
        const totalCalls = callsCount || recent.length;
        recent.forEach((call, i) => {
          const callNum = Math.max(1, totalCalls - i);
          const callTotal = (call.input || 0) + (call.cache || 0) + (call.output || 0);
          const tr = document.createElement('div');
          tr.className = 'stream-tr stream-tr-5';
          const retryNote = call.retries > 0 ? ` | 重试 ${call.retries}` : '';
          const bufNote = call.tpsBuffered ? ' | 含服务端缓冲耗时(端到端有效TPS)' : '';
          tr.title = `输入: ${fmtNum(call.input)} | 缓存: ${fmtNum(call.cache)} | 输出: ${fmtNum(call.output)} (思考 ${fmtNum(call.thinking)}) | 流耗时: ${fmtMs(call.streamMs)}${retryNote}${bufNote}`;
          const tpsText =
            call.tps != null ? `${call.tpsBuffered ? '~' : ''}${call.tps}/s` : '--';
          tr.innerHTML = `
            <span class="stream-col-idx">#${callNum}</span>
            <span class="stream-col-model">${escapeHtml(call.model)}</span>
            <span class="stream-col-tok">${fmtNum(callTotal)}</span>
            <span class="stream-col-ttft">${fmtMs(call.ttftMs)}</span>
            <span class="stream-col-tps">${tpsText}</span>
          `;
          recentEl.appendChild(tr);
        });
      }
    }
  } catch (err) {
    $('ctx-summary').textContent = err.message;
  }
}

// ---------------------------------------------------------------------------
// Render Tab 2: 额度配额
// ---------------------------------------------------------------------------

function quotaTone(pct) {
  if (pct < 20) return 'danger';
  if (pct < 50) return 'warn';
  return '';
}

function fmtClockHm(ms) {
  if (!ms || !Number.isFinite(ms)) return '--';
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtMonthDayHm(ms) {
  if (!ms || !Number.isFinite(ms)) return '--';
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtWindowResetText(resetsAt) {
  if (!resetsAt || !Number.isFinite(resetsAt)) return '重置时间未知';
  const now = Date.now();
  const diffMs = resetsAt - now;
  const target = new Date(resetsAt);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const dayDiff = Math.floor((new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime() - startOfToday) / 86400e3);

  let datePart = fmtMonthDayHm(resetsAt);
  if (dayDiff === 0) datePart = `今天 ${fmtClockHm(resetsAt)}`;
  else if (dayDiff === 1) datePart = `明天 ${fmtClockHm(resetsAt)}`;

  if (diffMs <= 0) return `重置于 ${datePart} · 即将重置`;
  const hrs = diffMs / 3600e3;
  let relPart = '';
  if (hrs < 1) relPart = `${Math.max(1, Math.round(diffMs / 60e3))} 分钟后`;
  else if (hrs < 48) relPart = `${hrs >= 10 ? Math.round(hrs) : hrs.toFixed(1)} 小时后`;
  else relPart = `${(hrs / 24).toFixed(1)} 天后`;

  return `重置于 ${datePart} · ${relPart}`;
}

function getEtaBanner(windows, now) {
  const depletions = (windows || [])
    .filter((w) => w.eta && w.eta.outAt && !w.eta.lastsUntilReset && w.eta.outAt > now)
    .sort((a, b) => a.eta.outAt - b.eta.outAt);
  if (depletions.length > 0) {
    const first = depletions[0];
    const hrs = (first.eta.outAt - now) / 3600e3;
    const dur =
      hrs < 1
        ? `${Math.max(1, Math.round(hrs * 60))} 分钟`
        : hrs >= 48
          ? `${(hrs / 24).toFixed(1)} 天`
          : `${hrs.toFixed(1)} 小时`;
    return { text: `${first.shortLabel} 预计 ${dur}后耗尽`, tone: 'warn' };
  }
  const hasSafe = (windows || []).some((w) => w.eta && w.eta.lastsUntilReset);
  if (hasSafe) {
    return { text: '按此速度，能撑到重置', tone: 'safe' };
  }
  return { text: '15m 采样点积累中（满 25 分钟自动拟合耗尽预测）', tone: '' };
}

function buildQuotaCurveSvg(windows, rangeMode, now) {
  const W = 400;
  const H = 76;
  const padT = 6;
  const padB = 6;
  const plotH = H - padT - padB;

  let x0;
  let x1;
  if (rangeMode === '2d') {
    x0 = now - 2 * 86400e3;
    x1 = now + 6 * 3600e3;
  } else {
    const starts = windows.map((w) => w.start).filter((v) => Number.isFinite(v) && v > 0);
    const resets = windows.map((w) => w.resetsAt).filter((v) => Number.isFinite(v) && v > 0);
    x0 = starts.length ? Math.min(...starts) : now - 5 * 3600e3;
    x1 = resets.length ? Math.max(...resets) : now + 3600e3;
  }
  if (x1 <= x0) x1 = x0 + 3600e3;

  const X = (t) => (((t - x0) / (x1 - x0)) * W).toFixed(1);
  const Y = (pct) => (padT + ((100 - Math.min(100, Math.max(0, pct))) / 100) * plotH).toFixed(1);

  const colorMap = { '5h': '#a78bfa', weekly: '#38bdf8' };
  const parts = [];

  // Horizontal gridlines: 100%, 50%, 0%
  for (const pct of [100, 50, 0]) {
    const y = Y(pct);
    parts.push(`<line class="qc-grid" x1="0" y1="${y}" x2="${W}" y2="${y}"/>`);
  }

  // Vertical 'now' guide
  if (now >= x0 && now <= x1) {
    const nx = X(now);
    parts.push(`<line class="qc-now" x1="${nx}" y1="${padT}" x2="${nx}" y2="${H - padB}"/>`);
  }

  // Even-pace reference diagonals
  for (const w of windows) {
    if (!w.start || !w.resetsAt || w.resetsAt <= w.start) continue;
    if ((w.resetsAt - w.start) / (x1 - x0) < 0.08) continue;
    parts.push(
      `<line class="qc-even" x1="${X(Math.max(x0, w.start))}" y1="${Y(w.start >= x0 ? 100 : 100 - ((x0 - w.start) / (w.resetsAt - w.start)) * 100)}" x2="${X(Math.min(x1, w.resetsAt))}" y2="${Y(w.resetsAt <= x1 ? 0 : 100 - ((x1 - w.start) / (w.resetsAt - w.start)) * 100)}"/>`,
    );
  }

  // Solid data curves + latest dot + dotted ETA projection
  for (const w of windows) {
    const stroke = colorMap[w.window] || '#34d399';
    const pts = (w.points || []).filter((p) => p.at >= x0 && p.at <= x1);
    const liveAt = Math.min(x1, now);
    if (!pts.length || liveAt - pts[pts.length - 1].at > 1000) {
      pts.push({ at: liveAt, left: w.left });
    }
    if (pts.length >= 2) {
      const dStr = pts.map((p, idx) => `${idx === 0 ? 'M' : 'L'}${X(p.at)},${Y(p.left)}`).join(' ');
      parts.push(`<path class="qc-line" stroke="${stroke}" d="${dStr}"/>`);
    }
    const last = pts[pts.length - 1];
    if (last) {
      parts.push(`<circle cx="${X(last.at)}" cy="${Y(last.left)}" r="2.6" fill="${stroke}"/>`);
      if (w.eta && w.eta.outAt && w.eta.outAt > last.at) {
        const endAt = Math.min(x1, w.eta.outAt);
        const endLeft =
          w.eta.outAt > x1
            ? Math.max(0, last.left * (1 - (x1 - last.at) / (w.eta.outAt - last.at)))
            : 0;
        parts.push(
          `<line class="qc-proj" stroke="${stroke}" x1="${X(last.at)}" y1="${Y(last.left)}" x2="${X(endAt)}" y2="${Y(endLeft)}"/>`,
        );
      }
    }
  }

  return {
    svgHtml: `<svg class="qc-plot" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${parts.join('')}</svg>`,
    x0,
    x1,
  };
}

function fmtUsd(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n)) return '--';
  if (n >= 100) return `$${n.toFixed(1)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  if (n === 0) return '$0.00';
  return `$${n.toFixed(4)}`;
}

function renderQuotaEstimate(res) {
  const body = $('quota-estimate-body');
  const metaEl = $('quota-sample-meta');
  const rangeBtn = $('btn-quota-range');
  const modeBtn = $('btn-quota-mode');

  if (rangeBtn) {
    rangeBtn.textContent = quotaPlotRange === '2d' ? '近2天' : '本周期';
    rangeBtn.classList.toggle('active', quotaPlotRange === '2d');
  }
  if (modeBtn) {
    modeBtn.textContent = quotaShowLeft ? '剩余' : '已用';
    modeBtn.classList.toggle('active', quotaShowLeft);
  }

  const qe = res?.quotaEstimate;
  if (metaEl) {
    const lastStr = qe?.lastSampledAt ? fmtMonthDayHm(qe.lastSampledAt) : '--';
    const nextStr = qe?.nextSampleAt ? fmtClockHm(qe.nextSampleAt) : '--';
    const sessStr = qe?.totalSessionsScanned ? `全量 ${qe.totalSessionsScanned} 会话 · ` : '';
    metaEl.textContent = `${sessStr}无优惠官方标准 API 单价 · 每 ${qe?.sampleIntervalMin || 15}m 采样 · 上次 ${lastStr} · 下次 ${nextStr}`;
  }

  if (!body) return;
  const groups = qe?.groups || [];
  if (!groups.length) {
    body.innerHTML = '<div class="empty-box">当前未获取到 5h / 1week API 配额窗口摘要</div>';
    return;
  }

  const now = Date.now();
  const colorMap = { '5h': '#a78bfa', weekly: '#38bdf8' };

  const groupsHtml = groups
    .map((g) => {
      const windows = g.windows || [];
      const win5hCur = windows[0]?.currentUsage || {};
      const totalCalls = win5hCur.calls ?? 0;
      const totalCostUsd = win5hCur.costUsd ?? 0;

      const metersHtml = windows
        .map((w) => {
          const displayPct = quotaShowLeft ? w.left : w.used;
          const modeLabel = quotaShowLeft ? '剩余' : '已用';
          const barCls = [
            'quota-meter-fill',
            w.window === 'weekly' ? 'win-7d' : '',
            w.left < 15 ? 'danger' : w.left < 30 ? 'warn' : '',
          ]
            .filter(Boolean)
            .join(' ');

          const paceHtml =
            w.pace != null
              ? `<span class="quota-pace ${w.pace > 25 ? 'danger' : w.pace > 0 ? 'over' : ''}">配速 ${w.pace >= 0 ? `+${w.pace}` : w.pace}%</span>`
              : '<span class="quota-pace">配速 --</span>';

          const est = w.estimate || {};
          const cur = w.currentUsage || {};
          let srcText = '待积累';
          let srcCls = 'quota-src-badge';
          if (est.source === '15m_intervals') {
            srcText = `15m采样×${est.intervalCount}`;
            srcCls = 'quota-src-badge precise';
          } else if (est.source === 'window_trajectories') {
            srcText = '轨迹初估';
          }

          const totalUsdStr = est.totalApiUsd != null ? fmtUsd(est.totalApiUsd) : '等待消费Δ';
          const remUsdStr = est.remainingApiUsd != null ? fmtUsd(est.remainingApiUsd) : '--';
          const curUsdStr = fmtUsd(cur.costUsd || 0);
          const breakdownTitle = (cur.byModel || [])
            .map((m) => `${m.name}: ${fmtUsd(m.costUsd)} (${m.calls}次)`)
            .join(' | ');
          const costSplitTitle = `输入 ${fmtUsd(cur.inputUsd)} / 缓存 ${fmtUsd(cur.cacheUsd)} / 输出 ${fmtUsd(cur.outputUsd)}${breakdownTitle ? ' | ' + breakdownTitle : ''}`;

          return `
            <div class="quota-meter" title="${escapeHtml(costSplitTitle)}">
              <div class="quota-meter-head">
                <span class="quota-meter-lbl">${escapeHtml(w.shortLabel || w.label)}</span>
                <span class="quota-meter-pct">${modeLabel} ${displayPct}%</span>
              </div>
              <div class="quota-meter-bar">
                <div class="${barCls}" style="width:${Math.min(100, Math.max(0, displayPct))}%"></div>
              </div>
              <div class="quota-meter-sub">
                ${escapeHtml(fmtWindowResetText(w.resetsAt))} · ${paceHtml}
              </div>
              <div class="quota-cap-box">
                <div class="quota-cap-row">
                  <span class="quota-cap-k">测算${escapeHtml(w.shortLabel)}API总额 <span class="${srcCls}">${srcText}</span></span>
                  <span class="quota-cap-usd">${escapeHtml(totalUsdStr)}</span>
                </div>
                <div class="quota-cap-row">
                  <span class="quota-cap-k">本窗消费 ${escapeHtml(curUsdStr)} · 推算余量</span>
                  <span class="quota-cap-v">${escapeHtml(remUsdStr)}</span>
                </div>
                <div class="quota-cap-row">
                  <span class="quota-cap-k">本窗 (${cur.sessionCount || 0}会话 · ${cur.calls || 0}次)</span>
                  <span class="quota-cap-v">${fmtNum(cur.nonCache || 0)} tok</span>
                </div>
              </div>
            </div>
          `;
        })
        .join('');

      const plot = buildQuotaCurveSvg(windows, quotaPlotRange, now);
      const etaBanner = getEtaBanner(windows, now);
      const legendHtml = windows
        .map((w) => {
          const dotColor = colorMap[w.window] || '#34d399';
          const val = quotaShowLeft ? w.left : w.used;
          return `<span class="qc-leg-item"><span class="qc-leg-dot" style="background:${dotColor}"></span>${escapeHtml(w.shortLabel)} ${quotaShowLeft ? '余' : '用'} ${val}%</span>`;
        })
        .join('');

      return `
        <div class="quota-win-group">
          <div class="quota-win-group-head">
            <span class="quota-win-group-title"><span class="quota-win-dot"></span>${escapeHtml(g.displayName)}</span>
            <span class="tag-badge">5h已耗 ${escapeHtml(fmtUsd(totalCostUsd))} / ${totalCalls}次</span>
          </div>
          <div class="quota-win-grid">${metersHtml}</div>
          <div class="quota-curve">
            <div class="quota-curve-head">
              <span class="quota-curve-title">剩余额度走势</span>
              <span class="quota-eta-msg ${etaBanner.tone}">${escapeHtml(etaBanner.text)}</span>
            </div>
            ${plot.svgHtml}
            <div class="qc-axis">
              <span>${escapeHtml(fmtMonthDayHm(plot.x0))}</span>
              <span>${escapeHtml(fmtMonthDayHm(plot.x1))}</span>
            </div>
            <div class="qc-legend">${legendHtml}</div>
          </div>
        </div>
      `;
    })
    .join('');

  const prices = qe?.pricingSchedule || [];
  const priceRefHtml = prices.length
    ? `
      <details class="quota-price-ref">
        <summary>测算口径：无优惠官方标准 API 单价 ($ / 1M Tokens)</summary>
        <div class="quota-price-table">
          ${prices
            .map(
              (p) => `
              <span class="quota-price-name">${escapeHtml(p.name)}</span>
              <span class="quota-price-rate">入 $${p.input} / 缓存 $${p.cacheRead} / 出 $${p.output}</span>
            `,
            )
            .join('')}
        </div>
      </details>
    `
    : '';

  body.innerHTML = groupsHtml + priceRefHtml;
}

function applyQuotaPayload(res) {
  if (!res || !res.success) {
    toast(`获取配额失败: ${res?.error || '未知错误'}`, true);
    return;
  }
  lastQuotaData = res;

  $('account-tier-pill').textContent = res.userTierName || res.plan || 'Pro';
  $('plan-name-val').textContent = res.plan || 'Pro';
  $('plan-tier-val').textContent = res.teamsTier || 'TEAMS_TIER_PRO';
  $('plan-desc-val').textContent = res.planDesc || '商业层级为 Pro';

  $('tier-name-val').textContent = res.userTierName || 'Google AI Pro';
  $('tier-id-val').textContent = res.userTierId || 'g1-pro-tier';
  $('tier-desc-val').textContent = res.userTierDesc || 'Google One AI 高级订阅权益';

  const emailStr = res.email ? (res.name ? `${res.name} (${res.email})` : res.email) : '--';
  $('user-email-val').textContent = emailStr;
  if (res.maxChatInputTokens) {
    $('token-limit-val').textContent = `输入上限: ${(res.maxChatInputTokens / 1024).toFixed(0)}k`;
  }

  $('quota-plan-pill').textContent = res.plan || 'Pro';
  $('quota-ring-box').innerHTML = makeRingSvg(res.remainingFraction);

  $('quota-model-name').textContent = res.mostConstrainedModel || '全局模型配额';
  $('quota-sub').textContent = `当前剩余: ${res.remainingFraction}%`;
  $('quota-reset').textContent = fmtResetCountdown(res.resetTime);

  renderQuotaEstimate(res);

  const pCred = res.promptCredits || {};
  const fCred = res.flowCredits || {};
  const fmtCred = (c) =>
    c.available != null
      ? c.monthly != null
        ? `${fmtNum(c.available)} / ${fmtNum(c.monthly)}`
        : fmtNum(c.available)
      : '--';
  $('credit-prompt-val').textContent = fmtCred(pCred);
  $('credit-flow-val').textContent = fmtCred(fCred);

  // 配额池分组概览
  const pools = res.quotaPools || [];
  if ($('quota-pools-count')) $('quota-pools-count').textContent = `${pools.length} 池`;
  renderInlineBarList($('quota-pools-list'), pools, {
    emptyText: '暂无配额池分组数据',
    buildRow: (pool) => {
      const pct = Math.min(100, Math.max(0, Number(pool.remainingFraction) || 0));
      const tone = quotaTone(pct);
      const valCls = tone ? ` quota-val-${tone}` : '';
      const resetRel = fmtResetRelative(pool.resetTime);
      return {
        fillPct: pct,
        tone,
        title: `${pool.name} (${pool.modelCount}个模型): ${pool.sampleModels?.join(', ') || ''} | ${fmtResetCountdown(pool.resetTime)}`,
        leftHtml: `<span class="inline-bar-name">${escapeHtml(pool.name)}</span>`,
        rightHtml: `
          <span class="sub-meta-tag">${pool.modelCount}模型 · ${escapeHtml(resetRel)}</span>
          <span class="inline-bar-val${valCls}">${pct}%</span>
        `,
      };
    },
  });

  // 全部模型配额明细
  const qList = res.modelQuotas || [];
  if ($('model-quotas-count')) $('model-quotas-count').textContent = `${qList.length} 项`;
  renderInlineBarList($('model-quotas-list'), qList, {
    emptyText: '未返回各模型分项配额',
    buildRow: (item) => {
      const pct = Math.min(100, Math.max(0, Number(item.remainingFraction) || 0));
      const tone = quotaTone(pct);
      const valCls = tone ? ` quota-val-${tone}` : '';
      const resetRel = fmtResetRelative(item.resetTime);
      return {
        fillPct: pct,
        tone,
        title: `${item.label} (${item.model || ''}) | ${fmtResetCountdown(item.resetTime)}`,
        leftHtml: `<span class="inline-bar-name" title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</span>`,
        rightHtml: `
          <span class="sub-meta-tag">${escapeHtml(resetRel)}</span>
          <span class="inline-bar-val${valCls}">${pct}%</span>
        `,
      };
    },
  });
}

async function refreshQuota() {
  try {
    const res = await callApi('/api/quota', { method: 'GET' });
    applyQuotaPayload(res);
  } catch (err) {
    toast(`配额加载异常: ${err.message}`, true);
  }
}

async function triggerQuotaSampleNow() {
  const btn = $('btn-quota-sample');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '采样中...';
  }
  try {
    const res = await callApi('/api/quota/sample', { method: 'POST', body: {} });
    applyQuotaPayload(res);
    toast('已完成一次配额与用量采样');
  } catch (err) {
    toast(`手动采样失败: ${err.message}`, true);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '立即采样';
    }
  }
}

// ---------------------------------------------------------------------------
// Render Tab 3: 全局统计
// ---------------------------------------------------------------------------

function renderGlobalChart(res) {
  const days = chartRangeDays === 30 ? res.recentDays30 || res.recentDays || [] : res.recentDays || [];
  const chart = $('chart-bars');
  const hoverPill = $('chart-hover-pill');
  if (!chart) return;
  chart.innerHTML = '';

  if (days.length > 0) {
    const maxCount = Math.max(...days.map((d) => d.count), 1);
    const sum = days.reduce((a, b) => a + b.count, 0);
    const defaultSummary = `${days.length}日 ${fmtNum(sum)} 次`;
    if (hoverPill) hoverPill.textContent = defaultSummary;

    for (const item of days) {
      const heightPct = Math.max(5, Math.round((item.count / maxCount) * 100));
      const isPeak = item.count === maxCount && maxCount > 0;
      const col = document.createElement('div');
      col.className = 'chart-bar-col';
      col.title = `${item.date}: ${item.count} 次请求`;
      col.innerHTML = `<div class="chart-bar-fill ${isPeak ? 'peak' : ''}" style="height: ${heightPct}%;"></div>`;
      col.addEventListener('mouseenter', () => {
        if (hoverPill) hoverPill.textContent = `${item.date.slice(5)} · ${item.count} 次`;
      });
      col.addEventListener('mouseleave', () => {
        if (hoverPill) hoverPill.textContent = defaultSummary;
      });
      chart.appendChild(col);
    }

    if ($('chart-date-start')) $('chart-date-start').textContent = days[0].date.slice(5);
    if ($('chart-date-mid')) $('chart-date-mid').textContent = days[Math.floor(days.length / 2)].date.slice(5);
    if ($('chart-date-end')) $('chart-date-end').textContent = days[days.length - 1].date.slice(5);
  } else {
    chart.innerHTML = '<div class="empty-box" style="width:100%">暂无趋势数据</div>';
  }
}

function renderGlobalStats(res) {
  cachedGlobalStats = res;
  const totals = res.totals || {};

  $('global-requests').textContent = fmtNum(totals.requests);
  $('global-convs').textContent = fmtNum(totals.conversations);
  $('global-steps').textContent = fmtNum(totals.steps);
  $('global-tools').textContent = fmtNum(totals.tool_calls);
  if ($('global-thinking')) $('global-thinking').textContent = fmtNum(totals.thinking_steps || 0);
  if ($('global-think-pct')) $('global-think-pct').textContent = `${totals.thinkingSharePct ?? 0}%`;
  if ($('global-turns')) $('global-turns').textContent = fmtNum(totals.user_turns || 0);

  if ($('global-active-days')) {
    $('global-active-days').innerHTML = `活跃: <strong>${totals.active_days ?? '--'} 天</strong>`;
  }
  if ($('global-avg-day')) {
    $('global-avg-day').innerHTML = `日均: <strong>${fmtNum(totals.avgReqsPerActiveDay || 0)}</strong>`;
  }
  if ($('global-db-size')) {
    $('global-db-size').innerHTML = `库体积: <strong>${fmtBytes(totals.db_bytes)}</strong>`;
  }
  if (res.generatedAt) {
    $('global-date-pill').textContent = res.generatedAt.slice(0, 10);
    $('global-date-pill').title = `快照生成时间: ${res.generatedAt}`;
  }

  renderGlobalChart(res);

  // 累计模型分布
  const models = res.requestsByModel || {};
  const mEntries = Object.entries(models).sort((a, b) => b[1] - a[1]);
  const totalReqs = mEntries.reduce((acc, [, v]) => acc + v, 0) || 1;
  renderInlineBarList($('global-models-list'), mEntries, {
    emptyText: '暂无模型分布数据',
    buildRow: ([mName, count]) => {
      const share = ((count / totalReqs) * 100).toFixed(1);
      return {
        fillPct: Number(share),
        leftHtml: `<span class="inline-bar-name" title="${escapeHtml(mName)}">${escapeHtml(mName)}</span>`,
        rightHtml: `
          <span class="inline-bar-pct">${share}%</span>
          <span class="inline-bar-val">${fmtNum(count)}</span>
        `,
      };
    },
  });

  // 高频工具 Top 10
  const topTools = res.topTools || [];
  const maxTool = topTools.length ? Math.max(...topTools.map((t) => Number(t.count ?? t[1] ?? 0)), 1) : 1;
  renderInlineBarList($('global-tools-list'), topTools, {
    emptyText: '暂无工具统计',
    buildRow: (item) => {
      const tName = item.name || item[0] || 'unknown';
      const tCount = Number(item.count ?? item[1] ?? 0);
      return {
        fillPct: (tCount / maxTool) * 100,
        leftHtml: `<span class="inline-bar-name mono" title="${escapeHtml(tName)}">${escapeHtml(tName)}</span>`,
        rightHtml: `<span class="inline-bar-val">${fmtNum(tCount)}</span>`,
      };
    },
  });

  // 近期会话排行 Top 10（可点击跳转）
  const topConvs = res.topConversations || [];
  const maxConvReqs = topConvs.length ? Math.max(...topConvs.map((c) => c.requests), 1) : 1;
  renderInlineBarList($('global-convs-list'), topConvs, {
    emptyText: '暂无历史会话记录',
    buildRow: (c) => {
      const dateStr = c.endedAt ? c.endedAt.slice(5, 10) : '';
      const meta = [dateStr, c.topModel ? c.topModel.replace(/^Gemini\s+/i, 'G') : null, fmtDuration(c.durationSec)]
        .filter(Boolean)
        .join(' · ');
      return {
        className: 'conv-link-row',
        fillPct: (c.requests / maxConvReqs) * 100,
        title: `${c.title}\n请求 ${c.requests} 次 | 步骤 ${c.steps} | 工具 ${c.toolCalls} | 点击查看详情`,
        leftHtml: `<span class="inline-bar-name">${escapeHtml(c.title)}</span>`,
        rightHtml: `
          <span class="sub-meta-tag">${escapeHtml(meta)}</span>
          <span class="inline-bar-val">${c.requests}次</span>
        `,
        onClick: () => {
          switchToConversation(c.id);
          toast(`已切换至会话 ${c.id.slice(0, 8)}`);
        },
      };
    },
  });
}

async function refreshGlobal() {
  try {
    const res = await callApi('/api/global-stats', { method: 'GET' });
    if (!res.success) {
      $('global-requests').textContent = '--';
      if (res.error) toast(res.error, true);
      return;
    }
    renderGlobalStats(res);
  } catch (err) {
    toast(`全局统计加载异常: ${err.message}`, true);
  }
}

async function triggerGlobalScan() {
  const btn = $('btn-scan-global');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '扫描中...';
  }
  try {
    const res = await callApi('/api/global-stats/refresh', { method: 'POST' });
    if (!res.success) {
      toast(`全量扫描失败: ${res.error}`, true);
      return;
    }
    renderGlobalStats(res);
    toast(`扫描完成：共 ${fmtNum(res.totals?.conversations)} 个会话`);
  } catch (err) {
    toast(`全量扫描异常: ${err.message}`, true);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '全量扫描';
    }
  }
}

// ---------------------------------------------------------------------------
// 状态与定时轮询
// ---------------------------------------------------------------------------

async function checkStatus() {
  const badge = $('conn-badge');
  const text = $('conn-text');
  try {
    const res = await callApi('/api/status', { method: 'GET' });
    if (res.latestConversationId) {
      fallbackConvId = res.latestConversationId;
    }
    if (res.languageServer && res.languageServer.connected) {
      badge.className = 'tier-pill';
      if (text) text.textContent = '在线';
      badge.title = `Language Server 已连接 (端口 ${res.languageServer.port})`;
    } else {
      badge.className = 'tier-pill offline';
      if (text) text.textContent = '未连接';
    }
  } catch {
    badge.className = 'tier-pill offline';
    if (text) text.textContent = '离线';
  }
}

async function refreshAll(showSpin = false) {
  const icon = $('icon-refresh');
  if (showSpin && icon) icon.classList.add('spinning');

  try {
    await checkStatus();
    if (currentTab === 'tab-conv') {
      await Promise.all([refreshConversation(), refreshConversationList()]);
    } else if (currentTab === 'tab-quota') {
      await refreshQuota();
    } else if (currentTab === 'tab-global') {
      await refreshGlobal();
    }
  } finally {
    if (showSpin && icon) {
      setTimeout(() => icon.classList.remove('spinning'), 400);
    }
  }
}

function setupAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  if (autoRefreshEnabled) {
    autoRefreshTimer = setInterval(() => {
      refreshAll(false);
    }, 5000);
  }
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

function init() {
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.view-panel').forEach((p) => {
        p.classList.remove('active');
        p.hidden = true;
      });

      btn.classList.add('active');
      const targetId = btn.getAttribute('data-tab');
      currentTab = targetId;
      const pane = $(targetId);
      pane.hidden = false;
      pane.classList.add('active');

      refreshAll(false);
    });
  });

  $('btn-refresh').addEventListener('click', () => {
    refreshAll(true);
    toast('数据已刷新');
  });

  const autoBtn = $('btn-auto-refresh');
  if (autoBtn) {
    autoBtn.addEventListener('click', () => {
      autoRefreshEnabled = !autoRefreshEnabled;
      autoBtn.classList.toggle('active', autoRefreshEnabled);
      setupAutoRefresh();
      toast(autoRefreshEnabled ? '已开启自动刷新' : '已关闭自动刷新');
    });
  }

  const convSelect = $('conv-select');
  if (convSelect) {
    convSelect.addEventListener('change', (e) => {
      selectedConvId = e.target.value || '';
      refreshConversation();
    });
  }

  $('conv-id-pill').addEventListener('click', () => {
    const activeId = getActiveConvId();
    if (activeId && navigator.clipboard) {
      navigator.clipboard
        .writeText(activeId)
        .then(() => {
          toast(`已复制会话 ID: ${activeId.slice(0, 8)}`);
        })
        .catch(() => {});
    }
  });

  const scanBtn = $('btn-scan-global');
  if (scanBtn) {
    scanBtn.addEventListener('click', triggerGlobalScan);
  }

  const rangeBtn = $('btn-chart-range');
  if (rangeBtn) {
    rangeBtn.addEventListener('click', () => {
      chartRangeDays = chartRangeDays === 14 ? 30 : 14;
      rangeBtn.textContent = `${chartRangeDays}日`;
      rangeBtn.classList.toggle('active', chartRangeDays === 30);
      if (cachedGlobalStats) renderGlobalChart(cachedGlobalStats);
    });
  }

  const quotaRangeBtn = $('btn-quota-range');
  if (quotaRangeBtn) {
    quotaRangeBtn.addEventListener('click', () => {
      quotaPlotRange = quotaPlotRange === 'cycle' ? '2d' : 'cycle';
      if (lastQuotaData) renderQuotaEstimate(lastQuotaData);
    });
  }

  const quotaModeBtn = $('btn-quota-mode');
  if (quotaModeBtn) {
    quotaModeBtn.addEventListener('click', () => {
      quotaShowLeft = !quotaShowLeft;
      if (lastQuotaData) renderQuotaEstimate(lastQuotaData);
    });
  }

  const quotaSampleBtn = $('btn-quota-sample');
  if (quotaSampleBtn) {
    quotaSampleBtn.addEventListener('click', triggerQuotaSampleNow);
  }

  refreshAll(false);
  refreshQuota();
  setupAutoRefresh();
}

init();
