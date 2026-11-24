// Frontend logic for Workspace Navigator UI Extension

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let currentWorkspaceUri = localStorage.getItem('agy_workspace_uri') || null;
let availableWorkspaceUris = [];
let currentWorkspacePath = '';
let currentTab = 'files';

let fileTreeData = [];
let fileTreeTruncated = false;
let expandedDirs = new Set();
let loadingDirs = new Set();
let activeFilePath = null;
let filterText = '';
let gitOnlyFilter = false;
let showIgnoredFiles = localStorage.getItem('agy_nav_show_ignored') === 'true';

let remoteSearchTree = null;
let remoteSearchQuery = '';
let remoteSearchSeq = 0;
let remoteSearchTruncated = false;

let lastWatchVersion = 0;
let lastGitWatchVersion = 0;
let watchActive = false;
let watchPollTimer = null;
let watchPollInFlight = false;
const WATCH_POLL_INTERVAL_MS = 1500;

let gitInfo = { isGit: false, branch: '', detached: false, upstream: '', ahead: 0, behind: 0, stashCount: 0 };
let gitChanges = { conflicts: [], staged: [], unstaged: [], untracked: [], totalChanges: 0 };
let gitFileStatusMap = new Map();
let gitCommits = [];
let commitsHasMore = false;
let commitFilterText = '';
let stashDrawerOpen = false;
let gitStashes = [];

let gitBranchesData = { current: '', branches: [], localBranches: [], remoteBranches: [], remotes: [] };
let branchFilterTab = 'all'; // 'all' | 'local' | 'remote'
let branchSearchText = '';
let currentMergeSource = '';
let currentRebaseUpstream = '';
let repoState = { isRebasing: false, isMerging: false, isCherryPicking: false, isInProgress: false };

let activePreviewFile = null;
let activePreviewContent = '';
let previewWrapLines = false;

let activeDiffTarget = null; // { type, path, staged, commitHash, targetBranch, baseBranch, diffText }
let diffWrapLines = false;

let refreshInFlight = false;
let refreshQueued = false;

const DIFF_INITIAL_MAX_LINES = 2500;
const COMMITS_PAGE_SIZE = 40;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function debounce(fn, delay = 140) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

let toastTimer = null;
function showToast(msg, type = 'info', duration = 2600) {
  const toast = $('#toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.className = `toast${type === 'error' ? ' error' : type === 'success' ? ' success' : ''}`;
  toast.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.style.display = 'none';
  }, type === 'error' ? Math.max(duration, 4200) : duration);
}

async function copyText(text, successMsg = '已复制到剪贴板') {
  if (text == null) return false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      if (successMsg) showToast(successMsg, 'success');
      return true;
    }
  } catch {
    // Fallback below
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok && successMsg) showToast(successMsg, 'success');
    return ok;
  } catch {
    showToast('复制失败，请手动复制', 'error');
    return false;
  }
}

async function withBusy(btn, fn) {
  if (btn) btn.classList.add('is-busy');
  try {
    return await fn();
  } finally {
    if (btn) btn.classList.remove('is-busy');
  }
}

function getExpandedStorageKey() {
  return `agy_nav_expanded_${currentWorkspaceUri || 'default'}`;
}

function loadExpandedDirsFromStorage() {
  try {
    const raw = localStorage.getItem(getExpandedStorageKey());
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        expandedDirs = new Set(arr);
        return;
      }
    }
  } catch {}
  expandedDirs = new Set();
}

function saveExpandedDirsToStorage() {
  try {
    const arr = Array.from(expandedDirs).slice(0, 300);
    localStorage.setItem(getExpandedStorageKey(), JSON.stringify(arr));
  } catch {}
}

let lastServerStartedAt = null;

