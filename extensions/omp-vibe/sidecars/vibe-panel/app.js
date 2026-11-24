// OMP Vibe Mode Panel Client App — Modern Flat UI Controller
(function () {
  'use strict';

  let currentStatus = null;
  let pollInterval = null;
  let selectedSessionId = '';
  let isToggling = false;

  const el = {
    sessionSelect: document.getElementById('session-select'),
    btnRefresh: document.getElementById('btn-manual-refresh'),

    heroCard: document.getElementById('hero-card'),
    statusPill: document.getElementById('status-pill'),
    statusText: document.getElementById('status-text'),
    heroTitle: document.getElementById('hero-title'),
    heroDescription: document.getElementById('hero-description'),
    modeToggleCheckbox: document.getElementById('mode-toggle-checkbox'),
    knobSpinner: document.getElementById('knob-spinner'),
    btnQuickOn: document.getElementById('btn-quick-on'),
    btnQuickOff: document.getElementById('btn-quick-off'),
    btnPrewalk: document.getElementById('btn-prewalk'),
    syncIndicator: document.getElementById('sync-indicator'),
    syncLabel: document.getElementById('sync-label'),

    gateBadge: document.getElementById('gate-badge'),
    chipsDisabled: document.getElementById('chips-disabled'),
    chipsAllowed: document.getElementById('chips-allowed'),

    directorList: document.getElementById('director-list'),
    directorEmpty: document.getElementById('director-empty'),
    directorCount: document.getElementById('director-count'),


    footerHost: document.getElementById('footer-host'),
    footerSync: document.getElementById('footer-sync'),
    prewalkLine: document.getElementById('prewalk-line'),
  };


  function formatTime(timestamp) {
    if (!timestamp) return '';
    const d = new Date(timestamp);
    return d.toLocaleTimeString('zh-CN', { hour12: false });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  async function fetchStatus() {
    try {
      const query = selectedSessionId ? `?conversationId=${encodeURIComponent(selectedSessionId)}` : '';
      const res = await fetch(`/api/status${query}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      currentStatus = data;
      renderUI(data);
      updateSyncStatus(true);
    } catch (err) {
      updateSyncStatus(false);
    }
  }

  function updateSyncStatus(ok) {
    if (!el.syncIndicator) return;
    el.syncIndicator.classList.toggle('offline', !ok);
    if (el.syncLabel) {
      el.syncLabel.textContent = ok ? '实时同步中' : '连接中断...';
    }
    if (el.footerSync && ok) {
      el.footerSync.textContent = `已同步 (${formatTime(Date.now())})`;
    }
  }

  async function toggleMode(action) {
    if (isToggling) return;
    isToggling = true;
    setToggleLoading(true);

    try {
      const targetConvId = selectedSessionId || (currentStatus && currentStatus.conversationId) || 'global';
      const res = await fetch('/api/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          conversationId: targetConvId,
        }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      currentStatus = data;
      renderUI(data);
    } catch (err) {
      alert(`模式切换失败: ${err.message}`);
    } finally {
      isToggling = false;
      setToggleLoading(false);
    }
  }
  async function togglePrewalk(action, into) {
    try {
      const targetConvId = selectedSessionId || (currentStatus && currentStatus.conversationId) || 'global';
      const pw = (currentStatus && currentStatus.session && currentStatus.session.prewalk) || (currentStatus && currentStatus.prewalk) || {};
      const res = await fetch('/api/prewalk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: action || (pw.armed ? 'off' : 'arm'), into, conversationId: targetConvId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      currentStatus = data;
      renderUI(data);
    } catch (err) {
      alert(`Prewalk 切换失败: ${err.message}`);
    }
  }


  function setToggleLoading(loading) {
    const parentSwitch = el.modeToggleCheckbox?.closest('.flat-switch');
    if (parentSwitch) {
      parentSwitch.classList.toggle('loading', loading);
    }
  }

  function renderUI(data) {
    if (!data) return;
    const isEnabled = Boolean(data.enabled);

    // 1. Session Select
    renderSessionSelect(data);

    // 2. Hero Card
    if (el.heroCard) {
      el.heroCard.classList.toggle('is-on', isEnabled);
      el.heroCard.classList.toggle('is-off', !isEnabled);
    }

    if (el.statusPill) {
      el.statusPill.classList.toggle('on', isEnabled);
      el.statusPill.classList.toggle('off', !isEnabled);
    }

    if (el.statusText) {
      el.statusText.textContent = isEnabled ? 'Vibe Mode: ON' : 'Normal Mode: OFF';
    }

    if (el.heroTitle) {
      el.heroTitle.textContent = isEnabled ? 'Director 编排模式已激活' : '常规直写模式 (Normal Mode)';
    }

    if (el.heroDescription) {
      el.heroDescription.textContent = isEnabled
        ? '主会话直接改动已沙箱隔离，仅允许只读抽检，强制由子代理工作机（vibe-fast / vibe-good）并发执行任务。'
        : '主会话全部常规工具已完全放行（edit_file, write_file, run_command 等），可随时拨动开关进入 Director 模式。';
    }

    if (el.modeToggleCheckbox) {
      el.modeToggleCheckbox.checked = isEnabled;
    }

    // 3. Tool Gate Section
    if (el.gateBadge) {
      el.gateBadge.textContent = isEnabled ? 'PreToolUse 门禁防御生效' : '门禁已放开';
      el.gateBadge.style.color = isEnabled ? 'var(--green-bright)' : 'var(--text-secondary)';
    }
    // 3b. Prewalk one-shot handoff badge (hidden unless armed/handed-off)
    if (el.prewalkLine) {
      const pw = (data.session && data.session.prewalk) || data.prewalk || {};
      if (pw.armed) {
        el.prewalkLine.style.display = '';
        el.prewalkLine.textContent = `🟡 Prewalk ARMED → ${pw.into || 'fast'}（todos ${pw.todoSeen ? '就绪，等首改交接' : '待建，首改前先 manage_task'}）· /prewalk off 取消`;
      } else if (pw.done) {
        el.prewalkLine.style.display = '';
        el.prewalkLine.textContent = `✅ Prewalk 已交接 → ${pw.into || 'fast'}（一次性消耗）· /prewalk restart 重武装`;
      } else {
        el.prewalkLine.style.display = 'none';
      }
    }
    // 3c. Prewalk switch button label follows session prewalk state
    if (el.btnPrewalk) {
      const pwBtn = (data.session && data.session.prewalk) || data.prewalk || {};
      el.btnPrewalk.textContent = pwBtn.armed
        ? `Prewalk ON(${(pwBtn.into || 'fast').toUpperCase()})·点按取消`
        : (pwBtn.done ? 'Prewalk 已交接·点按重武装' : 'Prewalk 武装');
      el.btnPrewalk.classList.toggle('active', Boolean(pwBtn.armed));
    }

    renderToolChips(isEnabled);

    // 4. Director 主代理消息
    renderDirectorMessages(data);


    // 5. Footer Host
    if (el.footerHost) {
      el.footerHost.textContent = window.location.host || '127.0.0.1:51400';
    }
  }

  function renderSessionSelect(data) {
    if (!el.sessionSelect) return;
    const sessions = data.sessions || {};
    const sessionKeys = Object.keys(sessions);

    if (sessionKeys.length === 0) {
      el.sessionSelect.innerHTML = '<option value="">当前会话 (默认)</option>';
      return;
    }

    const currentVal = selectedSessionId || data.conversationId || data.lastParentId || sessionKeys[0];
    let html = '';
    for (const sid of sessionKeys) {
      const sess = sessions[sid] || {};
      const statusIcon = sess.enabled ? '🟢' : '⚪';
      const shortId = sid.length > 14 ? `${sid.slice(0, 7)}...${sid.slice(-4)}` : sid;
      const isSelected = sid === currentVal ? 'selected' : '';
      html += `<option value="${sid}" ${isSelected}>${statusIcon} ${shortId}</option>`;
    }
    el.sessionSelect.innerHTML = html;
  }

  function renderToolChips(isEnabled) {
    if (el.chipsDisabled) {
      if (isEnabled) {
        el.chipsDisabled.innerHTML = `
          <span class="flat-chip chip-red">edit_file (文件修改)</span>
          <span class="flat-chip chip-red">write_file (新建文件)</span>
          <span class="flat-chip chip-red">run_command (终端执行)</span>
          <span class="flat-chip chip-red">manage_task (任务管理)</span>
          <span class="flat-chip chip-red">search_web (联网搜索)</span>
        `;
      } else {
        el.chipsDisabled.innerHTML = `
          <span class="flat-chip chip-neutral">当前无任何被拦截工具（全部常规可用）</span>
        `;
      }
    }

    if (el.chipsAllowed) {
      if (isEnabled) {
        el.chipsAllowed.innerHTML = `
          <span class="flat-chip chip-green">read_file (审计抽检)</span>
          <span class="flat-chip chip-blue">vibe-fast (Flash 机械机)</span>
          <span class="flat-chip chip-purple">vibe-good (Pro 专家机)</span>
          <span class="flat-chip chip-green">send_message (指示通信)</span>
          <span class="flat-chip chip-green">vibe_* MCP 工具集</span>
        `;
      } else {
        el.chipsAllowed.innerHTML = `
          <span class="flat-chip chip-green">edit_file, write_file, run_command 等全量可用</span>
        `;
      }
    }
  }

  function renderDirectorMessages(data) {
    const msgs = Array.isArray(data.directorMessages) ? data.directorMessages : [];
    const total = typeof data.directorTotal === 'number' ? data.directorTotal : msgs.length;
    if (el.directorCount) {
      el.directorCount.textContent = total > 0 ? `近 ${msgs.length} 条 / 共 ${total} 条` : '0 条';
    }
    if (!el.directorList) return;
    if (msgs.length === 0) {
      el.directorList.style.display = 'none';
      if (el.directorEmpty) el.directorEmpty.style.display = 'flex';
      return;
    }
    if (el.directorEmpty) el.directorEmpty.style.display = 'none';
    el.directorList.style.display = 'flex';
    let html = '';
    for (const m of msgs) {
      const meta = [];
      if (m.step !== null && m.step !== undefined) meta.push(`#${m.step}`);
      if (m.createdAt) meta.push(formatTime(m.createdAt));
      if (m.toolCalls) meta.push(`${m.toolCalls} 工具`);
      const body = (m.preview || '').length > 600 ? `${(m.preview || '').slice(0, 600)}…` : (m.preview || '');
      html += `
        <div class="director-msg">
          <div class="director-msg-meta">
            <span class="director-badge">主代理</span>
            ${meta.length ? `<span class="director-meta-text">${escapeHtml(meta.join(' · '))}</span>` : ''}
            ${m.truncated ? '<span class="director-meta-text">（已截断）</span>' : ''}
          </div>
          <div class="director-msg-body">${escapeHtml(body)}</div>
        </div>
      `;
    }
    el.directorList.innerHTML = html;
  }


  function initEvents() {
    if (el.sessionSelect) {
      el.sessionSelect.addEventListener('change', (e) => {
        selectedSessionId = e.target.value;
        fetchStatus();
      });
    }

    if (el.btnRefresh) {
      el.btnRefresh.addEventListener('click', () => {
        el.btnRefresh.classList.add('rotating');
        fetchStatus().finally(() => {
          setTimeout(() => el.btnRefresh.classList.remove('rotating'), 500);
        });
      });
    }

    // Toggle switch checkbox change
    if (el.modeToggleCheckbox) {
      el.modeToggleCheckbox.addEventListener('change', (e) => {
        toggleMode(e.target.checked ? 'on' : 'off');
      });
    }

    if (el.btnQuickOn) {
      el.btnQuickOn.addEventListener('click', () => toggleMode('on'));
    }

    if (el.btnQuickOff) {
      el.btnQuickOff.addEventListener('click', () => toggleMode('off'));
    }
    if (el.btnPrewalk) {
      el.btnPrewalk.addEventListener('click', () => togglePrewalk());
    }

  }

  function startPolling() {
    fetchStatus();
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(fetchStatus, 1500);
  }

  document.addEventListener('DOMContentLoaded', () => {
    initEvents();
    startPolling();
  });
})();