async function api(path, body = {}) {
  try {
    const res = await window.sidecar.fetch(path, {
      method: 'POST',
      body: JSON.stringify({
        workspaceUri: currentWorkspaceUri,
        clientVersion: 13,
        ...body,
      }),
    });
    const data = await res.json();
    if (data && data.startedAt) {
      if (lastServerStartedAt && data.startedAt !== lastServerStartedAt) {
        window.location.reload();
        return data;
      }
      lastServerStartedAt = data.startedAt;
    }
    return data;
  } catch (err) {
    console.error(`API Error on ${path}:`, err);
    return { ok: false, error: err.message };
  }
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function highlightMatch(text, query) {
  if (!query) return escapeHtml(text);
  const lowerText = text.toLowerCase();
  const lowerQ = query.toLowerCase();
  const idx = lowerText.indexOf(lowerQ);
  if (idx === -1) return escapeHtml(text);
  const before = escapeHtml(text.slice(0, idx));
  const match = escapeHtml(text.slice(idx, idx + query.length));
  const after = escapeHtml(text.slice(idx + query.length));
  return `${before}<mark class="match-hl">${match}</mark>${after}`;
}

function formatSize(bytes) {
  if (!bytes || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// ---------------------------------------------------------------------------
// SVG Icon System
// ---------------------------------------------------------------------------
function makeBadgeIcon(bg, fg, text, fontSize = 10) {
  return `<svg viewBox="0 0 24 24" width="14" height="14"><rect width="24" height="24" rx="4" fill="${bg}"/><text x="12" y="16.2" fill="${fg}" font-size="${fontSize}" font-weight="900" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif">${text}</text></svg>`;
}

const ICONS = {
  folder: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#e0af68" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
  folderOpen: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#e0af68" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 11h20M2 11l3 9h14l3-9M2 11V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v3"/></svg>`,

  file: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
  js: makeBadgeIcon('#f7df1e', '#111', 'JS', 11),
  ts: makeBadgeIcon('#3178c6', '#fff', 'TS', 11),
  jsx: makeBadgeIcon('#06b6d4', '#0b1120', 'RX', 10),
  vue: makeBadgeIcon('#41b883', '#0b1120', 'V', 12),
  py: makeBadgeIcon('#3572A5', '#fff', 'PY', 10.5),
  go: makeBadgeIcon('#00add8', '#fff', 'GO', 10.5),
  rs: makeBadgeIcon('#dea584', '#111', 'RS', 10.5),
  java: makeBadgeIcon('#b07219', '#fff', 'JV', 10.5),
  c: makeBadgeIcon('#555555', '#fff', 'C', 12),
  cpp: makeBadgeIcon('#f34b7d', '#fff', 'C+', 10),
  cs: makeBadgeIcon('#178600', '#fff', 'C#', 10),
  json: makeBadgeIcon('#eab308', '#111', '{}', 11.5),
  yaml: makeBadgeIcon('#cb171e', '#fff', 'YM', 9.5),
  xml: makeBadgeIcon('#f97316', '#fff', 'XM', 9.5),
  sql: makeBadgeIcon('#0ea5e9', '#fff', 'SQ', 10),
  html: makeBadgeIcon('#e34c26', '#fff', '&lt;&gt;', 10.5),
  css: makeBadgeIcon('#7952b3', '#fff', '#', 13),
  md: makeBadgeIcon('#0284c7', '#fff', 'M↓', 10),
  docker: makeBadgeIcon('#2496ed', '#fff', 'DK', 10),
  env: makeBadgeIcon('#64748b', '#fff', 'EV', 10),
  archive: makeBadgeIcon('#9333ea', '#fff', 'ZP', 10),
  pdf: makeBadgeIcon('#dc2626', '#fff', 'PF', 10),
  image: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
  shell: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`,
  git: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#f05032" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>`,
  lock: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#eab308" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,

  view: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
  openExternal: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
  newFile: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>`,
  newFolder: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>`,
  reveal: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
  copy: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
  link: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
  rename: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
  agent: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  minus: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  check: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  undo: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`,
  hash: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></svg>`,
  chevron: `<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`,
  branch: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>`,
  remote: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
  merge: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/></svg>`,
  rebase: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/></svg>`,
  pull: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>`,
  push: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>`,
  diff: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>`,
  more: `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/><circle cx="5" cy="12" r="2"/></svg>`,
};

function getFileIcon(fileName) {
  const base = fileName.split('/').pop().toLowerCase();
  if (base === 'dockerfile' || base.startsWith('dockerfile.') || base === 'docker-compose.yml' || base === 'docker-compose.yaml') {
    return { icon: ICONS.docker, label: 'DOCKER' };
  }
  if (base === '.env' || base.startsWith('.env.')) {
    return { icon: ICONS.env, label: 'ENV' };
  }
  if (base === '.gitignore' || base === '.gitattributes' || base === '.gitmodules') {
    return { icon: ICONS.git, label: 'GIT' };
  }
  const ext = base.includes('.') ? base.split('.').pop() : '';
  switch (ext) {
    case 'js':
    case 'mjs':
    case 'cjs':
      return { icon: ICONS.js, label: 'JS' };
    case 'jsx':
    case 'tsx':
      return { icon: ICONS.jsx, label: 'JSX' };
    case 'ts':
      return { icon: ICONS.ts, label: 'TS' };
    case 'vue':
    case 'svelte':
      return { icon: ICONS.vue, label: 'VUE' };
    case 'py':
    case 'pyw':
      return { icon: ICONS.py, label: 'PY' };
    case 'go':
      return { icon: ICONS.go, label: 'GO' };
    case 'rs':
      return { icon: ICONS.rs, label: 'RS' };
    case 'java':
    case 'kt':
      return { icon: ICONS.java, label: 'JAVA' };
    case 'c':
    case 'h':
      return { icon: ICONS.c, label: 'C' };
    case 'cpp':
    case 'cc':
    case 'cxx':
    case 'hpp':
      return { icon: ICONS.cpp, label: 'CPP' };
    case 'cs':
      return { icon: ICONS.cs, label: 'CS' };
    case 'json':
    case 'jsonc':
      return { icon: ICONS.json, label: 'JSON' };
    case 'yml':
    case 'yaml':
    case 'toml':
      return { icon: ICONS.yaml, label: 'YAML' };
    case 'xml':
      return { icon: ICONS.xml, label: 'XML' };
    case 'sql':
      return { icon: ICONS.sql, label: 'SQL' };
    case 'html':
    case 'htm':
      return { icon: ICONS.html, label: 'HTML' };
    case 'css':
    case 'scss':
    case 'less':
      return { icon: ICONS.css, label: 'CSS' };
    case 'md':
    case 'markdown':
      return { icon: ICONS.md, label: 'MD' };
    case 'svg':
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'ico':
    case 'bmp':
      return { icon: ICONS.image, label: 'IMG' };
    case 'bat':
    case 'cmd':
    case 'ps1':
    case 'sh':
    case 'bash':
    case 'zsh':
      return { icon: ICONS.shell, label: 'SHELL' };
    case 'lock':
      return { icon: ICONS.lock, label: 'LOCK' };
    case 'zip':
    case 'tar':
    case 'gz':
    case '7z':
    case 'rar':
      return { icon: ICONS.archive, label: 'ZIP' };
    case 'pdf':
      return { icon: ICONS.pdf, label: 'PDF' };
    default:
      return { icon: ICONS.file, label: 'FILE' };
  }
}

// ---------------------------------------------------------------------------
// Context Menu, Input Prompt & Custom Confirm System
// ---------------------------------------------------------------------------
let activeContextMenuItems = [];
let promptResolver = null;
let confirmResolver = null;

function hideContextMenu() {
  const menu = $('#context-menu');
  if (menu) {
    menu.style.display = 'none';
    menu.innerHTML = '';
  }
  $$('.context-selected').forEach((el) => el.classList.remove('context-selected'));
  activeContextMenuItems = [];
}

function showContextMenu(x, y, items) {
  const menu = $('#context-menu');
  if (!menu) return;

  activeContextMenuItems = items;
  menu.innerHTML = items
    .map((item) => {
      if (item.type === 'divider') {
        return '<div class="menu-divider"></div>';
      }
      return `
        <div class="menu-item ${item.danger ? 'danger' : ''}" data-action="${escapeHtml(item.id)}">
          <span class="menu-icon">${item.icon || ''}</span>
          <span class="menu-label">${escapeHtml(item.label)}</span>
          ${item.hint ? `<span class="menu-hint">${escapeHtml(item.hint)}</span>` : ''}
        </div>
      `;
    })
    .join('');

  menu.style.display = 'block';

  const rect = menu.getBoundingClientRect();
  const winW = window.innerWidth;
  const winH = window.innerHeight;
  const left = x + rect.width > winW - 8 ? Math.max(8, winW - rect.width - 8) : Math.max(8, x);
  const top = y + rect.height > winH - 8 ? Math.max(8, winH - rect.height - 8) : Math.max(8, y);

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function showPromptModal({ title, desc, defaultValue = '', placeholder = '' }) {
  return new Promise((resolve) => {
    const modal = $('#modal-prompt');
    $('#prompt-title').textContent = title || '输入名称';
    $('#prompt-desc').textContent = desc || '请输入新名称：';
    const inputEl = $('#prompt-input');
    inputEl.value = defaultValue;
    inputEl.placeholder = placeholder;

    modal.style.display = 'flex';
    setTimeout(() => {
      inputEl.focus();
      inputEl.select();
    }, 30);

    promptResolver = resolve;
  });
}

function closePromptModal(result = null) {
  const modal = $('#modal-prompt');
  if (modal) modal.style.display = 'none';
  if (promptResolver) {
    const fn = promptResolver;
    promptResolver = null;
    fn(result);
  }
}

function showConfirmModal({ title = '确认操作', message = '', confirmText = '确定', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    const modal = $('#modal-confirm');
    $('#confirm-title').textContent = title;
    $('#confirm-message').textContent = message;
    const okBtn = $('#btn-confirm-ok');
    const cancelBtn = $('#btn-confirm-cancel');
    okBtn.textContent = confirmText;
    cancelBtn.textContent = cancelText;
    okBtn.className = `btn btn-sm ${danger ? 'btn-danger' : 'btn-primary'}`;

    modal.style.display = 'flex';
    setTimeout(() => okBtn.focus(), 30);
    confirmResolver = resolve;
  });
}

function closeConfirmModal(confirmed = false) {
  const modal = $('#modal-confirm');
  if (modal) modal.style.display = 'none';
  if (confirmResolver) {
    const fn = confirmResolver;
    confirmResolver = null;
    fn(confirmed);
  }
}

// ---------------------------------------------------------------------------
// Basic File Operations
// ---------------------------------------------------------------------------
function expandAncestorsForPath(relPath) {
  if (!relPath) return;
  const clean = relPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const segs = clean.split('/').filter(Boolean);
  for (let i = 1; i < segs.length; i++) {
    expandedDirs.add(segs.slice(0, i).join('/'));
  }
}

async function handleCreateFile(parentDir = '') {
  const name = await showPromptModal({
    title: '新建文件',
    desc: `在 ${parentDir ? `"${parentDir}"` : '工作区根目录'} 下新建文件：`,
    placeholder: '例如: index.js 或 utils/helper.ts',
  });
  if (!name) return;
  const res = await api('/api/files/create', { parentPath: parentDir, name, type: 'file' });
  if (res.ok) {
    showToast(`已创建文件: ${name}`, 'success');
    const createdRel = res.relativePath || (parentDir ? `${parentDir}/${name}` : name);
    if (parentDir) expandedDirs.add(parentDir);
    expandAncestorsForPath(createdRel);
    saveExpandedDirsToStorage();
    await Promise.all([loadFileTree(true), loadGitStatus()]);
    openFileViewer(createdRel);
  } else {
    showToast(`创建失败: ${res.error}`, 'error');
  }
}

async function handleCreateFolder(parentDir = '') {
  const name = await showPromptModal({
    title: '新建文件夹',
    desc: `在 ${parentDir ? `"${parentDir}"` : '工作区根目录'} 下新建文件夹：`,
    placeholder: '例如: src 或 components/ui',
  });
  if (!name) return;
  const res = await api('/api/files/create', { parentPath: parentDir, name, type: 'directory' });
  if (res.ok) {
    showToast(`已创建文件夹: ${name}`, 'success');
    const createdRel = res.relativePath || (parentDir ? `${parentDir}/${name}` : name);
    if (parentDir) expandedDirs.add(parentDir);
    expandAncestorsForPath(createdRel);
    expandedDirs.add(createdRel);
    saveExpandedDirsToStorage();
    await Promise.all([loadFileTree(true), loadGitStatus()]);
  } else {
    showToast(`创建失败: ${res.error}`, 'error');
  }
}

async function handleRenameItem(oldRelPath) {
  const oldName = oldRelPath.split('/').pop();
  const newName = await showPromptModal({
    title: '重命名',
    desc: `重命名 "${oldName}" 为：`,
    defaultValue: oldName,
  });
  if (!newName || newName === oldName) return;
  const res = await api('/api/files/rename', { oldRelPath, newName });
  if (res.ok) {
    showToast(`已重命名为: ${newName}`, 'success');
    if (expandedDirs.has(oldRelPath) && res.newRelPath) {
      expandedDirs.delete(oldRelPath);
      expandedDirs.add(res.newRelPath);
      saveExpandedDirsToStorage();
    }
    if (activeFilePath === oldRelPath) {
      activeFilePath = res.newRelPath || null;
      updateActivePathBar();
    }
    await refreshAll();
  } else {
    showToast(`重命名失败: ${res.error}`, 'error');
  }
}

async function handleDeleteItem(relPath) {
  const confirmed = await showConfirmModal({
    title: '确认删除',
    message: `确定要彻底删除 "${relPath}" 吗？\n此操作无法撤销。`,
    confirmText: '彻底删除',
    danger: true,
  });
  if (!confirmed) return;

  const res = await api('/api/files/delete', { relativePath: relPath });
  if (res.ok) {
    showToast(`已删除: ${relPath}`, 'success');
    expandedDirs.delete(relPath);
    saveExpandedDirsToStorage();
    if (activeFilePath === relPath) {
      activeFilePath = null;
      updateActivePathBar();
    }
    await refreshAll();
  } else {
    showToast(`删除失败: ${res.error}`, 'error');
  }
}

async function sendFileToAgentDirect(relPath) {
  const res = await api('/api/files/read', { relativePath: relPath });
  if (!res.ok) {
    showToast(`读取文件失败: ${res.error}`, 'error');
    return;
  }
  if (res.isImage && !res.isSvg) {
    showToast('图片文件请直接在对话中引用路径', 'info');
    return;
  }
  const content = res.content || '';
  const truncated = content.length > 5000 ? content.slice(0, 5000) + '\n\n...[已截断过长内容]...' : content;
  const prompt = `请帮我查看并分析工作区文件 \`${relPath}\`：\n\`\`\`\n${truncated}\n\`\`\``;
  if (window.sidecar && window.sidecar.agent) {
    window.sidecar.agent.sendMessage(prompt);
    showToast('已将文件发送给 Agent', 'success');
  } else {
    await copyText(prompt, '已复制文件提示词到剪贴板');
  }
}

async function sendChangeDiffToAgent(path, staged) {
  const res = await api('/api/git/diff', { relativePath: path, staged });
  if (!res.ok || !res.diff) {
    showToast('无可用 Diff', 'error');
    return;
  }
  const diff = res.diff;
  const truncated = diff.length > 6000 ? diff.slice(0, 6000) + '\n\n...[已截断过长 Diff]...' : diff;
  const prompt = `请帮我 Review 文件 \`${path}\` 的代码改动 (${staged ? '暂存区' : '工作区'} Diff)：\n\`\`\`diff\n${truncated}\n\`\`\``;
  if (window.sidecar && window.sidecar.agent) {
    window.sidecar.agent.sendMessage(prompt);
    showToast('已将 Diff 发送给 Agent Review', 'success');
  } else {
    await copyText(prompt, '已复制 Diff 提示词到剪贴板');
  }
}

async function sendCommitToAgentDirect(hash, subject) {
  const res = await api('/api/git/diff', { commitHash: hash });
  const diff = res.ok && res.diff ? res.diff : '';
  const truncated = diff.length > 6000 ? diff.slice(0, 6000) + '\n\n...[已截断过长 Diff]...' : diff;
  const prompt = `请帮我分析 Commit [${hash.slice(0, 7)}] "${subject}" 的改动：\n\`\`\`diff\n${truncated}\n\`\`\``;
  if (window.sidecar && window.sidecar.agent) {
    window.sidecar.agent.sendMessage(prompt);
    showToast('已将 Commit 发送给 Agent', 'success');
  } else {
    await copyText(prompt, '已复制提示词到剪贴板');
  }
}

// ---------------------------------------------------------------------------
// File Tree Rendering & Lazy-Loading Logic
// ---------------------------------------------------------------------------
function findTreeNode(entries, targetPath) {
  for (const ent of entries) {
    if (ent.path === targetPath) return ent;
    if (ent.type === 'directory' && ent.children && targetPath.startsWith(ent.path + '/')) {
      const found = findTreeNode(ent.children, targetPath);
      if (found) return found;
    }
  }
  return null;
}

async function loadFileTree(silent = false) {
  const container = $('#file-tree-container');
  const prevScroll = container ? container.scrollTop : 0;

  if (!silent && fileTreeData.length === 0 && container) {
    container.innerHTML = `
      <div class="loading-state">
        <div class="spinner"></div>
        <span>正在扫描工作区文件...</span>
      </div>
    `;
  }

  const res = await api('/api/files/tree', {
    maxDepth: 2,
    expandedPaths: Array.from(expandedDirs),
    showIgnored: showIgnoredFiles,
  });
  if (!res.ok) {
    if (container) {
      container.innerHTML = `<div class="empty-state"><p>扫描失败: ${escapeHtml(res.error)}</p></div>`;
    }
    return;
  }

  fileTreeData = res.tree || [];
  fileTreeTruncated = !!res.truncated;
  currentWorkspacePath = res.workspace || '';
  if (typeof res.watchVersion === 'number' && lastWatchVersion === 0) {
    lastWatchVersion = res.watchVersion;
  }
  if (typeof res.gitWatchVersion === 'number' && lastGitWatchVersion === 0) {
    lastGitWatchVersion = res.gitWatchVersion;
  }
  if (typeof res.watchActive === 'boolean') {
    watchActive = res.watchActive;
  }

  updateWorkspaceBadge(res.workspace);
  updateTreeCounts(fileTreeData);
  renderFileTree();

  if (container && prevScroll > 0) {
    container.scrollTop = prevScroll;
  }

  if (filterText) {
    runRemoteFileSearch(filterText);
  }
}

async function runRemoteFileSearch(query) {
  const q = (query || '').trim();
  if (!q) {
    remoteSearchTree = null;
    remoteSearchQuery = '';
    remoteSearchTruncated = false;
    renderFileTree();
    return;
  }

  const seq = ++remoteSearchSeq;
  const res = await api('/api/files/search', {
    query: q,
    showIgnored: showIgnoredFiles,
    limit: 250,
  });
  if (seq !== remoteSearchSeq || q !== filterText) return;
  if (res.ok) {
    remoteSearchTree = res.tree || [];
    remoteSearchQuery = q;
    remoteSearchTruncated = !!res.truncated;
    updateTreeCounts(fileTreeData);
    renderFileTree();
  }
}

async function loadSubdirectory(dirPath, { silent = false } = {}) {
  if (loadingDirs.has(dirPath)) return;
  if (!silent) {
    loadingDirs.add(dirPath);
    renderFileTree();
  }

  try {
    const res = await api('/api/files/tree', {
      subPath: dirPath,
      maxDepth: 1,
      expandedPaths: Array.from(expandedDirs),
      showIgnored: showIgnoredFiles,
    });
    if (res.ok) {
      const node = findTreeNode(fileTreeData, dirPath);
      if (node && node.type === 'directory') {
        node.children = res.tree || [];
        node.hasChildren = node.children.length > 0;
        updateTreeCounts(fileTreeData);
      }
      if (remoteSearchTree) {
        const searchNode = findTreeNode(remoteSearchTree, dirPath);
        if (searchNode && searchNode.type === 'directory') {
          searchNode.children = res.tree || [];
          searchNode.hasChildren = searchNode.children.length > 0;
        }
      }
    } else if (!silent) {
      showToast(`加载目录失败: ${res.error}`, 'error');
    }
  } finally {
    if (!silent) loadingDirs.delete(dirPath);
    renderFileTree();
  }
}

function countTreeNodes(entries) {
  let files = 0;
  let dirs = 0;
  for (const ent of entries) {
    if (ent.type === 'directory') {
      dirs += 1;
      if (ent.children) {
        const sub = countTreeNodes(ent.children);
        files += sub.files;
        dirs += sub.dirs;
      }
    } else {
      files += 1;
    }
  }
  return { files, dirs };
}

function updateTreeCounts(entries) {
  const { files, dirs } = countTreeNodes(entries);
  const filesEl = $('#stat-files-count');
  const dirsEl = $('#stat-dirs-count');
  const notGitFilesEl = $('#not-git-files-val');
  const footHint = $('#tree-foot-hint');
  if (filesEl) filesEl.textContent = files;
  if (dirsEl) dirsEl.textContent = dirs;
  if (notGitFilesEl) notGitFilesEl.textContent = `${files} 项`;
  if (footHint) {
    if (filterText && remoteSearchTruncated) {
      footHint.textContent = '搜索结果已达上限 · 可输入更精确关键字';
    } else if (gitOnlyFilter) {
      footHint.textContent = '当前仅显示 Git 变更文件';
    } else if (showIgnoredFiles) {
      footHint.textContent = '已显示隐藏/忽略目录 · 右键更多操作';
    } else if (fileTreeTruncated) {
      footHint.textContent = '深层目录按需懒加载 · 右键更多操作';
    } else {
      footHint.textContent = '右键节点更多操作';
    }
  }
}

function updateWorkspaceBadge(fullPath) {
  const badge = $('#ws-badge');
  const textEl = $('#ws-badge-text') || badge;
  const notGitWsEl = $('#not-git-ws-name');
  if (!fullPath) {
    if (textEl) textEl.textContent = '无工作区';
    if (badge) badge.title = '';
    return;
  }
  const folderName = fullPath.split(/[/\\]/).filter(Boolean).pop() || fullPath;
  const multiHint = availableWorkspaceUris.length > 1 ? ` (${availableWorkspaceUris.length})` : '';
  if (textEl) textEl.textContent = folderName + multiHint;
  if (badge) {
    badge.title =
      availableWorkspaceUris.length > 1
        ? `${fullPath} (点击切换工作区或复制路径)`
        : `${fullPath} (点击复制路径)`;
  }
  if (notGitWsEl) notGitWsEl.textContent = `工作区 "${folderName}" 尚未初始化 Git`;
}

function buildGitChangedTree(baseTree, statusMap) {
  const rootMap = new Map();

  function ensureDir(dirPath) {
    const segs = dirPath.split('/').filter(Boolean);
    let curMap = rootMap;
    let acc = '';
    let node = null;
    for (const seg of segs) {
      acc = acc ? `${acc}/${seg}` : seg;
      node = curMap.get(acc);
      if (!node) {
        node = {
          name: seg,
          path: acc,
          type: 'directory',
          hasChildren: true,
          children: [],
          _childMap: new Map(),
        };
        curMap.set(acc, node);
      }
      curMap = node._childMap;
    }
    return node;
  }

  for (const filePath of statusMap.keys()) {
    const clean = filePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!clean) continue;
    const existing = findTreeNode(baseTree, clean);
    const fileName = clean.split('/').pop();
    const fileNode =
      existing && existing.type === 'file'
        ? { ...existing }
        : { name: fileName, path: clean, type: 'file', size: 0 };

    const idx = clean.lastIndexOf('/');
    if (idx === -1) {
      rootMap.set(clean, fileNode);
    } else {
      const parent = ensureDir(clean.slice(0, idx));
      parent._childMap.set(clean, fileNode);
    }
  }

  function finalize(map) {
    const arr = Array.from(map.values());
    arr.sort((a, b) => {
      const aDir = a.type === 'directory';
      const bDir = b.type === 'directory';
      if (aDir === bDir) {
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      }
      return aDir ? -1 : 1;
    });
    for (const item of arr) {
      if (item.type === 'directory' && item._childMap) {
        item.children = finalize(item._childMap);
        item.hasChildren = item.children.length > 0;
        delete item._childMap;
      }
    }
    return arr;
  }

  return finalize(rootMap);
}

function filterTree(entries, query, onlyGit) {
  if (!query && !onlyGit) return entries;
  const q = query.toLowerCase();

  const filtered = [];
  for (const ent of entries) {
    if (ent.type === 'directory') {
      const matchedChildren = ent.children ? filterTree(ent.children, q, onlyGit) : [];
      const nameMatches = q ? ent.name.toLowerCase().includes(q) || ent.path.toLowerCase().includes(q) : false;
      const gitMatches = onlyGit ? dirHasGitChanges(ent.path) : true;
      if (matchedChildren.length > 0 || (nameMatches && gitMatches)) {
        filtered.push({
          ...ent,
          ...(matchedChildren.length > 0 ? { children: matchedChildren } : {}),
        });
      }
    } else {
      const matchesQuery = !q || ent.name.toLowerCase().includes(q) || ent.path.toLowerCase().includes(q);
      const matchesGit = !onlyGit || gitFileStatusMap.has(ent.path);
      if (matchesQuery && matchesGit) {
        filtered.push(ent);
      }
    }
  }
  return filtered;
}

function renderFileTree() {
  const container = $('#file-tree-container');
  if (!container) return;

  const prevScroll = container.scrollTop;
  const isFiltering = Boolean(filterText || gitOnlyFilter);
  let sourceTree = fileTreeData;
  if (gitOnlyFilter) {
    sourceTree = buildGitChangedTree(fileTreeData, gitFileStatusMap);
  } else if (filterText && remoteSearchTree && remoteSearchQuery === filterText) {
    sourceTree = remoteSearchTree;
  }
  const filtered =
    !gitOnlyFilter && filterText && remoteSearchTree && remoteSearchQuery === filterText
      ? sourceTree
      : filterTree(sourceTree, filterText, gitOnlyFilter);

  if (filtered.length === 0) {
    let emptyMsg = '当前工作区为空';
    if (gitOnlyFilter && filterText) emptyMsg = '未找到匹配的 Git 变更文件';
    else if (gitOnlyFilter) emptyMsg = '当前没有未提交的 Git 变更文件';
    else if (filterText) emptyMsg = '未找到匹配的文件或目录';
    container.innerHTML = `<div class="empty-state"><p>${emptyMsg}</p></div>`;
    return;
  }

  const html = [];
  buildTreeHtml(filtered, 0, html, isFiltering);
  container.innerHTML = html.join('');
  container.scrollTop = prevScroll;
}

function rebuildGitFileStatusMap() {
  gitFileStatusMap.clear();
  if (!gitChanges) return;
  for (const item of gitChanges.untracked || []) {
    gitFileStatusMap.set(item.path, 'U');
  }
  for (const item of gitChanges.unstaged || []) {
    gitFileStatusMap.set(item.path, item.status || 'M');
  }
  for (const item of gitChanges.staged || []) {
    gitFileStatusMap.set(item.path, item.status || 'A');
  }
  for (const item of gitChanges.conflicts || []) {
    gitFileStatusMap.set(item.path, 'C');
  }
}

function dirHasGitChanges(dirPath) {
  if (!dirPath || gitFileStatusMap.size === 0) return false;
  const prefix = dirPath + '/';
  for (const filePath of gitFileStatusMap.keys()) {
    if (filePath.startsWith(prefix)) return true;
  }
  return false;
}

function buildTreeHtml(entries, depth, html, forceExpand = false) {
  const indents = '<span class="tree-indent"></span>'.repeat(depth);

  for (const ent of entries) {
    const isDir = ent.type === 'directory';
    const isExpanded = forceExpand || expandedDirs.has(ent.path);
    const isLoading = loadingDirs.has(ent.path);

    if (isDir) {
      const hasChanges = dirHasGitChanges(ent.path);
      const hasRenderableChildren = Array.isArray(ent.children) && ent.children.length > 0;
      const effectiveExpanded = forceExpand ? hasRenderableChildren || expandedDirs.has(ent.path) : isExpanded;
      const chevronHtml = isLoading
        ? '<span class="tree-chevron"><span class="tree-spinner"></span></span>'
        : `<span class="tree-chevron ${effectiveExpanded ? 'expanded' : ''}" ${!ent.hasChildren && (!ent.children || ent.children.length === 0) ? 'style="opacity:0.3;"' : ''}>${ICONS.chevron}</span>`;
      const symlinkBadge = ent.isSymlink
        ? `<span class="tree-symlink-badge" title="符号链接目录">↗</span>`
        : '';

      html.push(`
        <div class="tree-row tree-dir" data-path="${escapeHtml(ent.path)}" data-depth="${depth}">
          ${indents}
          ${chevronHtml}
          <span class="tree-icon">${effectiveExpanded ? ICONS.folderOpen : ICONS.folder}</span>
          <span class="tree-label">${highlightMatch(ent.name, filterText)}</span>
          ${symlinkBadge}
          ${hasChanges ? `<span class="tree-git-dot" title="目录内含 Git 未提交更改"></span>` : ''}
          <div class="tree-actions">
            <button type="button" class="mini-icon-btn" data-tree-act="new-file" data-path="${escapeHtml(ent.path)}" title="在此目录新建文件">${ICONS.newFile}</button>
            <button type="button" class="mini-icon-btn" data-tree-act="new-folder" data-path="${escapeHtml(ent.path)}" title="在此目录新建文件夹">${ICONS.newFolder}</button>
          </div>
        </div>
      `);
      if (effectiveExpanded && ent.children) {
        buildTreeHtml(ent.children, depth + 1, html, forceExpand);
      }
    } else {
      const fileIcon = getFileIcon(ent.name);
      const sizeStr = formatSize(ent.size);
      const gitSt = gitFileStatusMap.get(ent.path);
      const isActive = activeFilePath === ent.path;
      const symlinkBadge = ent.isSymlink
        ? `<span class="tree-symlink-badge ${ent.brokenSymlink ? 'is-broken' : ''}" title="${ent.brokenSymlink ? '失效符号链接' : '符号链接'}">↗</span>`
        : '';
      html.push(`
        <div class="tree-row tree-file ${isActive ? 'active' : ''}" data-path="${escapeHtml(ent.path)}" title="${escapeHtml(ent.path)} (${sizeStr})">
          ${indents}
          <span class="tree-chevron" style="visibility: hidden;">${ICONS.chevron}</span>
          <span class="tree-icon">${fileIcon.icon}</span>
          <span class="tree-label">${highlightMatch(ent.name, filterText)}</span>
          ${symlinkBadge}
          ${gitSt ? `<span class="tree-git-badge git-${gitSt}" title="Git 状态: ${gitSt}">${gitSt}</span>` : ''}
          <div class="tree-actions">
            <button type="button" class="mini-icon-btn" data-tree-act="open-agy" data-path="${escapeHtml(ent.path)}" title="在 Antigravity 中打开">${ICONS.openExternal}</button>
            <button type="button" class="mini-icon-btn" data-tree-act="view" data-path="${escapeHtml(ent.path)}" title="在面板内预览">${ICONS.view}</button>
            <button type="button" class="mini-icon-btn" data-tree-act="copy-path" data-path="${escapeHtml(ent.path)}" title="复制相对路径">${ICONS.copy}</button>
          </div>
        </div>
      `);
    }
  }
}

function updateActivePathBar() {
  const bar = $('#active-path-bar');
  const textEl = $('#active-path-text');
  if (!bar || !textEl) return;
  if (activeFilePath) {
    textEl.textContent = activeFilePath;
    textEl.title = activeFilePath;
    bar.style.display = 'flex';
  } else {
    bar.style.display = 'none';
  }
}

function setupFileTreeDelegation() {
  const container = $('#file-tree-container');
  if (!container) return;

  container.addEventListener('click', (e) => {
    const actBtn = e.target.closest('[data-tree-act]');
    if (actBtn) {
      e.stopPropagation();
      const act = actBtn.getAttribute('data-tree-act');
      const path = actBtn.getAttribute('data-path');
      if (act === 'open-agy') {
        activeFilePath = path;
        updateActivePathBar();
        renderFileTree();
        openInAgyHost(path);
      } else if (act === 'view') {
        activeFilePath = path;
        updateActivePathBar();
        renderFileTree();
        openFileViewer(path);
      } else if (act === 'copy-path') {
        copyText(path, `已复制路径: ${path}`);
      } else if (act === 'new-file') {
        handleCreateFile(path);
      } else if (act === 'new-folder') {
        handleCreateFolder(path);
      }
      return;
    }

    const row = e.target.closest('.tree-row');
    if (!row) return;
    const path = row.getAttribute('data-path');

    if (row.classList.contains('tree-dir')) {
      if (expandedDirs.has(path)) {
        expandedDirs.delete(path);
        saveExpandedDirsToStorage();
        renderFileTree();
      } else {
        expandedDirs.add(path);
        saveExpandedDirsToStorage();
        const node =
          (remoteSearchTree && remoteSearchQuery === filterText ? findTreeNode(remoteSearchTree, path) : null) ||
          findTreeNode(fileTreeData, path);
        if (node && node.children === undefined && node.hasChildren) {
          loadSubdirectory(path);
        } else {
          renderFileTree();
          if (node && !watchActive) {
            loadSubdirectory(path, { silent: true });
          }
        }
      }
    } else if (row.classList.contains('tree-file')) {
      activeFilePath = path;
      updateActivePathBar();
      renderFileTree();
      openInAgyHost(path);
    }
  });

  container.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    hideContextMenu();

    const row = e.target.closest('.tree-row');
    if (!row) {
      showContextMenu(e.clientX, e.clientY, [
        { id: 'new-file-root', icon: ICONS.newFile, label: '新建文件...', handler: () => handleCreateFile('') },
        { id: 'new-folder-root', icon: ICONS.newFolder, label: '新建文件夹...', handler: () => handleCreateFolder('') },
        { type: 'divider' },
        { id: 'refresh', icon: ICONS.refresh, label: '刷新目录树', handler: () => loadFileTree(true) },
        { id: 'reveal-root', icon: ICONS.reveal, label: '在系统资源管理器中显示', handler: () => api('/api/files/reveal', { relativePath: '' }) },
      ]);
      return;
    }

    row.classList.add('context-selected');
    const path = row.getAttribute('data-path');
    const absPath = (currentWorkspacePath ? currentWorkspacePath + '/' + path : path).replace(/\\/g, '/');

    if (row.classList.contains('tree-dir')) {
      showContextMenu(e.clientX, e.clientY, [
        { id: 'new-file', icon: ICONS.newFile, label: '新建文件...', handler: () => handleCreateFile(path) },
        { id: 'new-folder', icon: ICONS.newFolder, label: '新建文件夹...', handler: () => handleCreateFolder(path) },
        { id: 'reveal', icon: ICONS.reveal, label: '在系统资源管理器中显示', handler: () => api('/api/files/reveal', { relativePath: path }) },
        { type: 'divider' },
        { id: 'copy-rel', icon: ICONS.copy, label: '复制相对路径', handler: () => copyText(path, `已复制: ${path}`) },
        { id: 'copy-abs', icon: ICONS.link, label: '复制完整路径', handler: () => copyText(absPath, '已复制完整路径') },
        { type: 'divider' },
        { id: 'rename', icon: ICONS.rename, label: '重命名...', handler: () => handleRenameItem(path) },
        { id: 'delete', icon: ICONS.trash, label: '删除文件夹', danger: true, handler: () => handleDeleteItem(path) },
      ]);
      return;
    }

    const parentDir = path.includes('/') ? path.split('/').slice(0, -1).join('/') : '';
    const gitSt = gitFileStatusMap.get(path);
    const items = [
      { id: 'open-agy', icon: ICONS.openExternal, label: '在 Antigravity 中打开', handler: () => openInAgyHost(path) },
      { id: 'open-preview', icon: ICONS.view, label: '在面板内预览', handler: () => openFileViewer(path) },
    ];
    if (gitSt) {
      items.push({
        id: 'open-diff',
        icon: ICONS.diff,
        label: '查看 Git 变更 Diff',
        handler: () => openDiffViewer({ path, staged: false }),
      });
    }
    items.push(
      { id: 'reveal', icon: ICONS.reveal, label: '在系统资源管理器中显示', handler: () => api('/api/files/reveal', { relativePath: path }) },
      { type: 'divider' },
      { id: 'new-file', icon: ICONS.newFile, label: '新建同级文件...', handler: () => handleCreateFile(parentDir) },
      { id: 'new-folder', icon: ICONS.newFolder, label: '新建同级文件夹...', handler: () => handleCreateFolder(parentDir) },
      { type: 'divider' },
      { id: 'copy-rel', icon: ICONS.copy, label: '复制相对路径', handler: () => copyText(path, `已复制: ${path}`) },
      { id: 'copy-abs', icon: ICONS.link, label: '复制完整路径', handler: () => copyText(absPath, '已复制完整路径') },
      { type: 'divider' },
      { id: 'rename', icon: ICONS.rename, label: '重命名...', handler: () => handleRenameItem(path) },
      { id: 'delete', icon: ICONS.trash, label: '删除文件', danger: true, handler: () => handleDeleteItem(path) },
      { type: 'divider' },
      { id: 'send-agent', icon: ICONS.agent, label: '发送给 Agent 分析', handler: () => sendFileToAgentDirect(path) }
    );
    showContextMenu(e.clientX, e.clientY, items);
  });
}

// ---------------------------------------------------------------------------
// Open in Antigravity Host Editor
// ---------------------------------------------------------------------------
function openInAgyHost(relPath) {
  if (!relPath) return;
  let uri = '';
  if (relPath.startsWith('file://')) {
    uri = relPath;
  } else if (currentWorkspaceUri) {
    const baseUri = currentWorkspaceUri.replace(/\/+$/, '');
    const cleanRel = relPath.replace(/^[/\\]+/, '').replace(/\\/g, '/');
    uri = `${baseUri}/${cleanRel}`;
  } else {
    const cleanPath = relPath.replace(/\\/g, '/');
    uri = cleanPath.startsWith('/') ? `file://${cleanPath}` : `file:///${cleanPath}`;
  }

  if (window.parent && window.parent !== window) {
    window.parent.postMessage(
      {
        type: 'toggle-aux-pane',
        payload: {
          tabType: 'fileView',
          uri,
        },
      },
      '*'
    );
    showToast(`已在编辑器中打开: ${relPath.split('/').pop()}`);
  } else {
    openFileViewer(relPath);
  }
}

// ---------------------------------------------------------------------------
// File Viewer Modal (Line-Numbered Code & Image Preview)
// ---------------------------------------------------------------------------
function renderCodeWithLineNumbers(content, container) {
  const lines = content.split('\n');
  const maxRender = 4000;
  const capped = lines.length > maxRender;
  const slice = capped ? lines.slice(0, maxRender) : lines;

  const html = slice.map(
    (line, idx) =>
      `<div class="code-line"><span class="code-ln">${idx + 1}</span><span class="code-text">${escapeHtml(line) || ' '}</span></div>`
  );
  if (capped) {
    html.push(
      `<div class="diff-truncate-bar"><span>文件共 ${lines.length} 行，已渲染前 ${maxRender} 行以保证流畅。</span></div>`
    );
  }
  container.innerHTML = html.join('');
}

async function openFileViewer(relPath) {
  activePreviewFile = relPath;
  activePreviewContent = '';
  const modal = $('#modal-file-viewer');
  const titleEl = $('#preview-file-path');
  const iconEl = $('#preview-file-icon');
  const metaEl = $('#preview-file-meta');
  const codeWrap = $('#preview-code-container');
  const codeEl = $('#preview-code-content');
  const imgWrap = $('#preview-image-wrap');
  const copyBtn = $('#btn-copy-file-content');
  const wrapBtn = $('#btn-preview-wrap');

  const fileIcon = getFileIcon(relPath);
  iconEl.innerHTML = fileIcon.icon;
  titleEl.textContent = relPath;
  metaEl.textContent = '加载中...';
  if (imgWrap) {
    imgWrap.style.display = 'none';
    imgWrap.innerHTML = '';
  }
  if (codeWrap) codeWrap.style.display = 'block';
  codeEl.innerHTML = '<div class="loading-state"><div class="spinner"></div><span>正在读取文件内容...</span></div>';
  modal.style.display = 'flex';

  const res = await api('/api/files/read', { relativePath: relPath });
  if (!res.ok) {
    codeEl.innerHTML = `<div class="empty-state"><p>读取失败: ${escapeHtml(res.error)}</p></div>`;
    metaEl.textContent = '读取错误';
    return;
  }

  if (res.isImage && res.dataUrl) {
    metaEl.textContent = `IMAGE · ${formatSize(res.size)}`;
    if (codeWrap) codeWrap.style.display = 'none';
    if (copyBtn) copyBtn.style.display = 'none';
    if (wrapBtn) wrapBtn.style.display = 'none';
    if (imgWrap) {
      imgWrap.style.display = 'flex';
      imgWrap.innerHTML = `<img src="${res.dataUrl}" alt="${escapeHtml(relPath)}" /><span class="code-pill">${escapeHtml(res.mimeType || 'image')} · ${formatSize(res.size)}</span>`;
    }
    return;
  }

  if (copyBtn) copyBtn.style.display = 'inline-flex';
  if (wrapBtn) wrapBtn.style.display = 'inline-flex';

  if (res.isSvg && res.dataUrl && imgWrap) {
    imgWrap.style.display = 'flex';
    imgWrap.innerHTML = `<img src="${res.dataUrl}" alt="${escapeHtml(relPath)}" style="max-height:140px;" />`;
  }

  activePreviewContent = res.content || '';
  metaEl.textContent = `${res.lines || 0} 行 · ${formatSize(res.size)}`;
  renderCodeWithLineNumbers(activePreviewContent, codeEl);
}

function closeFileViewer() {
  const modal = $('#modal-file-viewer');
  if (modal) modal.style.display = 'none';
  activePreviewFile = null;
  activePreviewContent = '';
}

async function refreshActiveFilePreviewSilent() {
  const modal = $('#modal-file-viewer');
  if (!activePreviewFile || !modal || modal.style.display === 'none') return;
  const relPath = activePreviewFile;
  const codeWrap = $('#preview-code-container');
  const codeEl = $('#preview-code-content');
  const metaEl = $('#preview-file-meta');
  const imgWrap = $('#preview-image-wrap');
  const prevScroll = codeWrap ? codeWrap.scrollTop : 0;

  const res = await api('/api/files/read', { relativePath: relPath });
  if (activePreviewFile !== relPath || modal.style.display === 'none') return;
  if (!res.ok) return;

  if (res.isImage && res.dataUrl) {
    if (metaEl) metaEl.textContent = `IMAGE · ${formatSize(res.size)}`;
    if (imgWrap) {
      imgWrap.innerHTML = `<img src="${res.dataUrl}" alt="${escapeHtml(relPath)}" /><span class="code-pill">${escapeHtml(res.mimeType || 'image')} · ${formatSize(res.size)}</span>`;
    }
    return;
  }

  const nextContent = res.content || '';
  if (nextContent === activePreviewContent) return;
  activePreviewContent = nextContent;
  if (metaEl) metaEl.textContent = `${res.lines || 0} 行 · ${formatSize(res.size)}`;
  if (res.isSvg && res.dataUrl && imgWrap) {
    imgWrap.innerHTML = `<img src="${res.dataUrl}" alt="${escapeHtml(relPath)}" style="max-height:140px;" />`;
  }
  if (codeEl) renderCodeWithLineNumbers(activePreviewContent, codeEl);
  if (codeWrap) codeWrap.scrollTop = prevScroll;
}

// ---------------------------------------------------------------------------
// Git Operations & UI Updates
// ---------------------------------------------------------------------------
function updateHeaderBranchPill() {
  const pill = $('#header-branch-pill');
  const textEl = $('#header-branch-text');
  const dotEl = $('#header-branch-dot');
  if (!pill || !textEl) return;

  if (!gitInfo.isGit) {
    pill.style.display = 'none';
    return;
  }

  pill.style.display = 'inline-flex';
  textEl.textContent = gitInfo.branch || 'HEAD';
  const conflictCount = gitChanges.conflicts?.length || 0;
  const totalChanges = gitChanges.totalChanges || 0;
  if (dotEl) {
    dotEl.className = `status-dot${conflictCount > 0 ? ' conflict' : totalChanges > 0 ? ' dirty' : ''}`;
  }
  pill.title = `当前分支: ${gitInfo.branch}${totalChanges > 0 ? ` (${totalChanges} 项未提交变更)` : ' (工作区干净)'} — 点击切换至源代码管理`;
}

function updateCommitButtonLabel() {
  const lbl = $('#btn-git-commit-label');
  if (!lbl) return;
  const amend = !!$('#chk-commit-amend')?.checked;
  const stagedCount = gitChanges.staged?.length || 0;
  const workingCount = (gitChanges.unstaged?.length || 0) + (gitChanges.untracked?.length || 0);

  if (amend) {
    lbl.textContent = '修正提交';
  } else if (stagedCount > 0) {
    lbl.textContent = `提交暂存 (${stagedCount})`;
  } else if (workingCount > 0) {
    lbl.textContent = `全部提交 (${workingCount})`;
  } else {
    lbl.textContent = '提交更改';
  }
}

async function loadGitData() {
  const infoRes = await api('/api/git/info');
  if (!infoRes.ok || !infoRes.isGit) {
    gitInfo = { isGit: false, branch: '', detached: false, upstream: '', ahead: 0, behind: 0, stashCount: 0 };
    gitChanges = { conflicts: [], staged: [], unstaged: [], untracked: [], totalChanges: 0 };
    rebuildGitFileStatusMap();
    updateHeaderBranchPill();
    $('#git-not-repo').style.display = 'flex';
    $('#git-content').style.display = 'none';
    $('#git-change-count').style.display = 'none';
    return;
  }

  gitInfo = {
    isGit: true,
    branch: infoRes.branch,
    detached: !!infoRes.detached,
    upstream: infoRes.upstream || '',
    ahead: infoRes.ahead || 0,
    behind: infoRes.behind || 0,
    stashCount: infoRes.stashCount || 0,
  };

  if (infoRes.repoState) {
    repoState = infoRes.repoState;
    updateRepoStateBanners();
  }

  // Update pull/push/stash count badges
  const pullBadge = $('#pull-count-badge');
  if (pullBadge) {
    pullBadge.textContent = `↓${gitInfo.behind}`;
    pullBadge.style.display = gitInfo.behind > 0 ? 'inline-block' : 'none';
  }
  const pushBadge = $('#push-count-badge');
  if (pushBadge) {
    pushBadge.textContent = `↑${gitInfo.ahead}`;
    pushBadge.style.display = gitInfo.ahead > 0 ? 'inline-block' : 'none';
  }
  const stashBadge = $('#stash-count-badge');
  if (stashBadge) {
    stashBadge.textContent = gitInfo.stashCount;
    stashBadge.style.display = gitInfo.stashCount > 0 ? 'inline-block' : 'none';
  }

  $('#git-not-repo').style.display = 'none';
  $('#git-content').style.display = 'flex';
  updateHeaderBranchPill();

  const tasks = [loadGitBranches(), loadGitStatus(), loadGitCommits(true)];
  if (stashDrawerOpen) tasks.push(loadGitStashes());
  await Promise.all(tasks);
}

async function loadGitBranches() {
  const res = await api('/api/git/branches');
  if (!res.ok) {
    const listEl = $('#branch-list');
    if (listEl) listEl.innerHTML = `<div class="empty-box">获取分支失败: ${escapeHtml(res.error || '未知错误')}</div>`;
    return;
  }

  if (res.repoState) {
    repoState = res.repoState;
    updateRepoStateBanners();
  }

  gitBranchesData = {
    current: res.current || 'HEAD',
    branches: res.branches || [],
    localBranches: res.localBranches || [],
    remoteBranches: res.remoteBranches || [],
    remotes: res.remotes || [],
  };

  const totalCount = gitBranchesData.branches.length;
  const localCount = gitBranchesData.localBranches.length;
  const remoteCount = gitBranchesData.remoteBranches.length;

  if ($('#badge-branch-counts')) {
    $('#badge-branch-counts').textContent = `本地 ${localCount} · 远端 ${remoteCount}`;
  }
  if ($('#count-branch-all')) $('#count-branch-all').textContent = totalCount;
  if ($('#count-branch-local')) $('#count-branch-local').textContent = localCount;
  if ($('#count-branch-remote')) $('#count-branch-remote').textContent = remoteCount;

  if ($('#current-branch-display')) {
    $('#current-branch-display').textContent = gitBranchesData.current;
  }
  if ($('#foot-branch-name')) {
    $('#foot-branch-name').textContent = gitBranchesData.current;
  }

  const activeBranch = gitBranchesData.branches.find((b) => b.isCurrent || b.name === gitBranchesData.current);
  const syncPill = $('#git-sync-pill');
  const subEl = $('#current-branch-commit-info');

  if (activeBranch) {
    if (syncPill) {
      if (activeBranch.upstream) {
        if (activeBranch.gone) {
          syncPill.textContent = '上游已删';
          syncPill.className = 'tag-badge badge-gone';
        } else if (activeBranch.ahead === 0 && activeBranch.behind === 0) {
          syncPill.textContent = '✓ 已同步';
          syncPill.className = 'tag-badge status-badge-curr';
        } else {
          syncPill.textContent = `↑${activeBranch.ahead} ↓${activeBranch.behind}`;
          syncPill.className = activeBranch.behind > 0 ? 'tag-badge badge-behind' : 'tag-badge badge-ahead';
        }
        syncPill.title = `跟踪上游: ${activeBranch.upstream} (领先 ${activeBranch.ahead} / 落后 ${activeBranch.behind})`;
      } else {
        syncPill.textContent = '本地分支';
        syncPill.className = 'tag-badge status-badge-curr';
        syncPill.title = '未关联远端上游分支';
      }
    }

    if (subEl) {
      if (activeBranch.lastCommit && activeBranch.lastCommit.shortHash) {
        subEl.innerHTML = `<span class="branch-commit-hash">${escapeHtml(activeBranch.lastCommit.shortHash)}</span> ${escapeHtml(activeBranch.lastCommit.subject || '')} · <span class="branch-commit-time">${escapeHtml(activeBranch.lastCommit.relativeDate || '')}</span>`;
      } else {
        subEl.textContent = '暂无提交信息';
      }
    }
  } else {
    if (syncPill) {
      syncPill.textContent = gitInfo.detached ? 'Detached' : '本地分支';
      syncPill.className = 'tag-badge status-badge-curr';
      syncPill.title = '未关联远端上游分支';
    }
    if (subEl) {
      subEl.textContent = '暂无提交记录 (尚未进行首次提交)';
    }
  }

  const select = $('#branch-select');
  if (select) {
    select.innerHTML = '';
    for (const b of gitBranchesData.localBranches) {
      const opt = document.createElement('option');
      opt.value = b.name;
      opt.textContent = (b.isCurrent ? '● ' : '  ') + b.name;
      if (b.isCurrent) opt.selected = true;
      select.appendChild(opt);
    }
    if (gitBranchesData.remoteBranches.length > 0) {
      const grp = document.createElement('optgroup');
      grp.label = '── 远端分支 ──';
      for (const b of gitBranchesData.remoteBranches) {
        const opt = document.createElement('option');
        opt.value = b.name;
        opt.textContent = '  ' + b.name;
        opt.setAttribute('data-remote', 'true');
        grp.appendChild(opt);
      }
      select.appendChild(grp);
    }
  }

  renderBranchList();
}

function renderBranchList() {
  const listEl = $('#branch-list');
  if (!listEl) return;

  let list = gitBranchesData.branches;
  if (branchFilterTab === 'local') {
    list = gitBranchesData.localBranches;
  } else if (branchFilterTab === 'remote') {
    list = gitBranchesData.remoteBranches;
  }

  const q = branchSearchText.toLowerCase();
  if (q) {
    list = list.filter(
      (b) =>
        b.name.toLowerCase().includes(q) ||
        b.lastCommit?.subject?.toLowerCase().includes(q) ||
        b.lastCommit?.author?.toLowerCase().includes(q)
    );
  }

  if (list.length === 0) {
    listEl.innerHTML = `<div class="empty-box">${q ? '未找到匹配的分支' : '暂无分支记录'}</div>`;
    return;
  }

  listEl.innerHTML = list
    .map((b) => {
      const isCurrent = b.isCurrent || b.name === gitBranchesData.current;
      const isRemote = b.isRemote;
      const icon = isRemote ? ICONS.remote : ICONS.branch;
      const iconClass = isRemote ? 'branch-icon-box is-remote' : 'branch-icon-box';

      let badgesHtml = '';
      if (isCurrent) badgesHtml += `<span class="tag-badge status-badge-curr">● HEAD</span>`;
      if (isRemote) badgesHtml += `<span class="badge-remote-tag">REMOTE</span>`;
      if (b.gone) badgesHtml += `<span class="badge-gone" title="远程跟踪分支已被删除">GONE</span>`;
      if (b.upstream) badgesHtml += `<span class="code-pill" title="上游: ${escapeHtml(b.upstream)}">↳ ${escapeHtml(b.upstream)}</span>`;
      if (b.ahead > 0) badgesHtml += `<span class="badge-ahead" title="领先上游 ${b.ahead} 个提交">↑${b.ahead}</span>`;
      if (b.behind > 0) badgesHtml += `<span class="badge-behind" title="落后上游 ${b.behind} 个提交">↓${b.behind}</span>`;

      let subHtml = '';
      if (b.lastCommit && b.lastCommit.shortHash) {
        subHtml = `
          <div class="branch-item-sub">
            <span class="branch-commit-hash">${escapeHtml(b.lastCommit.shortHash)}</span>
            <span class="branch-commit-msg" title="${escapeHtml(b.lastCommit.subject || '')}">${highlightMatch(b.lastCommit.subject || '', branchSearchText)}</span>
            <span class="branch-commit-time">${escapeHtml(b.lastCommit.relativeDate || '')}</span>
          </div>
        `;
      }

      const actionsHtml = `
        <div class="branch-item-actions">
          ${
            !isCurrent
              ? `
                <button type="button" class="mini-btn branch-act-btn branch-act-checkout" data-branch-act="checkout" data-branch="${escapeHtml(b.name)}" data-remote="${isRemote}" title="检出切换到此分支">检出</button>
                <button type="button" class="mini-btn branch-act-btn" data-branch-act="merge" data-branch="${escapeHtml(b.name)}" title="合并此分支到当前 ${escapeHtml(gitBranchesData.current)}">合并</button>
                <button type="button" class="mini-btn branch-act-btn" data-branch-act="rebase" data-branch="${escapeHtml(b.name)}" title="将当前分支变基到此分支">变基</button>
                <button type="button" class="mini-btn branch-act-btn" data-branch-act="diff" data-branch="${escapeHtml(b.name)}" title="对比此分支与 HEAD 差异">对比</button>
              `
              : `<span class="code-pill">当前所在分支</span>`
          }
          <button type="button" class="mini-icon-btn" data-branch-act="more" data-branch="${escapeHtml(b.name)}" data-remote="${isRemote}" title="更多操作">
            ${ICONS.more}
          </button>
        </div>
      `;

      return `
        <div class="branch-card-item ${isCurrent ? 'is-current' : ''}" data-branch="${escapeHtml(b.name)}" data-remote="${isRemote}">
          <div class="branch-item-top">
            <div class="branch-item-left">
              <span class="${iconClass}">${icon}</span>
              <strong class="branch-name" title="${escapeHtml(b.name)}">${highlightMatch(b.name, branchSearchText)}</strong>
              <div class="branch-item-badges">${badgesHtml}</div>
            </div>
          </div>
          ${subHtml}
          ${actionsHtml}
        </div>
      `;
    })
    .join('');
}

function setupBranchListDelegation() {
  const listEl = $('#branch-list');
  if (!listEl) return;

  listEl.addEventListener('click', (e) => {
    const actBtn = e.target.closest('[data-branch-act]');
    if (actBtn) {
      e.stopPropagation();
      const act = actBtn.getAttribute('data-branch-act');
      const branch = actBtn.getAttribute('data-branch');
      const isRemote = actBtn.getAttribute('data-remote') === 'true';
      if (act === 'checkout') handleCheckoutBranch(branch, isRemote);
      else if (act === 'merge') openMergeBranchModal(branch);
      else if (act === 'rebase') openRebaseBranchModal(branch);
      else if (act === 'diff') openBranchDiffViewer(branch);
      else if (act === 'more') {
        const rect = actBtn.getBoundingClientRect();
        showBranchContextMenu(rect.left, rect.bottom + 4, branch, isRemote);
      }
      return;
    }

    const card = e.target.closest('.branch-card-item');
    if (!card) return;
    const branchName = card.getAttribute('data-branch');
    if (branchName && branchName !== gitBranchesData.current) {
      openBranchDiffViewer(branchName);
    }
  });

  listEl.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.branch-card-item');
    if (!card) return;
    e.preventDefault();
    e.stopPropagation();
    hideContextMenu();
    card.classList.add('context-selected');
    const branchName = card.getAttribute('data-branch');
    const isRemote = card.getAttribute('data-remote') === 'true';
    showBranchContextMenu(e.clientX, e.clientY, branchName, isRemote);
  });
}

function showBranchContextMenu(x, y, branchName, isRemote) {
  const isCurrent = branchName === gitBranchesData.current;
  const items = [];

  if (!isCurrent) {
    items.push(
      { id: 'co', icon: ICONS.branch, label: `检出并切换至 "${branchName}"`, handler: () => handleCheckoutBranch(branchName, isRemote) },
      { id: 'diff', icon: ICONS.diff, label: `与当前分支 (${gitBranchesData.current}) 对比差异`, handler: () => openBranchDiffViewer(branchName) },
      { id: 'merge', icon: ICONS.merge, label: `合并 "${branchName}" 到当前分支`, handler: () => openMergeBranchModal(branchName) },
      { id: 'rebase', icon: ICONS.rebase, label: `将当前分支变基到 "${branchName}"`, handler: () => openRebaseBranchModal(branchName) },
      { type: 'divider' }
    );
  }

  items.push({ id: 'new-from', icon: ICONS.plus, label: `基于 "${branchName}" 新建分支...`, handler: () => openCreateBranchModal(branchName) });

  if (!isRemote) {
    items.push(
      { id: 'rename', icon: ICONS.rename, label: `重命名分支 "${branchName}"...`, handler: () => handleRenameBranch(branchName) },
      { id: 'push', icon: ICONS.push, label: `推送分支到远端 (push -u)`, handler: () => handlePushBranch(branchName) },
      { id: 'pull', icon: ICONS.pull, label: `拉取此分支更新 (pull)`, handler: () => handlePullBranch(branchName) }
    );
  }

  items.push(
    { type: 'divider' },
    { id: 'copy-name', icon: ICONS.copy, label: '复制分支名称', handler: () => copyText(branchName, `已复制分支名: ${branchName}`) }
  );

  if (!isCurrent) {
    items.push({
      id: 'del',
      icon: ICONS.trash,
      danger: true,
      label: isRemote ? `删除远程分支 "${branchName}"...` : `删除本地分支 "${branchName}"...`,
      handler: () => handleDeleteBranchWithConfirm(branchName, isRemote),
    });
  }

  showContextMenu(x, y, items);
}

async function handleCheckoutBranch(branch, isRemote = false) {
  if (!branch || branch === gitBranchesData.current) return;
  showToast(`正在切换至分支: ${branch}...`);
  const res = await api('/api/git/checkout', { branch, isRemote });
  if (res.ok) {
    showToast(`✓ 已切换至分支: ${branch.replace(/^origin\//, '')}`, 'success');
    await refreshAll(true);
  } else {
    showToast(`切换分支失败: ${res.error}`, 'error');
    await loadGitBranches();
  }
}

// ---------------------------------------------------------------------------
// Stash Drawer
// ---------------------------------------------------------------------------
async function loadGitStashes() {
  const listEl = $('#stash-list');
  if (!listEl) return;
  const res = await api('/api/git/stash', { action: 'list' });
  if (!res.ok) {
    listEl.innerHTML = `<div class="empty-box">获取储藏列表失败</div>`;
    return;
  }
  gitStashes = res.stashes || [];
  if (gitStashes.length === 0) {
    listEl.innerHTML = `<div class="empty-box">当前没有已储藏的记录 (Stash 为空)</div>`;
    return;
  }
  listEl.innerHTML = gitStashes
    .map(
      (s) => `
      <div class="stash-item" data-ref="${escapeHtml(s.ref)}">
        <span class="stash-ref">${escapeHtml(s.ref)}</span>
        <span class="stash-subject" title="${escapeHtml(s.subject)}">${escapeHtml(s.subject)}</span>
        <span class="stash-date">${escapeHtml(s.date)}</span>
        <div class="stash-actions">
          <button type="button" class="mini-icon-btn" data-stash-act="apply" data-ref="${escapeHtml(s.ref)}" title="应用储藏 (保留记录)">${ICONS.check}</button>
          <button type="button" class="mini-icon-btn" data-stash-act="pop" data-ref="${escapeHtml(s.ref)}" title="弹出储藏 (应用并删除)">${ICONS.undo}</button>
          <button type="button" class="mini-icon-btn danger-hover" data-stash-act="drop" data-ref="${escapeHtml(s.ref)}" title="删除此储藏">${ICONS.trash}</button>
        </div>
      </div>
    `
    )
    .join('');
}

function setupStashListDelegation() {
  const listEl = $('#stash-list');
  if (!listEl) return;

  listEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-stash-act]');
    if (!btn) return;
    const action = btn.getAttribute('data-stash-act');
    const ref = btn.getAttribute('data-ref');
    if (!ref) return;

    if (action === 'drop') {
      const ok = await showConfirmModal({
        title: '删除储藏',
        message: `确定要丢弃储藏 ${ref} 吗？此操作无法撤销。`,
        confirmText: '丢弃',
        danger: true,
      });
      if (!ok) return;
    }

    await withBusy(btn, async () => {
      const res = await api('/api/git/stash', { action, ref });
      if (res.ok) {
        const label = action === 'apply' ? '已应用储藏' : action === 'pop' ? '已弹出储藏' : '已删除储藏';
        showToast(`${label}: ${ref}`, 'success');
        await refreshAll(true);
      } else {
        showToast(`Stash ${action} 失败: ${res.error}`, 'error');
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Git Changes & Status
// ---------------------------------------------------------------------------
async function loadGitStatus() {
  const res = await api('/api/git/status');
  if (!res.ok) return;

  if (res.repoState) {
    repoState = res.repoState;
    updateRepoStateBanners();
  }

  gitChanges = {
    conflicts: res.conflicts || [],
    staged: res.staged || [],
    unstaged: res.unstaged || [],
    untracked: res.untracked || [],
    totalChanges: res.totalChanges || 0,
  };

  const totalCount = gitChanges.totalChanges;
  const tabBadge = $('#git-change-count');
  if (tabBadge) {
    tabBadge.textContent = totalCount;
    tabBadge.style.display = totalCount > 0 ? 'inline-block' : 'none';
  }
  if ($('#badge-total-changes')) $('#badge-total-changes').textContent = totalCount;

  // Conflicts group
  const conflictGroup = $('#subgroup-conflicts');
  const conflictList = $('#list-conflicts');
  if (conflictGroup && conflictList) {
    if (gitChanges.conflicts.length > 0) {
      conflictGroup.style.display = 'flex';
      $('#count-conflicts').textContent = gitChanges.conflicts.length;
      conflictList.innerHTML = renderChangeItems(gitChanges.conflicts, 'conflict');
    } else {
      conflictGroup.style.display = 'none';
      conflictList.innerHTML = '';
    }
  }

  // Staged group
  const stagedGroup = $('#subgroup-staged');
  const stagedList = $('#list-staged');
  if ($('#stat-staged-val')) $('#stat-staged-val').textContent = gitChanges.staged.length;

  if (gitChanges.staged.length > 0) {
    stagedGroup.style.display = 'flex';
    $('#count-staged').textContent = gitChanges.staged.length;
    stagedList.innerHTML = renderChangeItems(gitChanges.staged, 'staged');
  } else {
    stagedGroup.style.display = 'none';
    stagedList.innerHTML = '';
  }

  // Unstaged & Untracked combined
  const unstagedList = $('#list-unstaged');
  const workingChanges = [...gitChanges.unstaged, ...gitChanges.untracked];
  $('#count-unstaged').textContent = workingChanges.length;
  if ($('#stat-unstaged-val')) $('#stat-unstaged-val').textContent = workingChanges.length;

  if (workingChanges.length > 0) {
    unstagedList.innerHTML = renderChangeItems(workingChanges, 'unstaged');
  } else {
    unstagedList.innerHTML = `<div class="empty-box">工作树无未暂存更改 (Working tree clean)</div>`;
  }

  rebuildGitFileStatusMap();
  updateHeaderBranchPill();
  updateCommitButtonLabel();
  if (fileTreeData.length > 0) {
    renderFileTree();
  }
}

function renderChangeItems(items, groupType) {
  const isStaged = groupType === 'staged';
  const isConflict = groupType === 'conflict';

  return items
    .map((item) => {
      const parts = item.path.split('/');
      const fileName = parts.pop();
      const dirName = parts.length > 0 ? parts.join('/') + '/' : '';
      const isUntracked = item.status === 'U';
      const fileIcon = getFileIcon(fileName);
      const hasStats = item.additions != null || item.deletions != null;
      const statsHtml = hasStats
        ? `<span class="diff-stat-group">
            ${item.additions ? `<span class="diff-stat-add">+${item.additions}</span>` : ''}
            ${item.deletions ? `<span class="diff-stat-del">-${item.deletions}</span>` : ''}
           </span>`
        : '';

      const actionButtons = isConflict
        ? `<button type="button" class="mini-icon-btn" data-change-act="stage" data-path="${escapeHtml(item.path)}" title="标记冲突已解决并暂存 (git add)">${ICONS.check}</button>`
        : isStaged
          ? `<button type="button" class="mini-icon-btn" data-change-act="unstage" data-path="${escapeHtml(item.path)}" title="取消暂存 (-)">${ICONS.minus}</button>`
          : `<button type="button" class="mini-icon-btn" data-change-act="stage" data-path="${escapeHtml(item.path)}" title="暂存更改 (+)">${ICONS.plus}</button>
             <button type="button" class="mini-icon-btn danger-hover" data-change-act="discard" data-path="${escapeHtml(item.path)}" data-untracked="${isUntracked}" title="放弃更改 (Discard)">${ICONS.undo}</button>`;

      return `
        <div class="change-item ${isConflict ? 'is-conflict' : ''}" data-path="${escapeHtml(item.path)}" data-staged="${isStaged}" data-untracked="${isUntracked}" data-conflict="${isConflict}">
          <span class="status-badge status-${escapeHtml(item.status)}" title="${isConflict ? `冲突 (${escapeHtml(item.code || 'UU')})` : escapeHtml(item.status)}">${escapeHtml(item.status)}</span>
          <span class="change-file-icon">${fileIcon.icon}</span>
          <span class="change-path" title="${escapeHtml(item.path)}">
            ${escapeHtml(fileName)}
            ${dirName ? `<span class="change-dir">${escapeHtml(dirName)}</span>` : ''}
          </span>
          ${statsHtml}
          <div class="change-actions">
            ${actionButtons}
            <button type="button" class="mini-icon-btn" data-change-act="open-agy" data-path="${escapeHtml(item.path)}" title="在 Antigravity 中打开">${ICONS.openExternal}</button>
            <button type="button" class="mini-icon-btn" data-change-act="diff" data-path="${escapeHtml(item.path)}" data-staged="${isStaged}" title="查看对比 (Diff)">${ICONS.view}</button>
          </div>
        </div>
      `;
    })
    .join('');
}

async function stageFile(path) {
  const res = await api('/api/git/stage', { relativePath: path });
  if (!res.ok) showToast(`暂存失败: ${res.error}`, 'error');
  await loadGitStatus();
}

async function unstageFile(path) {
  const res = await api('/api/git/unstage', { relativePath: path });
  if (!res.ok) showToast(`取消暂存失败: ${res.error}`, 'error');
  await loadGitStatus();
}

async function discardFile(path, untracked) {
  const ok = await showConfirmModal({
    title: '放弃更改',
    message: `确定要放弃对 "${path}" 的修改吗？\n此操作无法撤销。`,
    confirmText: '放弃修改',
    danger: true,
  });
  if (!ok) return;
  const res = await api('/api/git/discard', { relativePath: path, untracked });
  if (!res.ok) {
    showToast(`放弃更改失败: ${res.error}`, 'error');
    return;
  }
  showToast(`已放弃更改: ${path.split('/').pop()}`, 'success');
  await Promise.all([loadGitStatus(), loadFileTree(true)]);
}

function setupChangesDelegation() {
  const body = $('#body-changes');
  if (!body) return;

  body.addEventListener('click', (e) => {
    const actBtn = e.target.closest('[data-change-act]');
    if (actBtn) {
      e.stopPropagation();
      const act = actBtn.getAttribute('data-change-act');
      const path = actBtn.getAttribute('data-path');
      const isStaged = actBtn.getAttribute('data-staged') === 'true';
      const isUntracked = actBtn.getAttribute('data-untracked') === 'true';
      if (act === 'stage') withBusy(actBtn, () => stageFile(path));
      else if (act === 'unstage') withBusy(actBtn, () => unstageFile(path));
      else if (act === 'discard') discardFile(path, isUntracked);
      else if (act === 'open-agy') openInAgyHost(path);
      else if (act === 'diff') openDiffViewer({ path, staged: isStaged });
      return;
    }

    const item = e.target.closest('.change-item');
    if (!item) return;
    const path = item.getAttribute('data-path');
    const isStaged = item.getAttribute('data-staged') === 'true';
    openDiffViewer({ path, staged: isStaged });
  });

  body.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.change-item');
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();
    hideContextMenu();
    item.classList.add('context-selected');

    const path = item.getAttribute('data-path');
    const isStaged = item.getAttribute('data-staged') === 'true';
    const isUntracked = item.getAttribute('data-untracked') === 'true';
    const isConflict = item.getAttribute('data-conflict') === 'true';

    const items = [
      { id: 'open-diff', icon: ICONS.view, label: '打开差异对比 (Diff)', handler: () => openDiffViewer({ path, staged: isStaged }) },
      { id: 'open-agy', icon: ICONS.openExternal, label: '在 Antigravity 中打开原文件', handler: () => openInAgyHost(path) },
      { id: 'open-file', icon: ICONS.view, label: '在面板内预览原文件', handler: () => openFileViewer(path) },
      { type: 'divider' },
    ];

    if (isConflict) {
      items.push({ id: 'git-resolve', icon: ICONS.check, label: '标记冲突已解决并暂存', handler: () => stageFile(path) });
    } else if (isStaged) {
      items.push({ id: 'git-unstage', icon: ICONS.minus, label: '取消暂存更改 (-)', handler: () => unstageFile(path) });
    } else {
      items.push(
        { id: 'git-stage', icon: ICONS.plus, label: '暂存更改 (+)', handler: () => stageFile(path) },
        { id: 'git-discard', icon: ICONS.undo, label: '放弃更改 (Discard)', danger: true, handler: () => discardFile(path, isUntracked) }
      );
    }

    if (isUntracked) {
      items.push({
        id: 'git-ignore',
        icon: ICONS.git,
        label: '添加到 .gitignore',
        handler: async () => {
          const res = await api('/api/git/ignore', { relativePath: path });
          if (res.ok) {
            showToast(res.alreadyExists ? `已在 .gitignore 中: ${path}` : `已添加到 .gitignore: ${path}`, 'success');
            await Promise.all([loadFileTree(true), loadGitStatus()]);
          } else {
            showToast(`写入 .gitignore 失败: ${res.error}`, 'error');
          }
        },
      });
    }

    items.push(
      { type: 'divider' },
      { id: 'reveal', icon: ICONS.reveal, label: '在系统资源管理器中显示', handler: () => api('/api/files/reveal', { relativePath: path }) },
      { id: 'copy-rel', icon: ICONS.copy, label: '复制相对路径', handler: () => copyText(path, `已复制: ${path}`) },
      { type: 'divider' },
      { id: 'send-diff-agent', icon: ICONS.agent, label: '发送 Diff 给 Agent Review', handler: () => sendChangeDiffToAgent(path, isStaged) }
    );

    showContextMenu(e.clientX, e.clientY, items);
  });
}

// ---------------------------------------------------------------------------
// Advanced Git Actions
// ---------------------------------------------------------------------------
async function handleGitCommit() {
  const input = $('#commit-msg-input');
  const amendChk = $('#chk-commit-amend');
  const commitBtn = $('#btn-git-commit');
  const message = input?.value.trim() || '';
  const amend = !!amendChk?.checked;

  if (!message) {
    showToast('请先输入 Commit 提交说明', 'error');
    input?.focus();
    return;
  }

  const stagedCount = gitChanges.staged?.length || 0;
  const unstagedCount = (gitChanges.unstaged?.length || 0) + (gitChanges.untracked?.length || 0);
  let stageAll = false;

  if (stagedCount === 0 && !amend) {
    if (unstagedCount === 0) {
      showToast('当前工作区没有可提交的更改');
      return;
    }
    const ok = await showConfirmModal({
      title: '自动暂存并提交',
      message: `当前暂存区为空，是否自动暂存全部 ${unstagedCount} 项更改并直接提交？`,
      confirmText: '全部暂存并提交',
    });
    if (!ok) return;
    stageAll = true;
  }

  await withBusy(commitBtn, async () => {
    const res = await api('/api/git/commit', { message, amend, stageAll });
    if (res.ok) {
      if (input) input.value = '';
      if (amendChk) amendChk.checked = false;
      showToast('✓ 已成功提交代码更改', 'success');
      await refreshAll(true);
    } else {
      showToast(`提交失败: ${res.error}`, 'error');
    }
  });
}

async function handleAiGenerateCommitMsg() {
  const btn = $('#btn-ai-commit');
  const staged = gitChanges.staged || [];
  const working = [...(gitChanges.unstaged || []), ...(gitChanges.untracked || [])];
  const targetList = staged.length > 0 ? staged : working;

  if (targetList.length === 0) {
    showToast('当前没有代码改动可供生成说明');
    return;
  }

  const fileNames = targetList.map((it) => it.path.split('/').pop());
  const hasAdded = targetList.some((it) => it.status === 'A' || it.status === 'U');
  const onlyDocs = targetList.every((it) => /\.(md|txt)$/i.test(it.path));
  const onlyStyles = targetList.every((it) => /\.(css|scss|less)$/i.test(it.path));
  const prefix = onlyDocs ? 'docs' : onlyStyles ? 'style' : hasAdded ? 'feat' : 'refactor';

  const summaryFiles =
    fileNames.length <= 2 ? fileNames.join(', ') : `${fileNames.slice(0, 2).join(', ')} 等 ${fileNames.length} 个文件`;

  const draft = `${prefix}: 更新 ${summaryFiles}`;
  const input = $('#commit-msg-input');
  if (input && !input.value.trim()) {
    input.value = draft;
    input.focus();
  }

  await withBusy(btn, async () => {
    const diffRes = await api('/api/git/diff', { staged: staged.length > 0 });
    const diffText = diffRes.ok && diffRes.diff ? diffRes.diff : '';
    if (diffText && window.sidecar && window.sidecar.agent) {
      const truncated = diffText.length > 5000 ? diffText.slice(0, 5000) + '\n...[已截断]' : diffText;
      const prompt = `请根据以下 Git Diff 为我生成一条简洁规范的 Conventional Commits 提交说明（中文）：\n\`\`\`diff\n${truncated}\n\`\`\``;
      window.sidecar.agent.sendMessage(prompt);
      showToast('已填入草稿并请求 Agent 生成详细 Commit Message', 'success');
    } else {
      showToast('已根据改动文件自动生成提交说明草稿', 'success');
    }
  });
}

function openCreateBranchModal(defaultBase = '') {
  const modal = $('#modal-branch-create');
  const input = $('#input-new-branch-name');
  const select = $('#select-branch-base');
  const chk = $('#chk-branch-checkout');

  if (input) input.value = '';
  if (chk) chk.checked = true;

  if (select) {
    select.innerHTML = '';
    const headOpt = document.createElement('option');
    headOpt.value = gitBranchesData.current;
    headOpt.textContent = `当前检出分支: ${gitBranchesData.current} (HEAD)`;
    select.appendChild(headOpt);

    let matchedBase = defaultBase === gitBranchesData.current;

    if (gitBranchesData.localBranches.length > 0) {
      const localGrp = document.createElement('optgroup');
      localGrp.label = '── 本地分支 ──';
      for (const b of gitBranchesData.localBranches) {
        if (b.name === gitBranchesData.current) continue;
        const opt = document.createElement('option');
        opt.value = b.name;
        opt.textContent = b.name;
        if (defaultBase && defaultBase === b.name) {
          opt.selected = true;
          matchedBase = true;
        }
        localGrp.appendChild(opt);
      }
      if (localGrp.children.length > 0) select.appendChild(localGrp);
    }

    if (gitBranchesData.remoteBranches.length > 0) {
      const remoteGrp = document.createElement('optgroup');
      remoteGrp.label = '── 远端分支 ──';
      for (const b of gitBranchesData.remoteBranches) {
        const opt = document.createElement('option');
        opt.value = b.name;
        opt.textContent = b.name;
        if (defaultBase && defaultBase === b.name) {
          opt.selected = true;
          matchedBase = true;
        }
        remoteGrp.appendChild(opt);
      }
      if (remoteGrp.children.length > 0) select.appendChild(remoteGrp);
    }

    // Support creating a branch from a specific commit hash
    if (defaultBase && !matchedBase) {
      const customOpt = document.createElement('option');
      customOpt.value = defaultBase;
      customOpt.textContent = `提交起点: ${defaultBase.slice(0, 10)}`;
      customOpt.selected = true;
      select.insertBefore(customOpt, select.firstChild);
    }
  }

  if (modal) {
    modal.style.display = 'flex';
    setTimeout(() => input?.focus(), 40);
  }
}

function closeCreateBranchModal() {
  const modal = $('#modal-branch-create');
  if (modal) modal.style.display = 'none';
}

async function submitCreateBranch() {
  const name = $('#input-new-branch-name')?.value.trim();
  const startPoint = $('#select-branch-base')?.value.trim();
  const checkout = !!$('#chk-branch-checkout')?.checked;

  if (!name) {
    showToast('请输入新分支名称', 'error');
    $('#input-new-branch-name')?.focus();
    return;
  }

  closeCreateBranchModal();
  showToast(`正在创建分支 "${name}"...`);

  const res = await api('/api/git/branch-create', { name, startPoint, checkout });
  if (res.ok) {
    showToast(`✓ 已成功创建分支: ${name}`, 'success');
    await refreshAll(true);
  } else {
    showToast(`创建分支失败: ${res.error}`, 'error');
  }
}

function updateRepoStateBanners() {
  const rebaseBanner = $('#banner-rebase-active');
  const mergeBanner = $('#banner-merge-active');
  const cpBanner = $('#banner-cherrypick-active');
  if (rebaseBanner) rebaseBanner.style.display = repoState.isRebasing ? 'flex' : 'none';
  if (mergeBanner) mergeBanner.style.display = !repoState.isRebasing && repoState.isMerging ? 'flex' : 'none';
  if (cpBanner) cpBanner.style.display = !repoState.isRebasing && !repoState.isMerging && repoState.isCherryPicking ? 'flex' : 'none';
}

function openMergeBranchModal(sourceBranch) {
  currentMergeSource = sourceBranch;
  const modal = $('#modal-branch-merge');
  if ($('#merge-source-name')) $('#merge-source-name').textContent = sourceBranch;
  if ($('#merge-target-name')) $('#merge-target-name').textContent = gitBranchesData.current || 'HEAD';
  if ($('#input-merge-msg')) $('#input-merge-msg').value = '';
  if ($('#chk-merge-no-ff')) $('#chk-merge-no-ff').checked = false;
  if (modal) modal.style.display = 'flex';
}

function closeMergeBranchModal() {
  const modal = $('#modal-branch-merge');
  if (modal) modal.style.display = 'none';
  currentMergeSource = '';
}

async function submitMergeBranch() {
  if (!currentMergeSource) return;
  const source = currentMergeSource;
  const noFf = !!$('#chk-merge-no-ff')?.checked;
  const message = $('#input-merge-msg')?.value.trim();

  closeMergeBranchModal();
  showToast(`正在合并分支 "${source}" 到 "${gitBranchesData.current}"...`);

  const res = await api('/api/git/branch-merge', { branch: source, noFf, message });
  if (res.ok) {
    showToast(`✓ 已成功合并分支: ${source}`, 'success');
  } else if (res.conflict) {
    showToast('合并产生冲突！请解决冲突文件并提交，或点击“中止合并”。', 'error', 6000);
  } else {
    showToast(`合并失败: ${res.error}`, 'error');
  }
  await refreshAll(true);
}

function openRebaseBranchModal(upstreamBranch) {
  currentRebaseUpstream = upstreamBranch;
  const modal = $('#modal-branch-rebase');
  if ($('#rebase-current-name')) $('#rebase-current-name').textContent = gitBranchesData.current || 'HEAD';
  if ($('#rebase-upstream-name')) $('#rebase-upstream-name').textContent = upstreamBranch;
  if ($('#chk-rebase-autostash')) $('#chk-rebase-autostash').checked = true;
  if (modal) modal.style.display = 'flex';
}

function closeRebaseBranchModal() {
  const modal = $('#modal-branch-rebase');
  if (modal) modal.style.display = 'none';
  currentRebaseUpstream = '';
}

async function submitRebaseBranch() {
  if (!currentRebaseUpstream) return;
  const upstream = currentRebaseUpstream;
  const autostash = !!$('#chk-rebase-autostash')?.checked;

  closeRebaseBranchModal();
  showToast(`正在将 "${gitBranchesData.current}" 变基到 "${upstream}"...`);

  const res = await api('/api/git/branch-rebase', { upstream, autostash });
  if (res.ok) {
    showToast(`✓ 已成功变基到分支: ${upstream}`, 'success');
  } else if (res.conflict) {
    showToast('变基产生冲突！解决并暂存后点击“继续”，或选择“跳过 / 中止”。', 'error', 6000);
  } else {
    showToast(`变基失败: ${res.error}`, 'error');
  }
  await refreshAll(true);
}

async function handleRebaseContinue() {
  await withBusy($('#btn-rebase-continue'), async () => {
    showToast('正在继续执行变基...');
    const res = await api('/api/git/rebase-continue');
    if (res.ok) showToast('✓ 变基已成功完成！', 'success');
    else showToast(res.conflict ? '仍存在未解决冲突，请暂存已解决文件后再试' : `继续变基失败: ${res.error}`, 'error');
    await refreshAll(true);
  });
}

async function handleRebaseSkip() {
  const ok = await showConfirmModal({
    title: '跳过冲突提交',
    message: '确定要跳过当前存在冲突的提交吗 (git rebase --skip)？\n跳过将丢弃当前冲突提交中的修改！',
    confirmText: '跳过提交',
    danger: true,
  });
  if (!ok) return;

  await withBusy($('#btn-rebase-skip'), async () => {
    const res = await api('/api/git/rebase-skip');
    if (res.ok) showToast('✓ 已跳过冲突提交并继续变基', 'success');
    else showToast(`跳过失败: ${res.error}`, 'error');
    await refreshAll(true);
  });
}

async function handleRebaseAbort() {
  const ok = await showConfirmModal({
    title: '中止变基',
    message: '确定要中止当前变基并恢复原状态吗 (git rebase --abort)？',
    confirmText: '中止变基',
    danger: true,
  });
  if (!ok) return;

  await withBusy($('#btn-rebase-abort'), async () => {
    const res = await api('/api/git/rebase-abort');
    if (res.ok) showToast('✓ 已中止变基并恢复原状态', 'success');
    else showToast(`中止变基失败: ${res.error}`, 'error');
    await refreshAll(true);
  });
}

async function handleMergeAbort() {
  const ok = await showConfirmModal({
    title: '中止合并',
    message: '确定要中止当前合并并恢复原分支状态吗 (git merge --abort)？',
    confirmText: '中止合并',
    danger: true,
  });
  if (!ok) return;

  await withBusy($('#btn-merge-abort'), async () => {
    const res = await api('/api/git/merge-abort');
    if (res.ok) showToast('✓ 已中止合并并恢复原状态', 'success');
    else showToast(`中止合并失败: ${res.error}`, 'error');
    await refreshAll(true);
  });
}

async function handleCherryPickAction(action, commitHash = '') {
  if (action === 'abort') {
    const ok = await showConfirmModal({
      title: '中止 Cherry-pick',
      message: '确定要中止当前 Cherry-pick 并恢复原状态吗？',
      confirmText: '中止',
      danger: true,
    });
    if (!ok) return;
  }
  const res = await api('/api/git/cherry-pick', { action, commitHash });
  if (res.ok) {
    showToast(action === 'abort' ? '✓ 已中止 Cherry-pick' : '✓ Cherry-pick 完成', 'success');
  } else if (res.conflict) {
    showToast('Cherry-pick 产生冲突，请解决并暂存后继续或中止', 'error', 5500);
  } else {
    showToast(`Cherry-pick 失败: ${res.error}`, 'error');
  }
  await refreshAll(true);
}

async function handlePullBranch(branch) {
  showToast(`正在拉取分支 "${branch}" 最新更新...`);
  const res = await api('/api/git/branch-pull', { branch });
  if (res.ok) {
    showToast(`✓ 分支 "${branch}" 拉取完成`, 'success');
    await refreshAll(true);
  } else if (res.conflict) {
    showToast('拉取产生代码冲突！请在工作区解决冲突文件。', 'error', 5500);
    await refreshAll(true);
  } else {
    showToast(`拉取分支失败: ${res.error}`, 'error');
  }
}

async function handleRenameBranch(oldName) {
  const newName = await showPromptModal({
    title: '重命名分支',
    desc: `请输入分支 "${oldName}" 的新名称：`,
    defaultValue: oldName,
  });
  if (!newName || newName === oldName) return;
  const res = await api('/api/git/branch-rename', { oldName, newName });
  if (res.ok) {
    showToast(`✓ 分支已重命名为: ${newName}`, 'success');
    await refreshAll(true);
  } else {
    showToast(`重命名失败: ${res.error}`, 'error');
  }
}

async function handleDeleteBranchWithConfirm(name, isRemote = false) {
  if (isRemote) {
    const ok = await showConfirmModal({
      title: '删除远程分支',
      message: `【警告】确定要删除远程分支 "${name}" 吗？\n此操作将直接从远程仓库中永久删除该分支！`,
      confirmText: '永久删除',
      danger: true,
    });
    if (!ok) return;
    showToast(`正在删除远程分支 "${name}"...`);
    const res = await api('/api/git/branch-delete', { name, isRemote: true });
    if (res.ok) {
      showToast(`✓ 已删除远程分支: ${name}`, 'success');
      await refreshAll(true);
    } else {
      showToast(`删除远程分支失败: ${res.error}`, 'error');
    }
    return;
  }

  if (name === gitBranchesData.current) {
    showToast('无法删除当前处于检出状态的分支，请先切换到其他分支。', 'error');
    return;
  }

  const ok = await showConfirmModal({
    title: '删除本地分支',
    message: `确定要删除本地分支 "${name}" 吗？`,
    confirmText: '删除分支',
    danger: true,
  });
  if (!ok) return;

  const res = await api('/api/git/branch-delete', { name, force: false });
  if (res.ok) {
    showToast(`✓ 已删除本地分支: ${name}`, 'success');
    await loadGitBranches();
  } else {
    const forceOk = await showConfirmModal({
      title: '强制删除分支',
      message: `${res.error}\n\n是否强制删除该分支 (git branch -D ${name})？`,
      confirmText: '强制删除 (-D)',
      danger: true,
    });
    if (!forceOk) return;
    const forceRes = await api('/api/git/branch-delete', { name, force: true });
    if (forceRes.ok) {
      showToast(`✓ 已强制删除本地分支: ${name}`, 'success');
      await loadGitBranches();
    } else {
      showToast(`强制删除失败: ${forceRes.error}`, 'error');
    }
  }
}

async function handlePushBranch(branch) {
  showToast(`正在推送分支 "${branch}" 至远端...`);
  const res = await api('/api/git/branch-push', { branch, setUpstream: true });
  if (res.ok) {
    showToast(`✓ 已推送分支 "${branch}" 并同步上游跟踪`, 'success');
    await refreshAll(true);
  } else {
    showToast(`推送分支失败: ${res.error}`, 'error');
  }
}

async function handleDiscardAll() {
  const unstagedCount = (gitChanges.unstaged?.length || 0) + (gitChanges.untracked?.length || 0);
  if (unstagedCount === 0) {
    showToast('当前没有未暂存的更改');
    return;
  }
  const ok = await showConfirmModal({
    title: '放弃全部未暂存更改',
    message: `确定要放弃全部 ${unstagedCount} 项未暂存更改及未跟踪文件吗？\n此操作无法撤销！`,
    confirmText: '放弃全部',
    danger: true,
  });
  if (!ok) return;

  await withBusy($('#btn-discard-all'), async () => {
    const res = await api('/api/git/discard-all');
    if (res.ok) {
      showToast('✓ 已放弃全部未暂存更改', 'success');
      await refreshAll(true);
    } else {
      showToast(`操作失败: ${res.error}`, 'error');
    }
  });
}

async function handleGitRemoteOp(opName, endpoint, btn) {
  await withBusy(btn, async () => {
    showToast(`正在执行 Git ${opName}...`);
    const res = await api(endpoint);
    if (res.ok) {
      showToast(`✓ Git ${opName} 完成`, 'success');
      await refreshAll(true);
    } else {
      showToast(`Git ${opName} 失败: ${res.error}`, 'error');
    }
  });
}

async function handleGitStashPush() {
  const totalChanges = gitChanges.totalChanges || 0;
  if (totalChanges === 0) {
    showToast('当前工作区没有可储藏的更改');
    return;
  }
  const message = await showPromptModal({
    title: '储藏工作区更改 (git stash)',
    desc: '输入储藏备注说明（包含未跟踪文件）：',
    defaultValue: `WIP on ${gitInfo.branch || 'HEAD'}`,
  });
  if (message === null) return;

  await withBusy($('#btn-git-stash'), async () => {
    const res = await api('/api/git/stash', { action: 'push', message });
    if (res.ok) {
      showToast('✓ 已将当前更改存入 Stash', 'success');
      await refreshAll(true);
    } else {
      showToast(`Stash 失败: ${res.error}`, 'error');
    }
  });
}

async function handleGitStashPop() {
  if (!gitInfo.stashCount) {
    showToast('当前没有已储藏的记录 (Stash 为空)');
    return;
  }
  await withBusy($('#btn-git-stash-pop'), async () => {
    const res = await api('/api/git/stash', { action: 'pop' });
    if (res.ok) {
      showToast('✓ 已弹出最近一次 Stash 储藏', 'success');
      await refreshAll(true);
    } else {
      showToast(`Stash Pop 失败: ${res.error}`, 'error');
    }
  });
}

// ---------------------------------------------------------------------------
// Commits Timeline
// ---------------------------------------------------------------------------
async function loadGitCommits(reset = true) {
  const skip = reset ? 0 : gitCommits.length;
  const res = await api('/api/git/commits', { limit: COMMITS_PAGE_SIZE, skip });
  if (!res.ok) return;

  if (reset) {
    gitCommits = res.commits || [];
  } else {
    gitCommits = [...gitCommits, ...(res.commits || [])];
  }
  commitsHasMore = !!res.hasMore;
  renderCommitsList();
}

function getCommitRefClass(refText) {
  if (refText.includes('HEAD')) return 'ref-head';
  if (refText.startsWith('tag:')) return 'ref-tag';
  if (refText.includes('/')) return 'ref-remote';
  return '';
}

function renderCommitsList() {
  const q = commitFilterText.toLowerCase();
  const filtered = q
    ? gitCommits.filter(
        (c) =>
          c.subject.toLowerCase().includes(q) ||
          c.shortHash.toLowerCase().includes(q) ||
          c.hash.toLowerCase().includes(q) ||
          c.author.toLowerCase().includes(q)
      )
    : gitCommits;

  if ($('#badge-commits-count')) $('#badge-commits-count').textContent = filtered.length;

  const listEl = $('#list-commits');
  const moreBtn = $('#btn-load-more-commits');
  if (moreBtn) {
    moreBtn.style.display = !q && commitsHasMore ? 'inline-flex' : 'none';
  }

  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="empty-box">${q ? '未找到匹配的提交记录' : '暂无提交记录'}</div>`;
    return;
  }

  listEl.innerHTML = filtered
    .map((c) => {
      const refBadges = (c.refs || [])
        .slice(0, 3)
        .map((r) => {
          const cls = getCommitRefClass(r);
          const clean = r.replace('HEAD -> ', '').replace('tag: ', '🏷 ');
          return `<span class="commit-ref-pill ${cls}" title="${escapeHtml(r)}">${escapeHtml(clean)}</span>`;
        })
        .join('');
      return `
        <div class="commit-item" data-hash="${escapeHtml(c.hash)}">
          <div class="commit-header">
            <span class="commit-hash">${highlightMatch(c.shortHash, commitFilterText)}</span>
            ${refBadges}
            <span class="commit-author">${highlightMatch(c.author, commitFilterText)}</span>
            <span class="commit-date" title="${escapeHtml(c.fullDate || '')}">${escapeHtml(c.relativeDate)}</span>
          </div>
          <div class="commit-subject" title="${escapeHtml(c.subject)}">${highlightMatch(c.subject, commitFilterText)}</div>
        </div>
      `;
    })
    .join('');
}

function setupCommitsDelegation() {
  const listEl = $('#list-commits');
  if (!listEl) return;

  listEl.addEventListener('click', (e) => {
    const item = e.target.closest('.commit-item');
    if (!item) return;
    openCommitDiffViewer(item.getAttribute('data-hash'));
  });

  listEl.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.commit-item');
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();
    hideContextMenu();
    item.classList.add('context-selected');
    const hash = item.getAttribute('data-hash');
    const commit = gitCommits.find((c) => c.hash === hash);
    const subject = commit ? commit.subject : hash;

    showContextMenu(e.clientX, e.clientY, [
      { id: 'view-diff', icon: ICONS.view, label: '查看此提交 Diff 与改动文件', handler: () => openCommitDiffViewer(hash) },
      { type: 'divider' },
      { id: 'branch-from', icon: ICONS.branch, label: '基于此提交创建新分支...', handler: () => openCreateBranchModal(hash) },
      { id: 'cherry-pick', icon: ICONS.merge, label: 'Cherry-pick 到当前分支', handler: () => handleCherryPickAction('pick', hash) },
      { type: 'divider' },
      { id: 'copy-hash', icon: ICONS.hash, label: '复制 Commit Hash', handler: () => copyText(hash, `已复制 Hash: ${hash.slice(0, 7)}`) },
      { id: 'copy-msg', icon: ICONS.copy, label: '复制提交说明', handler: () => copyText(subject, '已复制提交说明') },
      { type: 'divider' },
      { id: 'send-agent', icon: ICONS.agent, label: '让 Agent 分析此提交', handler: () => sendCommitToAgentDirect(hash, subject) },
    ]);
  });
}

// ---------------------------------------------------------------------------
// Diff Viewer Modal (Clean State Reset + Dual Line Numbers)
// ---------------------------------------------------------------------------
function resetDiffModalState() {
  const filesBar = $('#diff-commit-files-bar');
  const branchBar = $('#diff-branch-summary-bar');
  const mergeBtn = $('#btn-diff-merge-branch');
  const rebaseBtn = $('#btn-diff-rebase-branch');
  const openAgyBtn = $('#btn-diff-open-agy');
  const statsPill = $('#diff-stats-pill');

  if (filesBar) {
    filesBar.style.display = 'none';
    filesBar.innerHTML = '';
  }
  if (branchBar) {
    branchBar.style.display = 'none';
    branchBar.innerHTML = '';
  }
  if (mergeBtn) {
    mergeBtn.style.display = 'none';
    mergeBtn.onclick = null;
  }
  if (rebaseBtn) {
    rebaseBtn.style.display = 'none';
    rebaseBtn.onclick = null;
  }
  if (openAgyBtn) openAgyBtn.style.display = 'none';
  if (statsPill) {
    statsPill.style.display = 'none';
    statsPill.innerHTML = '';
  }
}

async function openDiffViewer({ path, staged = false }) {
  resetDiffModalState();
  const modal = $('#modal-diff-viewer');
  const titleEl = $('#diff-file-path');
  const tagEl = $('#diff-status-tag');
  const openAgyBtn = $('#btn-diff-open-agy');
  const container = $('#diff-code-container');

  tagEl.textContent = staged ? 'STAGED DIFF' : 'WORKING DIFF';
  titleEl.textContent = path;
  if (openAgyBtn) openAgyBtn.style.display = 'inline-flex';
  container.innerHTML = '<div class="loading-state"><div class="spinner"></div><span>计算代码差异...</span></div>';
  modal.style.display = 'flex';

  const res = await api('/api/git/diff', { relativePath: path, staged });
  if (!res.ok) {
    container.innerHTML = `<div class="empty-state"><p>无法生成 Diff: ${escapeHtml(res.error)}</p></div>`;
    return;
  }

  activeDiffTarget = {
    type: 'file',
    path,
    staged,
    diffText: res.diff,
  };

  renderUnifiedDiff(res.diff, container);
}

async function openCommitDiffViewer(commitHash, filterRelPath = '') {
  resetDiffModalState();
  const modal = $('#modal-diff-viewer');
  const titleEl = $('#diff-file-path');
  const tagEl = $('#diff-status-tag');
  const filesBar = $('#diff-commit-files-bar');
  const openAgyBtn = $('#btn-diff-open-agy');
  const container = $('#diff-code-container');

  const commit = gitCommits.find((c) => c.hash === commitHash);
  tagEl.textContent = `COMMIT ${commit ? commit.shortHash : commitHash.slice(0, 7)}`;
  titleEl.textContent = filterRelPath
    ? `${commit ? commit.subject : commitHash.slice(0, 7)} — ${filterRelPath}`
    : commit
      ? commit.subject
      : commitHash;
  if (openAgyBtn) openAgyBtn.style.display = filterRelPath ? 'inline-flex' : 'none';
  container.innerHTML = '<div class="loading-state"><div class="spinner"></div><span>获取提交 Diff...</span></div>';
  modal.style.display = 'flex';

  const [diffRes, detailRes] = await Promise.all([
    api('/api/git/diff', { commitHash, relativePath: filterRelPath || undefined }),
    !filterRelPath ? api('/api/git/commit-detail', { commitHash }) : Promise.resolve(null),
  ]);

  if (detailRes && detailRes.ok && detailRes.commit?.files?.length > 0 && filesBar) {
    const files = detailRes.commit.files;
    filesBar.style.display = 'flex';
    const chips = [
      `<button type="button" class="commit-file-chip active" data-file="">全部文件 (${files.length})</button>`,
      ...files.map((f) => {
        const shortName = f.path.split('/').pop();
        return `<button type="button" class="commit-file-chip" data-file="${escapeHtml(f.path)}" title="${escapeHtml(f.path)}">
          <span class="tree-git-badge git-${escapeHtml(f.status[0])}">${escapeHtml(f.status[0])}</span>
          <span>${escapeHtml(shortName)}</span>
        </button>`;
      }),
    ];
    filesBar.innerHTML = chips.join('');
    filesBar.onclick = (e) => {
      const chip = e.target.closest('.commit-file-chip');
      if (!chip) return;
      filesBar.querySelectorAll('.commit-file-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      const targetFile = chip.getAttribute('data-file') || '';
      loadCommitFileDiffOnly(commitHash, targetFile, commit);
    };
  }

  if (!diffRes.ok) {
    container.innerHTML = `<div class="empty-state"><p>获取失败: ${escapeHtml(diffRes.error)}</p></div>`;
    return;
  }

  activeDiffTarget = {
    type: 'commit',
    commitHash,
    path: filterRelPath || null,
    commitSubject: commit?.subject || '',
    diffText: diffRes.diff,
  };

  renderUnifiedDiff(diffRes.diff, container);
}

async function loadCommitFileDiffOnly(commitHash, relPath, commit) {
  const titleEl = $('#diff-file-path');
  const openAgyBtn = $('#btn-diff-open-agy');
  const container = $('#diff-code-container');
  titleEl.textContent = relPath
    ? `${commit ? commit.subject : commitHash.slice(0, 7)} — ${relPath}`
    : commit
      ? commit.subject
      : commitHash;
  if (openAgyBtn) openAgyBtn.style.display = relPath ? 'inline-flex' : 'none';
  container.innerHTML = '<div class="loading-state"><div class="spinner"></div><span>加载文件 Diff...</span></div>';

  const res = await api('/api/git/diff', { commitHash, relativePath: relPath || undefined });
  if (!res.ok) {
    container.innerHTML = `<div class="empty-state"><p>获取失败: ${escapeHtml(res.error)}</p></div>`;
    return;
  }
  activeDiffTarget = {
    type: 'commit',
    commitHash,
    path: relPath || null,
    commitSubject: commit?.subject || '',
    diffText: res.diff,
  };
  renderUnifiedDiff(res.diff, container);
}

async function openBranchDiffViewer(targetBranch, baseBranch = '') {
  resetDiffModalState();
  const base = baseBranch || gitBranchesData.current || 'HEAD';
  const modal = $('#modal-diff-viewer');
  const titleEl = $('#diff-file-path');
  const tagEl = $('#diff-status-tag');
  const branchBar = $('#diff-branch-summary-bar');
  const mergeBtn = $('#btn-diff-merge-branch');
  const rebaseBtn = $('#btn-diff-rebase-branch');
  const container = $('#diff-code-container');

  if (branchBar) {
    branchBar.style.display = 'flex';
    branchBar.innerHTML = '<div class="loading-state" style="padding:4px;"><div class="spinner"></div><span>获取分支差异与提交对比...</span></div>';
  }

  tagEl.textContent = 'BRANCH DIFF';
  titleEl.textContent = `${base} ⟷ ${targetBranch}`;

  if (mergeBtn && targetBranch !== base) {
    mergeBtn.style.display = 'inline-flex';
    mergeBtn.onclick = () => {
      closeDiffViewer();
      openMergeBranchModal(targetBranch);
    };
  }
  if (rebaseBtn && targetBranch !== base) {
    rebaseBtn.style.display = 'inline-flex';
    rebaseBtn.onclick = () => {
      closeDiffViewer();
      openRebaseBranchModal(targetBranch);
    };
  }

  container.innerHTML = '<div class="loading-state"><div class="spinner"></div><span>计算代码差异 (git diff)...</span></div>';
  modal.style.display = 'flex';

  const res = await api('/api/git/branch-diff', { targetBranch, baseBranch: base });
  if (!res.ok) {
    container.innerHTML = `<div class="empty-state"><p>对比失败: ${escapeHtml(res.error || '未知错误')}</p></div>`;
    if (branchBar) branchBar.style.display = 'none';
    return;
  }

  const ahead = res.aheadCount || 0;
  const behind = res.behindCount || 0;
  const aheadTip = (res.commitsTargetNotBase || []).map((c) => `${c.shortHash} ${c.subject}`).join('\n');
  const behindTip = (res.commitsBaseNotTarget || []).map((c) => `${c.shortHash} ${c.subject}`).join('\n');

  if (branchBar) {
    branchBar.innerHTML = `
      <div class="branch-diff-meta">
        <span>基准: <strong class="code-pill">${escapeHtml(res.base)}</strong></span>
        <span>对比: <strong class="code-pill">${escapeHtml(res.target)}</strong></span>
      </div>
      <div class="branch-diff-commits">
        ${ahead > 0 ? `<span class="badge-ahead" title="${escapeHtml(aheadTip || '目标分支新增提交')}">新提交 +${ahead}</span>` : '<span class="code-pill">无新提交</span>'}
        ${behind > 0 ? `<span class="badge-behind" title="${escapeHtml(behindTip || '落后基准分支提交')}">落后 -${behind}</span>` : ''}
      </div>
    `;
  }

  activeDiffTarget = {
    type: 'branch',
    targetBranch,
    baseBranch: base,
    diffText: res.diff,
  };

  if (!res.diff || !res.diff.trim()) {
    if (ahead > 0 || behind > 0) {
      const commitsHtml = (res.commitsTargetNotBase || [])
        .map(
          (c) => `
          <div class="commit-item">
            <div class="commit-header">
              <span class="commit-hash">${escapeHtml(c.shortHash)}</span>
              <span class="commit-author">${escapeHtml(c.author || '')}</span>
              <span class="commit-date">${escapeHtml(c.relativeDate || '')}</span>
            </div>
            <div class="commit-subject">${escapeHtml(c.subject || '')}</div>
          </div>`
        )
        .join('');

      container.innerHTML = `
        <div class="empty-state">
          <p style="font-weight: 600;">两分支间无代码内容差异（可能已快进或已合并）</p>
          <div style="text-align: left; width: 100%; max-width: 540px; margin-top: 6px;">
            <div style="font-size: 11.5px; font-weight: 700; margin-bottom: 6px; color: var(--text-secondary);">目标分支独有提交 (${ahead})：</div>
            <div class="commits-list">${commitsHtml || '<div class="code-pill">无</div>'}</div>
          </div>
        </div>
      `;
      return;
    }
  }

  renderUnifiedDiff(res.diff, container);
}

function renderUnifiedDiff(diffText, container, showAll = false) {
  const statsPill = $('#diff-stats-pill');

  if (!diffText || !diffText.trim()) {
    if (statsPill) statsPill.style.display = 'none';
    container.innerHTML = `<div class="empty-state"><p>该文件或提交没有代码差异内容</p></div>`;
    return;
  }

  const lines = diffText.split('\n');
  let totalAdd = 0;
  let totalDel = 0;
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) totalAdd++;
    else if (line.startsWith('-') && !line.startsWith('---')) totalDel++;
  }

  if (statsPill && (totalAdd > 0 || totalDel > 0)) {
    statsPill.innerHTML = `<span class="diff-stat-add">+${totalAdd}</span><span class="diff-stat-del">-${totalDel}</span>`;
    statsPill.style.display = 'inline-flex';
  }

  const truncated = !showAll && lines.length > DIFF_INITIAL_MAX_LINES;
  const renderLines = truncated ? lines.slice(0, DIFF_INITIAL_MAX_LINES) : lines;

  const html = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const line of renderLines) {
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      const displayFile = match ? match[2] : line.slice(11);
      html.push(`<div class="diff-file-header">${getFileIcon(displayFile).icon}<span>${escapeHtml(displayFile)}</span></div>`);
      continue;
    }

    if (
      line.startsWith('+++') ||
      line.startsWith('---') ||
      line.startsWith('index ') ||
      line.startsWith('new file mode') ||
      line.startsWith('deleted file mode') ||
      line.startsWith('Binary files')
    ) {
      html.push(`
        <div class="diff-line diff-meta">
          <span class="diff-ln"></span>
          <span class="diff-ln"></span>
          <span class="diff-gutter"></span>
          <span class="diff-content">${escapeHtml(line)}</span>
        </div>
      `);
      continue;
    }

    if (line.startsWith('@@')) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldLine = parseInt(m[1], 10);
        newLine = parseInt(m[2], 10);
        inHunk = true;
      }
      html.push(`
        <div class="diff-line diff-hunk">
          <span class="diff-ln">⋯</span>
          <span class="diff-ln">⋯</span>
          <span class="diff-gutter">@@</span>
          <span class="diff-content">${escapeHtml(line)}</span>
        </div>
      `);
      continue;
    }

    if (inHunk && line.startsWith('+')) {
      html.push(`
        <div class="diff-line diff-add">
          <span class="diff-ln"></span>
          <span class="diff-ln">${newLine++}</span>
          <span class="diff-gutter">+</span>
          <span class="diff-content">${escapeHtml(line.slice(1))}</span>
        </div>
      `);
    } else if (inHunk && line.startsWith('-')) {
      html.push(`
        <div class="diff-line diff-del">
          <span class="diff-ln">${oldLine++}</span>
          <span class="diff-ln"></span>
          <span class="diff-gutter">-</span>
          <span class="diff-content">${escapeHtml(line.slice(1))}</span>
        </div>
      `);
    } else if (inHunk && (line.startsWith(' ') || line === '')) {
      const content = line.startsWith(' ') ? line.slice(1) : '';
      html.push(`
        <div class="diff-line">
          <span class="diff-ln">${oldLine++}</span>
          <span class="diff-ln">${newLine++}</span>
          <span class="diff-gutter"> </span>
          <span class="diff-content">${escapeHtml(content)}</span>
        </div>
      `);
    } else {
      html.push(`
        <div class="diff-line diff-meta">
          <span class="diff-ln"></span>
          <span class="diff-ln"></span>
          <span class="diff-gutter"></span>
          <span class="diff-content">${escapeHtml(line)}</span>
        </div>
      `);
    }
  }

  if (truncated) {
    html.push(`
      <div class="diff-truncate-bar">
        <span>Diff 共 ${lines.length} 行，已渲染前 ${DIFF_INITIAL_MAX_LINES} 行。</span>
        <button type="button" class="mini-btn" id="btn-diff-show-all">展开全部</button>
      </div>
    `);
  }

  container.innerHTML = html.join('');
  if (truncated) {
    $('#btn-diff-show-all')?.addEventListener('click', () => renderUnifiedDiff(diffText, container, true));
  }
}

function closeDiffViewer() {
  const modal = $('#modal-diff-viewer');
  if (modal) modal.style.display = 'none';
  activeDiffTarget = null;
}

async function refreshActiveDiffSilent() {
  const modal = $('#modal-diff-viewer');
  if (!activeDiffTarget || activeDiffTarget.type !== 'file' || !modal || modal.style.display === 'none') return;
  const { path, staged } = activeDiffTarget;
  const container = $('#diff-code-container');
  if (!container) return;
  const prevScroll = container.scrollTop;

  const res = await api('/api/git/diff', { relativePath: path, staged });
  if (!activeDiffTarget || activeDiffTarget.type !== 'file' || activeDiffTarget.path !== path || modal.style.display === 'none') {
    return;
  }
  if (!res.ok) return;
  if (res.diff === activeDiffTarget.diffText) return;
  activeDiffTarget.diffText = res.diff;
  renderUnifiedDiff(res.diff, container);
  container.scrollTop = prevScroll;
}

// ---------------------------------------------------------------------------
// Agent Collaboration Interop
// ---------------------------------------------------------------------------
function sendFileToAgent() {
  if (!activePreviewFile) return;
  const content = activePreviewContent;
  const truncated = content.length > 5000 ? content.slice(0, 5000) + '\n\n...[已截断过长内容]...' : content;
  const prompt = `请帮我查看并分析工作区文件 \`${activePreviewFile}\`：\n\`\`\`\n${truncated}\n\`\`\``;

  if (window.sidecar && window.sidecar.agent) {
    window.sidecar.agent.sendMessage(prompt);
    showToast('已将文件上下文发送给 Agent', 'success');
    closeFileViewer();
  } else {
    copyText(prompt, '已复制文件提示词到剪贴板');
  }
}

function sendDiffToAgent() {
  if (!activeDiffTarget || !activeDiffTarget.diffText) {
    showToast('没有可发送的 Diff 内容', 'error');
    return;
  }
  const diff = activeDiffTarget.diffText;
  const truncated = diff.length > 6000 ? diff.slice(0, 6000) + '\n\n...[已截断过长 Diff]...' : diff;

  let prompt = '';
  if (activeDiffTarget.type === 'branch') {
    prompt = `请帮我 Review 分支 [${activeDiffTarget.targetBranch}] 与基准分支 [${activeDiffTarget.baseBranch}] 的代码差异对比：\n\`\`\`diff\n${truncated}\n\`\`\``;
  } else if (activeDiffTarget.type === 'commit') {
    prompt = `请帮我 Review Commit [${activeDiffTarget.commitHash.slice(0, 7)}] "${activeDiffTarget.commitSubject}" 的代码变更：\n\`\`\`diff\n${truncated}\n\`\`\``;
  } else {
    prompt = `请帮我 Review 文件 \`${activeDiffTarget.path}\` 的代码改动 (${activeDiffTarget.staged ? '暂存区' : '工作区'} Diff)：\n\`\`\`diff\n${truncated}\n\`\`\``;
  }

  if (window.sidecar && window.sidecar.agent) {
    window.sidecar.agent.sendMessage(prompt);
    showToast('已将 Diff 发送给 Agent 进行 Review', 'success');
    closeDiffViewer();
  } else {
    copyText(prompt, '已复制 Diff 提示词到剪贴板');
  }
}

// ---------------------------------------------------------------------------
// Global Event Binding & Initial Setup
// ---------------------------------------------------------------------------
function setupAccordion(headerSel, bodySel) {
  const header = $(headerSel);
  if (!header) return;
  header.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    const body = $(bodySel);
    const chevron = header.querySelector('.chevron');
    if (!body) return;
    const isHidden = body.style.display === 'none';
    body.style.display = isHidden ? 'flex' : 'none';
    if (chevron) chevron.classList.toggle('expanded', isHidden);
  });
}

function setupModalBackdropClose(modalSel, closeFn) {
  const modal = $(modalSel);
  if (!modal) return;
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeFn();
  });
}

function setupEvents() {
  // Delegated listeners (bound once)
  setupFileTreeDelegation();
  setupBranchListDelegation();
  setupChangesDelegation();
  setupCommitsDelegation();
  setupStashListDelegation();

  // Delegated context menu clicks
  $('#context-menu')?.addEventListener('click', (e) => {
    const el = e.target.closest('.menu-item');
    if (!el) return;
    e.stopPropagation();
    const actionId = el.getAttribute('data-action');
    const targetItem = activeContextMenuItems.find((it) => it.id === actionId);
    hideContextMenu();
    if (targetItem && typeof targetItem.handler === 'function') {
      targetItem.handler();
    }
  });

  // Tabs switcher
  $$('.nav-tab').forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.getAttribute('data-target')));
  });

  // Header branch pill shortcut
  $('#header-branch-pill')?.addEventListener('click', () => switchTab('git'));

  // Refresh
  $('#btn-refresh')?.addEventListener('click', async () => {
    await refreshAll(true);
    showToast('已刷新数据', 'success', 1500);
  });

  // Workspace badge click copy or switch (multi-root)
  $('#ws-badge')?.addEventListener('click', (e) => {
    if (availableWorkspaceUris.length > 1) {
      e.stopPropagation();
      const rect = e.currentTarget.getBoundingClientRect();
      const items = availableWorkspaceUris.map((uri, idx) => {
        const clean = decodeURIComponent(uri.replace(/^file:\/\/\/?/, ''));
        const name = clean.split(/[/\\]/).filter(Boolean).pop() || clean;
        const active = uri === currentWorkspaceUri;
        return {
          id: `ws-${idx}`,
          icon: active ? ICONS.check : ICONS.folder,
          label: name,
          hint: active ? '当前' : '',
          handler: () => {
            if (uri !== currentWorkspaceUri) {
              currentWorkspaceUri = uri;
              localStorage.setItem('agy_workspace_uri', currentWorkspaceUri);
              resetWorkspaceState();
              refreshAll(true);
            }
          },
        };
      });
      if (currentWorkspacePath) {
        items.push(
          { type: 'divider' },
          {
            id: 'ws-copy',
            icon: ICONS.copy,
            label: '复制当前工作区路径',
            handler: () => copyText(currentWorkspacePath, '已复制工作区路径'),
          }
        );
      }
      showContextMenu(rect.left, rect.bottom + 4, items);
      return;
    }
    if (currentWorkspacePath) copyText(currentWorkspacePath, '已复制工作区路径');
  });

  // Quick create file / folder
  $('#btn-new-file-top')?.addEventListener('click', () => handleCreateFile(''));
  $('#btn-new-folder-top')?.addEventListener('click', () => handleCreateFolder(''));

  // File filter input (immediate local filter + debounced full-workspace backend search)
  const filterInput = $('#file-filter-input');
  const clearBtn = $('#btn-clear-filter');
  const applyLocalFilter = debounce(() => renderFileTree(), 80);
  const applyRemoteSearch = debounce((q) => runRemoteFileSearch(q), 220);

  filterInput?.addEventListener('input', (e) => {
    filterText = e.target.value.trim();
    if (clearBtn) clearBtn.style.display = filterText ? 'block' : 'none';
    if (!filterText) {
      remoteSearchTree = null;
      remoteSearchQuery = '';
      remoteSearchTruncated = false;
      remoteSearchSeq += 1;
      updateTreeCounts(fileTreeData);
      renderFileTree();
      return;
    }
    applyLocalFilter();
    if (!gitOnlyFilter) {
      applyRemoteSearch(filterText);
    }
  });

  clearBtn?.addEventListener('click', () => {
    if (filterInput) filterInput.value = '';
    filterText = '';
    remoteSearchTree = null;
    remoteSearchQuery = '';
    remoteSearchTruncated = false;
    remoteSearchSeq += 1;
    clearBtn.style.display = 'none';
    updateTreeCounts(fileTreeData);
    renderFileTree();
  });

  // Git-only file filter toggle
  $('#btn-filter-git-only')?.addEventListener('click', (e) => {
    gitOnlyFilter = !gitOnlyFilter;
    e.currentTarget.classList.toggle('active', gitOnlyFilter);
    updateTreeCounts(fileTreeData);
    renderFileTree();
    if (!gitOnlyFilter && filterText) {
      runRemoteFileSearch(filterText);
    }
  });

  // Show/hide ignored files toggle
  const ignoredBtn = $('#btn-toggle-ignored');
  if (ignoredBtn) {
    ignoredBtn.classList.toggle('active', showIgnoredFiles);
    ignoredBtn.addEventListener('click', (e) => {
      showIgnoredFiles = !showIgnoredFiles;
      localStorage.setItem('agy_nav_show_ignored', String(showIgnoredFiles));
      e.currentTarget.classList.toggle('active', showIgnoredFiles);
      loadFileTree(true);
      showToast(showIgnoredFiles ? '已显示被忽略的目录与文件' : '已隐藏默认忽略目录 (.git / node_modules 等)', 'info', 1800);
    });
  }

  // Collapse all
  $('#btn-collapse-all')?.addEventListener('click', () => {
    expandedDirs.clear();
    saveExpandedDirsToStorage();
    renderFileTree();
  });

  // Git Init
  $('#btn-git-init')?.addEventListener('click', async (e) => {
    await withBusy(e.currentTarget, async () => {
      const res = await api('/api/git/init');
      if (res.ok) {
        showToast('✓ 已成功初始化 Git 仓库！', 'success');
        await refreshAll(true);
      } else {
        showToast(`初始化失败: ${res.error || res.message}`, 'error');
      }
    });
  });

  // Branch switcher dropdown
  $('#branch-select')?.addEventListener('change', (e) => {
    const branch = e.target.value;
    const selectedOpt = e.target.selectedOptions?.[0];
    const isRemote = selectedOpt?.getAttribute('data-remote') === 'true';
    handleCheckoutBranch(branch, isRemote);
  });

  // Branch filter tabs
  $$('.branch-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.branch-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      branchFilterTab = tab.getAttribute('data-filter') || 'all';
      renderBranchList();
    });
  });

  // Branch search (debounced)
  const branchFilterInput = $('#branch-filter-input');
  const clearBranchFilterBtn = $('#btn-clear-branch-filter');
  const applyBranchFilter = debounce(() => renderBranchList(), 120);

  branchFilterInput?.addEventListener('input', (e) => {
    branchSearchText = e.target.value.trim();
    if (clearBranchFilterBtn) clearBranchFilterBtn.style.display = branchSearchText ? 'block' : 'none';
    applyBranchFilter();
  });
  clearBranchFilterBtn?.addEventListener('click', () => {
    if (branchFilterInput) branchFilterInput.value = '';
    branchSearchText = '';
    clearBranchFilterBtn.style.display = 'none';
    renderBranchList();
  });

  // Stage All, Unstage All, Discard All
  $('#btn-stage-all')?.addEventListener('click', (e) =>
    withBusy(e.currentTarget, async () => {
      const res = await api('/api/git/stage', { relativePath: '.' });
      if (!res.ok) showToast(`暂存失败: ${res.error}`, 'error');
      await loadGitStatus();
    })
  );

  $('#btn-unstage-all')?.addEventListener('click', (e) =>
    withBusy(e.currentTarget, async () => {
      const res = await api('/api/git/unstage', { relativePath: '.' });
      if (!res.ok) showToast(`取消暂存失败: ${res.error}`, 'error');
      await loadGitStatus();
    })
  );

  $('#btn-discard-all')?.addEventListener('click', handleDiscardAll);

  // Commit & AI Commit & Quick Prefix Chips
  $('#commit-prefix-bar')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.prefix-chip');
    if (!chip) return;
    const prefix = chip.getAttribute('data-prefix') || '';
    const input = $('#commit-msg-input');
    if (!input) return;
    const stripped = input.value.replace(/^(feat|fix|refactor|style|docs|chore|perf|test|build|ci)(\([^)]*\))?:\s*/i, '');
    input.value = prefix + stripped;
    input.focus();
  });

  $('#btn-active-path-copy')?.addEventListener('click', () => {
    if (activeFilePath) copyText(activeFilePath, `已复制: ${activeFilePath}`);
  });

  $('#btn-git-commit')?.addEventListener('click', handleGitCommit);
  $('#btn-ai-commit')?.addEventListener('click', handleAiGenerateCommitMsg);
  $('#chk-commit-amend')?.addEventListener('change', updateCommitButtonLabel);
  $('#commit-msg-input')?.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleGitCommit();
    }
  });

  // Branch modals
  $('#btn-new-branch')?.addEventListener('click', () => openCreateBranchModal());
  $('#btn-close-branch-create')?.addEventListener('click', closeCreateBranchModal);
  $('#btn-cancel-branch-create')?.addEventListener('click', closeCreateBranchModal);
  $('#btn-confirm-branch-create')?.addEventListener('click', submitCreateBranch);
  $('#input-new-branch-name')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitCreateBranch();
    }
  });

  $('#btn-close-branch-merge')?.addEventListener('click', closeMergeBranchModal);
  $('#btn-cancel-branch-merge')?.addEventListener('click', closeMergeBranchModal);
  $('#btn-confirm-branch-merge')?.addEventListener('click', submitMergeBranch);
  $('#input-merge-msg')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitMergeBranch();
    }
  });

  $('#btn-close-branch-rebase')?.addEventListener('click', closeRebaseBranchModal);
  $('#btn-cancel-branch-rebase')?.addEventListener('click', closeRebaseBranchModal);
  $('#btn-confirm-branch-rebase')?.addEventListener('click', submitRebaseBranch);

  // In-progress State Banner buttons
  $('#btn-rebase-continue')?.addEventListener('click', handleRebaseContinue);
  $('#btn-rebase-skip')?.addEventListener('click', handleRebaseSkip);
  $('#btn-rebase-abort')?.addEventListener('click', handleRebaseAbort);
  $('#btn-merge-abort')?.addEventListener('click', handleMergeAbort);
  $('#btn-cherrypick-continue')?.addEventListener('click', () => handleCherryPickAction('continue'));
  $('#btn-cherrypick-abort')?.addEventListener('click', () => handleCherryPickAction('abort'));

  // Remote ops & Stash
  $('#btn-git-fetch')?.addEventListener('click', (e) => handleGitRemoteOp('Fetch', '/api/git/fetch', e.currentTarget));
  $('#btn-git-pull')?.addEventListener('click', (e) => handleGitRemoteOp('Pull', '/api/git/pull', e.currentTarget));
  $('#btn-git-push')?.addEventListener('click', (e) => handleGitRemoteOp('Push', '/api/git/push', e.currentTarget));
  $('#btn-git-stash')?.addEventListener('click', handleGitStashPush);
  $('#btn-git-stash-pop')?.addEventListener('click', handleGitStashPop);
  $('#btn-git-stash-toggle')?.addEventListener('click', (e) => {
    stashDrawerOpen = !stashDrawerOpen;
    e.currentTarget.classList.toggle('active', stashDrawerOpen);
    const drawer = $('#stash-drawer');
    if (drawer) drawer.style.display = stashDrawerOpen ? 'flex' : 'none';
    if (stashDrawerOpen) loadGitStashes();
  });

  // Commit history filter & pagination
  const commitFilterInput = $('#commit-filter-input');
  const clearCommitFilterBtn = $('#btn-clear-commit-filter');
  const applyCommitFilter = debounce(() => renderCommitsList(), 120);

  commitFilterInput?.addEventListener('input', (e) => {
    commitFilterText = e.target.value.trim();
    if (clearCommitFilterBtn) clearCommitFilterBtn.style.display = commitFilterText ? 'block' : 'none';
    applyCommitFilter();
  });
  clearCommitFilterBtn?.addEventListener('click', () => {
    if (commitFilterInput) commitFilterInput.value = '';
    commitFilterText = '';
    clearCommitFilterBtn.style.display = 'none';
    renderCommitsList();
  });
  $('#btn-load-more-commits')?.addEventListener('click', (e) =>
    withBusy(e.currentTarget, () => loadGitCommits(false))
  );

  // Accordions
  setupAccordion('#header-branches', '#body-branches');
  setupAccordion('#header-changes', '#body-changes');
  setupAccordion('#header-commits', '#body-commits');

  // File & Diff Modal actions
  $('#btn-close-file-modal')?.addEventListener('click', closeFileViewer);
  $('#btn-close-diff-modal')?.addEventListener('click', closeDiffViewer);

  $('#btn-preview-wrap')?.addEventListener('click', (e) => {
    previewWrapLines = !previewWrapLines;
    e.currentTarget.classList.toggle('active', previewWrapLines);
    $('#preview-code-container')?.classList.toggle('wrap-lines', previewWrapLines);
  });

  $('#btn-diff-wrap')?.addEventListener('click', (e) => {
    diffWrapLines = !diffWrapLines;
    e.currentTarget.classList.toggle('active', diffWrapLines);
    $('#diff-code-container')?.classList.toggle('wrap-lines', diffWrapLines);
  });

  $('#btn-copy-file-content')?.addEventListener('click', () => {
    if (activePreviewContent) copyText(activePreviewContent, '已复制文件内容');
  });

  $('#btn-copy-diff')?.addEventListener('click', () => {
    if (activeDiffTarget?.diffText) copyText(activeDiffTarget.diffText, '已复制完整 Diff');
    else showToast('无 Diff 内容可复制');
  });

  $('#btn-open-agy')?.addEventListener('click', () => {
    if (activePreviewFile) {
      openInAgyHost(activePreviewFile);
      closeFileViewer();
    }
  });

  $('#btn-diff-open-agy')?.addEventListener('click', () => {
    if (activeDiffTarget?.path) openInAgyHost(activeDiffTarget.path);
  });

  $('#btn-copy-path')?.addEventListener('click', () => {
    if (activePreviewFile) copyText(activePreviewFile, `已复制路径: ${activePreviewFile}`);
  });

  $('#btn-send-file-agent')?.addEventListener('click', sendFileToAgent);
  $('#btn-send-diff-agent')?.addEventListener('click', sendDiffToAgent);

  // Prompt Modal
  $('#btn-close-prompt-modal')?.addEventListener('click', () => closePromptModal(null));
  $('#btn-prompt-cancel')?.addEventListener('click', () => closePromptModal(null));
  $('#btn-prompt-confirm')?.addEventListener('click', () => {
    closePromptModal($('#prompt-input').value.trim() || null);
  });
  $('#prompt-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      closePromptModal(e.target.value.trim() || null);
    }
  });

  // Confirm Modal
  $('#btn-close-confirm-modal')?.addEventListener('click', () => closeConfirmModal(false));
  $('#btn-confirm-cancel')?.addEventListener('click', () => closeConfirmModal(false));
  $('#btn-confirm-ok')?.addEventListener('click', () => closeConfirmModal(true));

  // Backdrop clicks to close modals
  setupModalBackdropClose('#modal-file-viewer', closeFileViewer);
  setupModalBackdropClose('#modal-diff-viewer', closeDiffViewer);
  setupModalBackdropClose('#modal-branch-create', closeCreateBranchModal);
  setupModalBackdropClose('#modal-branch-merge', closeMergeBranchModal);
  setupModalBackdropClose('#modal-branch-rebase', closeRebaseBranchModal);
  setupModalBackdropClose('#modal-prompt', () => closePromptModal(null));
  setupModalBackdropClose('#modal-confirm', () => closeConfirmModal(false));

  // Global dismiss context menu
  window.addEventListener('click', (e) => {
    if (!e.target.closest('#context-menu')) hideContextMenu();
  });
  window.addEventListener('scroll', hideContextMenu, true);

  // Keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideContextMenu();
      closeConfirmModal(false);
      closePromptModal(null);
      closeCreateBranchModal();
      closeMergeBranchModal();
      closeRebaseBranchModal();
      closeFileViewer();
      closeDiffViewer();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      const targetInput = currentTab === 'files' ? $('#file-filter-input') : $('#branch-filter-input');
      if (targetInput) {
        e.preventDefault();
        targetInput.focus();
        targetInput.select();
      }
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      refreshAll(true);
    }
  });
  // Auto-sync when panel regains focus or becomes visible
  const triggerFocusSync = debounce(() => {
    if (document.visibilityState === 'visible') {
      pollWorkspaceChanges(true);
    }
  }, 150);
  window.addEventListener('focus', triggerFocusSync);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      triggerFocusSync();
    }
  });
}

function switchTab(tab) {
  currentTab = tab;
  $$('.nav-tab').forEach((t) => {
    const active = t.getAttribute('data-target') === tab;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', String(active));
  });
  $$('.view-panel').forEach((p) => p.classList.toggle('active', p.id === `view-${tab}`));

  if (tab === 'git') {
    loadGitData();
  } else if (tab === 'files') {
    pollWorkspaceChanges(true);
  }
}

async function pollWorkspaceChanges(forceGitCheck = false) {
  if (watchPollInFlight || refreshInFlight) return;
  if (document.visibilityState !== 'visible') return;
  watchPollInFlight = true;
  try {
    const res = await api('/api/watch/poll');
    if (!res || !res.ok) return;

    watchActive = !!res.watchActive;
    const nextTreeVer = typeof res.version === 'number' ? res.version : 0;
    const nextGitVer = typeof res.gitVersion === 'number' ? res.gitVersion : 0;

    if (lastWatchVersion === 0 && lastGitWatchVersion === 0) {
      lastWatchVersion = nextTreeVer;
      lastGitWatchVersion = nextGitVer;
      return;
    }

    const treeChanged = nextTreeVer !== lastWatchVersion;
    const gitChanged = nextGitVer !== lastGitWatchVersion;

    if (treeChanged) lastWatchVersion = nextTreeVer;
    if (gitChanged) lastGitWatchVersion = nextGitVer;

    const tasks = [];
    if (treeChanged) {
      tasks.push(loadFileTree(true));
      tasks.push(refreshActiveFilePreviewSilent());
    }
    if (gitChanged || (forceGitCheck && !watchActive)) {
      tasks.push(loadGitData());
      tasks.push(refreshActiveDiffSilent());
    }

    if (tasks.length > 0) {
      await Promise.all(tasks);
    }
  } catch {
    // Ignore transient poll errors
  } finally {
    watchPollInFlight = false;
  }
}

function startWorkspaceWatchLoop() {
  if (watchPollTimer) clearInterval(watchPollTimer);
  watchPollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') {
      pollWorkspaceChanges(false);
    }
  }, WATCH_POLL_INTERVAL_MS);
}

async function refreshAll(showSpin = false) {
  if (refreshInFlight) {
    refreshQueued = true;
    return;
  }
  refreshInFlight = true;
  const icon = $('#icon-refresh');
  if (showSpin && icon) icon.classList.add('spinning');
  try {
    await Promise.all([
      loadFileTree(true),
      loadGitData(),
      refreshActiveFilePreviewSilent(),
      refreshActiveDiffSilent(),
    ]);
    // Sync watch baseline after manual/full refresh
    const pollRes = await api('/api/watch/poll');
    if (pollRes && pollRes.ok) {
      watchActive = !!pollRes.watchActive;
      if (typeof pollRes.version === 'number') lastWatchVersion = pollRes.version;
      if (typeof pollRes.gitVersion === 'number') lastGitWatchVersion = pollRes.gitVersion;
    }
  } finally {
    refreshInFlight = false;
    if (showSpin && icon) {
      setTimeout(() => icon.classList.remove('spinning'), 350);
    }
    if (refreshQueued) {
      refreshQueued = false;
      refreshAll(false);
    }
  }
}

function resetWorkspaceState() {
  fileTreeData = [];
  remoteSearchTree = null;
  remoteSearchQuery = '';
  remoteSearchTruncated = false;
  lastWatchVersion = 0;
  lastGitWatchVersion = 0;
  loadingDirs.clear();
  activeFilePath = null;
  updateActivePathBar();
  gitCommits = [];
  commitsHasMore = false;
  stashDrawerOpen = false;
  const drawer = $('#stash-drawer');
  if (drawer) drawer.style.display = 'none';
  $('#btn-git-stash-toggle')?.classList.remove('active');
  loadExpandedDirsFromStorage();
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
function applyWorkspaceUris(uris, triggerRefreshIfChanged = false) {
  if (!Array.isArray(uris) || uris.length === 0) return;
  availableWorkspaceUris = uris;
  const nextUri = uris.includes(currentWorkspaceUri) ? currentWorkspaceUri : uris[0];
  const changed = nextUri && nextUri !== currentWorkspaceUri;
  if (changed) {
    currentWorkspaceUri = nextUri;
    localStorage.setItem('agy_workspace_uri', currentWorkspaceUri);
    resetWorkspaceState();
    if (triggerRefreshIfChanged) {
      refreshAll(true);
    }
  } else {
    updateWorkspaceBadge(currentWorkspacePath);
  }
}

async function init() {
  loadExpandedDirsFromStorage();
  setupEvents();

  if (window.sidecar && typeof window.sidecar.getWorkspaceUris === 'function') {
    let initialResolved = false;
    const urisPromise = Promise.resolve(window.sidecar.getWorkspaceUris())
      .then((uris) => {
        if (uris && uris.length > 0) {
          applyWorkspaceUris(uris, initialResolved);
        }
        return uris || [];
      })
      .catch((e) => {
        console.warn('Failed to get workspace URIs:', e);
        return [];
      });

    try {
      const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve([]), 1200));
      await Promise.race([urisPromise, timeoutPromise]);
    } catch {}
    initialResolved = true;

    window.sidecar.onWorkspaceChange?.((uris) => {
      if (uris && uris.length > 0) {
        applyWorkspaceUris(uris, true);
      }
    });
  }

  await refreshAll(false);
  startWorkspaceWatchLoop();
}

// Start
init();
