import { execFile } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  watch,
} from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';

const HERE = dirname(fileURLToPath(import.meta.url));
const STARTED_AT = Date.now();
const app = new SidecarApp();

function getAssetVersion() {
  let latest = STARTED_AT;
  for (const file of ['index.html', 'styles.css', 'app.js']) {
    try {
      const m = statSync(join(HERE, file)).mtimeMs;
      if (m > latest) latest = Math.floor(m);
    } catch {}
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------
const readLocal = (name) => readFileSync(join(HERE, name), 'utf8');

app.page('/', () => new Response(readLocal('index.html'), { contentType: 'text/html', headers: { 'Cache-Control': 'no-cache' } }));
app.page('/app.js', () => new Response(readLocal('app.js'), { contentType: 'application/javascript', headers: { 'Cache-Control': 'no-cache' } }));
app.api('/styles.css', () => new Response(readLocal('styles.css'), { contentType: 'text/css', headers: { 'Cache-Control': 'no-cache' } }), 'GET');

// ---------------------------------------------------------------------------
// Workspace path helper & security
// ---------------------------------------------------------------------------
function resolveWorkspaceDir(workspaceUri) {
  if (!workspaceUri) {
    return process.cwd();
  }
  let localPath = workspaceUri;
  if (localPath.startsWith('file://')) {
    try {
      localPath = fileURLToPath(localPath);
    } catch {
      localPath = localPath.replace(/^file:\/\/\/?/, '');
      if (process.platform === 'win32' && !localPath.includes(':')) {
        localPath = 'C:/' + localPath;
      }
    }
  }
  return resolve(localPath);
}

function resolveSafePath(workspaceDir, relPath = '') {
  const root = resolve(workspaceDir);
  const target = resolve(root, relPath);
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Access denied: Path is outside of workspace');
  }
  return target;
}

const INVALID_WIN_CHARS = /[<>:"|?*\x00-\x1f]/;

function validateEntryName(name, allowNested = false) {
  const trimmed = (name || '').trim();
  if (!trimmed) return '名称不能为空';
  const segments = trimmed.replace(/\\/g, '/').split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return '名称无效';
  if (!allowNested && segments.length > 1) return '名称不能包含路径分隔符';
  for (const seg of segments) {
    if (seg === '.' || seg === '..') return '名称不能包含 "." 或 ".."';
    if (INVALID_WIN_CHARS.test(seg)) return '名称包含非法字符 (< > : " | ? *)';
  }
  return null;
}

function toPosix(p) {
  return p.replace(/\\/g, '/');
}

function unquoteGitPath(p) {
  let s = p.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return s;
}

// ---------------------------------------------------------------------------
// Git CLI Runner
// ---------------------------------------------------------------------------
function runGit(args, cwd, timeoutMs = 30000) {
  return new Promise((resolveResult) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=false', ...args],
      {
        cwd,
        windowsHide: true,
        maxBuffer: 20 * 1024 * 1024,
        timeout: timeoutMs,
      },
      (error, stdout, stderr) => {
        const isTimeout = Boolean(error && (error.killed || error.signal === 'SIGTERM'));
        resolveResult({
          ok: !error,
          code: error ? (error.code ?? 1) : 0,
          stdout: stdout ? stdout.toString() : '',
          stderr: isTimeout
            ? `Git 命令执行超时 (${Math.round(timeoutMs / 1000)}s)`
            : stderr
              ? stderr.toString()
              : '',
        });
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Workspace Filesystem Watcher Manager
// ---------------------------------------------------------------------------
const WATCHER_IDLE_TTL_MS = 15 * 60 * 1000;
const WATCH_DEBOUNCE_MS = 160;
const WATCH_NOISE_TOP_DIRS = new Set([
  'node_modules',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.venv',
  'venv',
]);

const workspaceWatchers = new Map();

function normalizeWatchKey(wsDir) {
  const resolved = resolve(wsDir);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function classifyWatchEvent(rawFilename) {
  if (!rawFilename) {
    return { tree: true, git: true };
  }
  const rel = toPosix(String(rawFilename)).replace(/^\/+/, '');
  if (!rel) return { tree: true, git: true };

  // Ignore noisy .git internal writes & lock files to avoid self-triggering loops from `git status`
  if (rel === '.git' || rel.startsWith('.git/')) {
    const sub = rel === '.git' ? '' : rel.slice(5);
    if (!sub) return { tree: false, git: false };
    if (sub.endsWith('.lock') || sub.startsWith('objects/') || sub.startsWith('logs/')) {
      return { tree: false, git: false };
    }
    if (
      sub === 'HEAD' ||
      sub === 'index' ||
      sub === 'packed-refs' ||
      sub === 'MERGE_HEAD' ||
      sub === 'REBASE_HEAD' ||
      sub === 'CHERRY_PICK_HEAD' ||
      sub === 'FETCH_HEAD' ||
      sub.startsWith('refs/') ||
      sub.startsWith('rebase-merge/') ||
      sub.startsWith('rebase-apply/')
    ) {
      return { tree: false, git: true };
    }
    return { tree: false, git: false };
  }

  // Ignore deep internal churn inside dependency/cache directories (still allow top-level dir creation/deletion)
  const parts = rel.split('/');
  if (parts.length > 1 && WATCH_NOISE_TOP_DIRS.has(parts[0])) {
    return { tree: false, git: false };
  }
  // Ignore common editor temporary swap/lock files
  const base = parts[parts.length - 1];
  if (base.endsWith('.tmp') && base.startsWith('.')) {
    return { tree: false, git: false };
  }

  return { tree: true, git: true };
}

function computeFallbackFingerprint(wsDir) {
  const parts = [];
  try {
    const rootStat = statSync(wsDir);
    parts.push(`r:${Math.floor(rootStat.mtimeMs)}`);
    const entries = readdirSync(wsDir);
    parts.push(`c:${entries.length}`);
  } catch {}
  for (const gitFile of ['.git/HEAD', '.git/index', '.git/packed-refs', '.git/MERGE_HEAD']) {
    try {
      const st = statSync(join(wsDir, gitFile));
      parts.push(`${gitFile}:${Math.floor(st.mtimeMs)}:${st.size}`);
    } catch {}
  }
  return parts.join('|');
}

function closeWatcherEntry(key, entry) {
  if (!entry) return;
  if (entry.debounceTimer) {
    clearTimeout(entry.debounceTimer);
    entry.debounceTimer = null;
  }
  if (entry.watcher) {
    try {
      entry.watcher.close();
    } catch {}
    entry.watcher = null;
  }
  entry.active = false;
  workspaceWatchers.delete(key);
}

function ensureWorkspaceWatcher(wsDir) {
  const key = normalizeWatchKey(wsDir);
  let entry = workspaceWatchers.get(key);
  if (entry) {
    entry.lastAccessAt = Date.now();
    if (!entry.active && Date.now() - entry.lastStartAttemptAt > 10000) {
      attachFsWatcher(key, entry);
    }
    return entry;
  }

  entry = {
    wsDir: resolve(wsDir),
    version: 1,
    gitVersion: 1,
    active: false,
    watcher: null,
    pendingTree: false,
    pendingGit: false,
    debounceTimer: null,
    lastAccessAt: Date.now(),
    lastStartAttemptAt: 0,
    fallbackFingerprint: '',
  };
  workspaceWatchers.set(key, entry);
  attachFsWatcher(key, entry);
  return entry;
}

function scheduleWatcherBump(entry, { tree = false, git = false }) {
  if (!tree && !git) return;
  if (tree) entry.pendingTree = true;
  if (git) entry.pendingGit = true;
  if (entry.debounceTimer) return;

  entry.debounceTimer = setTimeout(() => {
    entry.debounceTimer = null;
    if (entry.pendingTree) {
      entry.version += 1;
      entry.pendingTree = false;
    }
    if (entry.pendingGit) {
      entry.gitVersion += 1;
      entry.pendingGit = false;
    }
  }, WATCH_DEBOUNCE_MS);
  if (typeof entry.debounceTimer.unref === 'function') {
    entry.debounceTimer.unref();
  }
}

function attachFsWatcher(key, entry) {
  entry.lastStartAttemptAt = Date.now();
  if (!existsSync(entry.wsDir)) {
    entry.active = false;
    return;
  }
  try {
    const watcher = watch(entry.wsDir, { recursive: true, persistent: false }, (_eventType, filename) => {
      const flags = classifyWatchEvent(filename);
      if (flags.tree || flags.git) {
        scheduleWatcherBump(entry, flags);
      }
    });
    watcher.on('error', () => {
      try {
        watcher.close();
      } catch {}
      if (entry.watcher === watcher) {
        entry.watcher = null;
        entry.active = false;
      }
    });
    entry.watcher = watcher;
    entry.active = true;
  } catch {
    entry.watcher = null;
    entry.active = false;
    entry.fallbackFingerprint = computeFallbackFingerprint(entry.wsDir);
  }
}

function notifyWorkspaceChange(wsDir, { tree = true, git = true } = {}) {
  const key = normalizeWatchKey(wsDir);
  const entry = workspaceWatchers.get(key);
  if (!entry) return;
  if (tree) entry.version += 1;
  if (git) entry.gitVersion += 1;
}

const watcherCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of workspaceWatchers.entries()) {
    if (now - entry.lastAccessAt > WATCHER_IDLE_TTL_MS) {
      closeWatcherEntry(key, entry);
    }
  }
}, 5 * 60 * 1000);
if (typeof watcherCleanupTimer.unref === 'function') {
  watcherCleanupTimer.unref();
}

app.api('/api/watch/poll', async (data) => {
  try {
    const wsDir = resolveWorkspaceDir(data?.workspaceUri);
    if (!existsSync(wsDir)) {
      return { ok: false, error: 'Workspace does not exist', startedAt: getAssetVersion() };
    }
    const entry = ensureWorkspaceWatcher(wsDir);
    if (!entry.active) {
      const fp = computeFallbackFingerprint(wsDir);
      if (entry.fallbackFingerprint && fp !== entry.fallbackFingerprint) {
        entry.version += 1;
        entry.gitVersion += 1;
      }
      entry.fallbackFingerprint = fp;
    }
    return {
      ok: true,
      startedAt: getAssetVersion(),
      workspace: wsDir,
      version: entry.version,
      gitVersion: entry.gitVersion,
      watchActive: entry.active,
    };
  } catch (err) {
    return { ok: false, error: err.message, startedAt: getAssetVersion() };
  }
});

// ---------------------------------------------------------------------------
// Filesystem APIs
// ---------------------------------------------------------------------------
const DEFAULT_IGNORED_NAMES = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.venv',
  'venv',
  '.DS_Store',
  'Thumbs.db',
]);

// Directories that are shown in the tree (when not ignored), but not eagerly auto-expanded
const HEAVY_DIRS = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.venv',
  'venv',
  'dist',
  'build',
  'target',
  '.next',
  '.nuxt',
  'out',
  'vendor',
  '.cache',
]);

const IMAGE_MIME_MAP = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

function isIgnoredName(name, showIgnored = false) {
  if (showIgnored) return false;
  return DEFAULT_IGNORED_NAMES.has(name);
}

function inspectEntryStat(fullPath) {
  let lst;
  try {
    lst = lstatSync(fullPath);
  } catch {
    return null;
  }

  const isSymlink = lst.isSymbolicLink();
  if (!isSymlink) {
    return {
      isDirectory: lst.isDirectory(),
      isFile: lst.isFile(),
      isSymlink: false,
      brokenSymlink: false,
      size: lst.size,
      mtime: lst.mtimeMs,
    };
  }

  try {
    const targetStat = statSync(fullPath);
    return {
      isDirectory: targetStat.isDirectory(),
      isFile: targetStat.isFile(),
      isSymlink: true,
      brokenSymlink: false,
      size: targetStat.size,
      mtime: targetStat.mtimeMs,
    };
  } catch {
    return {
      isDirectory: false,
      isFile: true,
      isSymlink: true,
      brokenSymlink: true,
      size: 0,
      mtime: lst.mtimeMs,
    };
  }
}

function dirHasVisibleEntries(dirPath, showIgnored = false) {
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const ent of entries) {
      if (isIgnoredName(ent.name, showIgnored)) continue;
      const info = inspectEntryStat(join(dirPath, ent.name));
      if (info && (info.isDirectory || info.isFile)) return true;
    }
  } catch {}
  return false;
}

function readDirectChildren(dirPath, rootDir, showIgnored = false) {
  let rawEntries;
  try {
    rawEntries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const items = [];
  for (const ent of rawEntries) {
    if (isIgnoredName(ent.name, showIgnored)) continue;
    const fullPath = join(dirPath, ent.name);
    const info = inspectEntryStat(fullPath);
    if (!info) continue;
    const relPath = toPosix(relative(rootDir, fullPath));

    if (info.isDirectory) {
      items.push({
        name: ent.name,
        path: relPath,
        type: 'directory',
        hasChildren: false,
        ...(info.isSymlink ? { isSymlink: true } : {}),
        _fullPath: fullPath,
      });
    } else if (info.isFile) {
      items.push({
        name: ent.name,
        path: relPath,
        type: 'file',
        size: info.size,
        mtime: info.mtime,
        ...(info.isSymlink ? { isSymlink: true } : {}),
        ...(info.brokenSymlink ? { brokenSymlink: true } : {}),
      });
    }
  }

  items.sort((a, b) => {
    const aDir = a.type === 'directory';
    const bDir = b.type === 'directory';
    if (aDir === bDir) {
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    }
    return aDir ? -1 : 1;
  });

  return items;
}

function stripInternalFields(nodes) {
  for (const node of nodes) {
    if ('_fullPath' in node) delete node._fullPath;
    if (Array.isArray(node.children)) {
      stripInternalFields(node.children);
    }
  }
  return nodes;
}

function buildFileTreeBFS(
  targetDir,
  rootDir,
  { maxDepth = 2, expandedPaths = [], showIgnored = false, maxNodes = 5000 } = {}
) {
  const expandedSet = new Set(
    (Array.isArray(expandedPaths) ? expandedPaths : [])
      .map((p) => (typeof p === 'string' ? toPosix(p).replace(/^\/+|\/+$/g, '') : ''))
      .filter(Boolean)
  );
  // Also include ancestor directories of expanded paths so deeply nested expanded nodes are reachable
  for (const p of Array.from(expandedSet)) {
    const segs = p.split('/');
    for (let i = 1; i < segs.length; i++) {
      expandedSet.add(segs.slice(0, i).join('/'));
    }
  }

  const budget = { count: 0, max: maxNodes, truncated: false };
  const rootChildren = readDirectChildren(targetDir, rootDir, showIgnored);
  budget.count += rootChildren.length;

  // Two-tier BFS queue: explicitly expanded dirs are always hydrated first, then normal eager pre-expansion
  const expandedQueue = [];
  const eagerQueue = [];
  const MAX_EXPANDED_DEPTH = 25;

  function enqueueChildDirs(items, nextDepth) {
    for (const item of items) {
      if (item.type !== 'directory') continue;
      const isExplicitlyExpanded = expandedSet.has(item.path);
      if (isExplicitlyExpanded && nextDepth <= MAX_EXPANDED_DEPTH) {
        expandedQueue.push({ node: item, depth: nextDepth, explicit: true });
      } else if (nextDepth <= maxDepth && !item.isSymlink && !HEAVY_DIRS.has(item.name)) {
        eagerQueue.push({ node: item, depth: nextDepth, explicit: false });
      } else {
        item.hasChildren = dirHasVisibleEntries(item._fullPath, showIgnored);
      }
    }
  }

  enqueueChildDirs(rootChildren, 1);

  while (expandedQueue.length > 0 || eagerQueue.length > 0) {
    const task = expandedQueue.length > 0 ? expandedQueue.shift() : eagerQueue.shift();
    const { node, depth, explicit } = task;

    if (!explicit && budget.count >= budget.max) {
      budget.truncated = true;
      // Leave node.children as undefined so frontend can still lazy-load on click!
      node.hasChildren = dirHasVisibleEntries(node._fullPath, showIgnored);
      continue;
    }

    const children = readDirectChildren(node._fullPath, rootDir, showIgnored);
    node.children = children;
    node.hasChildren = children.length > 0;
    budget.count += children.length;

    // Avoid eagerly diving into huge directories unless explicitly expanded
    const tooWideForEager = !explicit && children.length > 400;
    if (tooWideForEager) {
      budget.truncated = true;
      for (const ch of children) {
        if (ch.type === 'directory') {
          if (expandedSet.has(ch.path) && depth + 1 <= MAX_EXPANDED_DEPTH) {
            expandedQueue.push({ node: ch, depth: depth + 1, explicit: true });
          } else {
            ch.hasChildren = dirHasVisibleEntries(ch._fullPath, showIgnored);
          }
        }
      }
    } else {
      enqueueChildDirs(children, depth + 1);
    }
  }

  return {
    tree: stripInternalFields(rootChildren),
    truncated: budget.truncated,
  };
}

function searchWorkspaceFiles(rootDir, query, { showIgnored = false, limit = 250 } = {}) {
  const q = query.trim().toLowerCase();
  if (!q) return { tree: [], totalMatches: 0, truncated: false };

  const matchedFiles = [];
  const matchedDirs = new Set();
  let scanned = 0;
  const MAX_SCAN = 30000;
  const deadline = Date.now() + 800;
  let truncated = false;

  const queue = [{ fullPath: rootDir, relPath: '', depth: 0 }];
  while (queue.length > 0) {
    if (scanned >= MAX_SCAN || matchedFiles.length >= limit || Date.now() > deadline) {
      truncated = true;
      break;
    }
    const cur = queue.shift();
    if (cur.depth > 25) continue;

    let entries;
    try {
      entries = readdirSync(cur.fullPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of entries) {
      if (isIgnoredName(ent.name, showIgnored)) continue;
      scanned += 1;
      if (scanned > MAX_SCAN) {
        truncated = true;
        break;
      }
      const fullPath = join(cur.fullPath, ent.name);
      const info = inspectEntryStat(fullPath);
      if (!info) continue;
      const relPath = cur.relPath ? `${cur.relPath}/${ent.name}` : ent.name;
      const lowerName = ent.name.toLowerCase();
      const lowerRel = relPath.toLowerCase();

      if (info.isDirectory) {
        if (lowerName.includes(q) || lowerRel.includes(q)) {
          matchedDirs.add(relPath);
        }
        // Skip symlinks and heavy dirs during deep search unless explicitly matching
        if (!info.isSymlink && (showIgnored || !HEAVY_DIRS.has(ent.name))) {
          queue.push({ fullPath, relPath, depth: cur.depth + 1 });
        }
      } else if (info.isFile) {
        if (lowerName.includes(q) || lowerRel.includes(q)) {
          matchedFiles.push({
            name: ent.name,
            path: relPath,
            type: 'file',
            size: info.size,
            mtime: info.mtime,
            ...(info.isSymlink ? { isSymlink: true } : {}),
          });
          if (matchedFiles.length >= limit) {
            truncated = true;
            break;
          }
        }
      }
    }
  }

  // Assemble compact tree from matched files and matched directories
  const rootMap = new Map();
  function ensureDirNode(dirRelPath) {
    const segs = dirRelPath.split('/').filter(Boolean);
    let currentMap = rootMap;
    let acc = '';
    let node = null;
    for (const seg of segs) {
      acc = acc ? `${acc}/${seg}` : seg;
      node = currentMap.get(acc);
      if (!node) {
        node = {
          name: seg,
          path: acc,
          type: 'directory',
          hasChildren: true,
          children: [],
          _childMap: new Map(),
        };
        currentMap.set(acc, node);
      }
      currentMap = node._childMap;
    }
    return node;
  }

  for (const dirRel of matchedDirs) {
    const node = ensureDirNode(dirRel);
    if (node) {
      node.hasChildren = dirHasVisibleEntries(join(rootDir, dirRel), showIgnored);
    }
  }

  for (const f of matchedFiles) {
    const idx = f.path.lastIndexOf('/');
    if (idx === -1) {
      rootMap.set(f.path, f);
    } else {
      const parentRel = f.path.slice(0, idx);
      const parentNode = ensureDirNode(parentRel);
      parentNode._childMap.set(f.path, f);
    }
  }

  function finalizeMap(map) {
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
        const finalizedChildren = finalizeMap(item._childMap);
        if (finalizedChildren.length > 0) {
          item.children = finalizedChildren;
          item.hasChildren = true;
        } else {
          delete item.children;
        }
        delete item._childMap;
      }
    }
    return arr;
  }

  return {
    tree: finalizeMap(rootMap),
    totalMatches: matchedFiles.length + matchedDirs.size,
    truncated,
  };
}

app.api('/api/files/tree', async (data) => {
  try {
    const wsDir = resolveWorkspaceDir(data?.workspaceUri);
    const subPath = data?.subPath || '';
    const maxDepth = typeof data?.maxDepth === 'number' ? Math.max(0, Math.min(data.maxDepth, 6)) : 2;
    const showIgnored = !!data?.showIgnored;
    const expandedPaths = Array.isArray(data?.expandedPaths) ? data.expandedPaths : [];
    const targetDir = resolveSafePath(wsDir, subPath);

    if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
      return { ok: false, error: 'Directory does not exist', startedAt: getAssetVersion() };
    }

    const watcherEntry = ensureWorkspaceWatcher(wsDir);
    const { tree, truncated } = buildFileTreeBFS(targetDir, wsDir, {
      maxDepth,
      expandedPaths,
      showIgnored,
      maxNodes: 5000,
    });
    return {
      ok: true,
      startedAt: getAssetVersion(),
      workspace: wsDir,
      subPath,
      truncated,
      watchVersion: watcherEntry.version,
      gitWatchVersion: watcherEntry.gitVersion,
      watchActive: watcherEntry.active,
      tree,
    };
  } catch (err) {
    return { ok: false, error: err.message, startedAt: getAssetVersion() };
  }
});

app.api('/api/files/search', async (data) => {
  try {
    const wsDir = resolveWorkspaceDir(data?.workspaceUri);
    const query = typeof data?.query === 'string' ? data.query.trim() : '';
    const showIgnored = !!data?.showIgnored;
    const limit = typeof data?.limit === 'number' ? Math.max(10, Math.min(data.limit, 500)) : 250;

    if (!existsSync(wsDir) || !statSync(wsDir).isDirectory()) {
      return { ok: false, error: 'Directory does not exist', startedAt: getAssetVersion() };
    }

    const result = searchWorkspaceFiles(wsDir, query, { showIgnored, limit });
    return {
      ok: true,
      startedAt: getAssetVersion(),
      ...result,
    };
  } catch (err) {
    return { ok: false, error: err.message, startedAt: getAssetVersion() };
  }
});

app.api('/api/files/read', async (data) => {
  try {
    const wsDir = resolveWorkspaceDir(data?.workspaceUri);
    const relPath = data?.relativePath;
    if (!relPath) return { ok: false, error: 'relativePath is required' };

    const targetFile = resolveSafePath(wsDir, relPath);
    if (!existsSync(targetFile) || !statSync(targetFile).isFile()) {
      return { ok: false, error: 'File not found' };
    }

    const st = statSync(targetFile);
    const ext = extname(targetFile).toLowerCase();
    const imageMime = IMAGE_MIME_MAP[ext];

    // Image preview support (up to 5 MB, SVG still optionally readable as text or image)
    if (imageMime && ext !== '.svg') {
      if (st.size > 5 * 1024 * 1024) {
        return {
          ok: true,
          tooLarge: true,
          isImage: true,
          size: st.size,
          relativePath: relPath,
          content: `[图片文件过大 (${(st.size / 1024 / 1024).toFixed(2)} MB)，未直接加载预览]`,
        };
      }
      const buf = readFileSync(targetFile);
      return {
        ok: true,
        isImage: true,
        mimeType: imageMime,
        size: st.size,
        relativePath: relPath,
        dataUrl: `data:${imageMime};base64,${buf.toString('base64')}`,
      };
    }

    if (st.size > 2 * 1024 * 1024) {
      return {
        ok: true,
        tooLarge: true,
        size: st.size,
        relativePath: relPath,
        content: `[文件过大 (${(st.size / 1024 / 1024).toFixed(2)} MB)，为保证流畅度未加载全文]`,
      };
    }

    const buf = readFileSync(targetFile);
    let isBinary = false;
    const checkLen = Math.min(buf.length, 512);
    for (let i = 0; i < checkLen; i++) {
      if (buf[i] === 0) {
        isBinary = true;
        break;
      }
    }

    if (isBinary) {
      return {
        ok: true,
        isBinary: true,
        size: st.size,
        relativePath: relPath,
        content: '[二进制文件，无法直接显示文本]',
      };
    }

    const content = buf.toString('utf8');
    const lines = content.length === 0 ? 0 : content.split('\n').length;

    return {
      ok: true,
      size: st.size,
      lines,
      relativePath: relPath,
      content,
      ...(ext === '.svg' ? { isSvg: true, dataUrl: `data:image/svg+xml;base64,${buf.toString('base64')}` } : {}),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

app.api('/api/files/reveal', async (data) => {
  try {
    const wsDir = resolveWorkspaceDir(data?.workspaceUri);
    const relPath = data?.relativePath || '';
    const target = resolveSafePath(wsDir, relPath);
    if (!existsSync(target)) return { ok: false, error: 'Path not found' };

    if (process.platform === 'win32') {
      const isDir = statSync(target).isDirectory();
      if (isDir) {
        execFile('explorer.exe', [target], () => {});
      } else {
        execFile('explorer.exe', ['/select,', target], () => {});
      }
    } else if (process.platform === 'darwin') {
      execFile('open', ['-R', target], () => {});
    } else {
      execFile('xdg-open', [statSync(target).isDirectory() ? target : dirname(target)], () => {});
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

app.api('/api/files/create', async (data) => {
  try {
    const wsDir = resolveWorkspaceDir(data?.workspaceUri);
    const parentPath = data?.parentPath || '';
    const name = data?.name?.trim();
    const type = data?.type || 'file';

    const nameErr = validateEntryName(name, true);
    if (nameErr) return { ok: false, error: nameErr };

    const targetDir = resolveSafePath(wsDir, parentPath);
    if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
      return { ok: false, error: '目标父目录不存在' };
    }

    const target = resolveSafePath(wsDir, join(parentPath, name));
    if (existsSync(target)) {
      return { ok: false, error: '同名文件或目录已存在' };
    }

    if (type === 'directory') {
      mkdirSync(target, { recursive: true });
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, '', 'utf8');
    }
    notifyWorkspaceChange(wsDir, { tree: true, git: true });
    return { ok: true, relativePath: toPosix(relative(wsDir, target)) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

app.api('/api/files/rename', async (data) => {
  try {
    const wsDir = resolveWorkspaceDir(data?.workspaceUri);
    const oldRel = data?.oldRelPath;
    const newName = data?.newName?.trim();
    if (!oldRel || !newName) return { ok: false, error: '参数缺失' };

    const nameErr = validateEntryName(newName, false);
    if (nameErr) return { ok: false, error: nameErr };

    const oldTarget = resolveSafePath(wsDir, oldRel);
    if (!existsSync(oldTarget)) return { ok: false, error: '源文件或目录不存在' };

    const parentRel = dirname(oldRel);
    const newRelCandidate = parentRel === '.' ? newName : join(parentRel, newName);
    const newTarget = resolveSafePath(wsDir, newRelCandidate);
    if (oldTarget.toLowerCase() !== newTarget.toLowerCase() && existsSync(newTarget)) {
      return { ok: false, error: '目标名称已存在' };
    }

    renameSync(oldTarget, newTarget);
    notifyWorkspaceChange(wsDir, { tree: true, git: true });
    return { ok: true, newRelPath: toPosix(relative(wsDir, newTarget)) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

app.api('/api/files/delete', async (data) => {
  try {
    const wsDir = resolveWorkspaceDir(data?.workspaceUri);
    const relPath = data?.relativePath;
    if (!relPath) return { ok: false, error: 'relativePath is required' };

    const target = resolveSafePath(wsDir, relPath);
    if (target === resolve(wsDir)) {
      return { ok: false, error: '不能删除工作区根目录' };
    }
    if (!existsSync(target)) return { ok: false, error: '文件或目录不存在' };

    if (statSync(target).isDirectory()) {
      rmSync(target, { recursive: true, force: true });
    } else {
      unlinkSync(target);
    }
    notifyWorkspaceChange(wsDir, { tree: true, git: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

app.api('/api/git/ignore', async (data) => {
  try {
    const wsDir = resolveWorkspaceDir(data?.workspaceUri);
    const relPath = data?.relativePath;
    if (!relPath) return { ok: false, error: 'relativePath is required' };

    const gitignorePath = resolveSafePath(wsDir, '.gitignore');
    const entry = toPosix(relPath).replace(/^\/+/, '');

    let existing = '';
    if (existsSync(gitignorePath)) {
      existing = readFileSync(gitignorePath, 'utf8');
      const lines = existing.split(/\r?\n/).map((l) => l.trim());
      if (lines.includes(entry)) {
        return { ok: true, alreadyExists: true };
      }
    }

    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    writeFileSync(gitignorePath, `${existing}${prefix}${entry}\n`, 'utf8');
    notifyWorkspaceChange(wsDir, { tree: true, git: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------------------------------------------------------------------------
// Git APIs
// ---------------------------------------------------------------------------
app.api('/api/git/init', async (data) => {
  const wsDir = resolveWorkspaceDir(data?.workspaceUri);
  const res = await runGit(['init'], wsDir);
  return { ok: res.ok, message: res.stdout || res.stderr, error: res.ok ? undefined : res.stderr || res.stdout };
});

async function getRepoState(wsDir) {
  try {
    const gitDirRes = await runGit(['rev-parse', '--git-dir'], wsDir);
    if (!gitDirRes.ok) return { isRebasing: false, isMerging: false, isCherryPicking: false, isInProgress: false };
    const gitDir = resolve(wsDir, gitDirRes.stdout.trim());
    const isRebasing = existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'));
    const isMerging = existsSync(join(gitDir, 'MERGE_HEAD'));
    const isCherryPicking = existsSync(join(gitDir, 'CHERRY_PICK_HEAD'));
    return {
      isRebasing,
      isMerging,
      isCherryPicking,
      isInProgress: isRebasing || isMerging || isCherryPicking,
    };
  } catch {
    return { isRebasing: false, isMerging: false, isCherryPicking: false, isInProgress: false };
  }
}

app.api('/api/git/info', async (data) => {
  const wsDir = resolveWorkspaceDir(data?.workspaceUri);
  const isInside = await runGit(['rev-parse', '--is-inside-work-tree'], wsDir);
  if (!isInside.ok || isInside.stdout.trim() !== 'true') {
    return { ok: true, isGit: false, workspace: wsDir, startedAt: getAssetVersion() };
  }

  const [branchRes, topLevelRes, upstreamRes, stashRes, remoteRes, repoState] = await Promise.all([
    runGit(['branch', '--show-current'], wsDir),
    runGit(['rev-parse', '--show-toplevel'], wsDir),
    runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], wsDir),
    runGit(['stash', 'list'], wsDir),
    runGit(['remote', 'get-url', 'origin'], wsDir),
    getRepoState(wsDir),
  ]);

  let branch = branchRes.stdout.trim();
  let detached = false;
  if (!branch) {
    const headRes = await runGit(['rev-parse', '--short', 'HEAD'], wsDir);
    if (headRes.ok) {
      branch = `HEAD (${headRes.stdout.trim()})`;
      detached = true;
    } else {
      branch = 'HEAD (无提交)';
    }
  }

  const upstream = upstreamRes.ok ? upstreamRes.stdout.trim() : '';
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const abRes = await runGit(['rev-list', '--left-right', '--count', `HEAD...${upstream}`], wsDir);
    if (abRes.ok) {
      const parts = abRes.stdout.trim().split(/\s+/);
      ahead = parseInt(parts[0], 10) || 0;
      behind = parseInt(parts[1], 10) || 0;
    }
  }

  const stashLines = stashRes.ok ? stashRes.stdout.split('\n').filter((l) => l.trim()) : [];

  return {
    ok: true,
    startedAt: getAssetVersion(),
    isGit: true,
    branch,
    detached,
    upstream,
    ahead,
    behind,
    stashCount: stashLines.length,
    remoteUrl: remoteRes.ok ? remoteRes.stdout.trim() : '',
    gitRoot: topLevelRes.stdout.trim(),
    workspace: wsDir,
    repoState,
  };
});

app.api('/api/git/branches', async (data) => {
  const wsDir = resolveWorkspaceDir(data?.workspaceUri);
  const fmt =
    '%(HEAD)%00%(refname)%00%(refname:short)%00%(objectname)%00%(objectname:short)%00%(upstream:short)%00%(upstream:track)%00%(committerdate:relative)%00%(committerdate:iso)%00%(authorname)%00%(subject)';

  const [refRes, remoteRes, repoState] = await Promise.all([
    runGit(['for-each-ref', '--sort=-committerdate', `--format=${fmt}`, 'refs/heads', 'refs/remotes'], wsDir),
    runGit(['remote'], wsDir),
    getRepoState(wsDir),
  ]);

  if (!refRes.ok) {
    const fallback = await runGit(['branch', '--list', '--sort=-committerdate'], wsDir);
    if (!fallback.ok) {
      return { ok: false, error: fallback.stderr || 'Failed to list branches', repoState };
    }
    const lines = fallback.stdout.split('\n');
    let current = '';
    const branches = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (line.startsWith('*')) {
        const name = trimmed.slice(1).trim();
        current = name;
        branches.push({ name, isCurrent: true, isRemote: false });
      } else {
        branches.push({ name: trimmed, isCurrent: false, isRemote: false });
      }
    }
    return { ok: true, current, branches, localBranches: branches, remoteBranches: [], remotes: [], repoState };
  }

  const remotes = remoteRes.ok ? remoteRes.stdout.split('\n').map((r) => r.trim()).filter(Boolean) : [];
  const lines = refRes.stdout.split('\n');
  let current = '';
  const branches = [];
  const localBranches = [];
  const remoteBranches = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split('\x00');
    if (parts.length < 11) continue;

    const [
      headMarker,
      refname,
      shortName,
      hash,
      shortHash,
      upstream,
      track,
      relativeDate,
      isoDate,
      author,
      subject,
    ] = parts;

    if (refname.endsWith('/HEAD') || shortName.endsWith('/HEAD')) {
      continue;
    }

    const isCurrent = headMarker.trim() === '*';
    if (isCurrent) {
      current = shortName;
    }

    const isRemote = refname.startsWith('refs/remotes/');

    let ahead = 0;
    let behind = 0;
    let gone = false;
    if (track) {
      const aheadMatch = track.match(/ahead\s+(\d+)/);
      if (aheadMatch) ahead = parseInt(aheadMatch[1], 10);
      const behindMatch = track.match(/behind\s+(\d+)/);
      if (behindMatch) behind = parseInt(behindMatch[1], 10);
      if (track.includes('gone')) gone = true;
    }

    let remoteName = '';
    let branchName = shortName;
    if (isRemote) {
      const matchedRemote = remotes.find((r) => shortName.startsWith(r + '/'));
      if (matchedRemote) {
        remoteName = matchedRemote;
        branchName = shortName.slice(matchedRemote.length + 1);
      } else {
        const slashIdx = shortName.indexOf('/');
        if (slashIdx !== -1) {
          remoteName = shortName.slice(0, slashIdx);
          branchName = shortName.slice(slashIdx + 1);
        } else {
          remoteName = remotes[0] || 'origin';
        }
      }
    }

    const branchObj = {
      name: shortName,
      refname,
      isCurrent,
      isRemote,
      remoteName,
      branchName,
      upstream: upstream || '',
      ahead,
      behind,
      gone,
      lastCommit: {
        hash,
        shortHash,
        relativeDate,
        isoDate,
        author,
        subject,
      },
    };

    branches.push(branchObj);
    if (isRemote) {
      remoteBranches.push(branchObj);
    } else {
      localBranches.push(branchObj);
    }
  }

  if (!current) {
    const curRes = await runGit(['branch', '--show-current'], wsDir);
    current = curRes.stdout.trim() || 'HEAD';
  }

  return {
    ok: true,
    current,
    branches,
    localBranches,
    remoteBranches,
    remotes,
    repoState,
  };
});

app.api('/api/git/checkout', async (data) => {
  const wsDir = resolveWorkspaceDir(data?.workspaceUri);
  const branch = data?.branch?.trim();
  if (!branch) return { ok: false, error: 'Branch name is required' };

  const checkLocalDirect = await runGit(['show-ref', '--verify', `refs/heads/${branch}`], wsDir);
  if (checkLocalDirect.ok && !data?.isRemote) {
    const res = await runGit(['checkout', branch], wsDir);
    if (!res.ok) return { ok: false, error: res.stderr || res.stdout || 'Checkout failed' };
    return { ok: true, message: res.stdout || res.stderr };
  }

  const remotesRes = await runGit(['remote'], wsDir);
  const remotes = remotesRes.ok ? remotesRes.stdout.split('\n').map((r) => r.trim()).filter(Boolean) : ['origin'];
  const matchingRemote = remotes.find((r) => branch === r || branch.startsWith(r + '/'));

  if (data?.isRemote || branch.startsWith('refs/remotes/') || matchingRemote) {
    const cleanRef = branch.replace(/^refs\/remotes\//, '');
    const remoteName = matchingRemote || 'origin';
    let localName = cleanRef;
    if (matchingRemote && cleanRef.startsWith(matchingRemote + '/')) {
      localName = cleanRef.slice(matchingRemote.length + 1);
    }

    const checkLocal = await runGit(['show-ref', '--verify', `refs/heads/${localName}`], wsDir);
    if (checkLocal.ok) {
      const res = await runGit(['checkout', localName], wsDir);
      if (!res.ok) return { ok: false, error: res.stderr || res.stdout || 'Checkout failed' };
      return { ok: true, message: res.stdout || res.stderr };
    }

    const trackTarget = matchingRemote ? cleanRef : `${remoteName}/${cleanRef}`;
    const res = await runGit(['checkout', '--track', trackTarget], wsDir);
    if (!res.ok) {
      const res2 = await runGit(['checkout', '-b', localName, trackTarget], wsDir);
      if (!res2.ok) return { ok: false, error: res2.stderr || res2.stdout || res.stderr || 'Checkout failed' };
      return { ok: true, message: res2.stdout || res2.stderr };
    }
    return { ok: true, message: res.stdout || res.stderr };
  }

  const res = await runGit(['checkout', branch], wsDir);
  if (!res.ok) {
    return { ok: false, error: res.stderr || res.stdout || 'Checkout failed' };
  }
  return { ok: true, message: res.stdout || res.stderr };
});

app.api('/api/git/branch-create', async (data) => {
  const wsDir = resolveWorkspaceDir(data?.workspaceUri);
  const name = data?.name?.trim();
  const startPoint = data?.startPoint?.trim();
  const checkout = data?.checkout !== false;

  if (!name) return { ok: false, error: '分支名称不能为空' };

  const args = checkout ? ['checkout', '-b', name] : ['branch', name];
  if (startPoint) {
    args.push(startPoint);
  }

  const res = await runGit(args, wsDir);
  if (!res.ok) {
    return { ok: false, error: res.stderr || res.stdout || '创建分支失败' };
  }
  return { ok: true, branch: name, message: res.stdout || res.stderr };
});

app.api('/api/git/branch-rename', async (data) => {
  const wsDir = resolveWorkspaceDir(data?.workspaceUri);
  let oldName = data?.oldName?.trim();
  const newName = data?.newName?.trim();

  if (!newName) return { ok: false, error: '新分支名不能为空' };
  if (!oldName) {
    const curRes = await runGit(['branch', '--show-current'], wsDir);
    oldName = curRes.stdout.trim();
  }
  if (!oldName) return { ok: false, error: '未能确定待重命名的原分支' };

  const res = await runGit(['branch', '-m', oldName, newName], wsDir);
  if (!res.ok) {
    return { ok: false, error: res.stderr || res.stdout || '重命名分支失败' };
  }
  return { ok: true, message: res.stdout || res.stderr || '重命名分支成功' };
});

app.api('/api/git/branch-delete', async (data) => {
  const wsDir = resolveWorkspaceDir(data?.workspaceUri);
  const name = data?.name?.trim();
  const force = !!data?.force;
  const isRemote = !!data?.isRemote;

  if (!name) return { ok: false, error: '分支名称不能为空' };

  if (isRemote) {
    const remotesRes = await runGit(['remote'], wsDir);
    const remotes = remotesRes.ok ? remotesRes.stdout.split('\n').map((r) => r.trim()).filter(Boolean) : ['origin'];

    const cleanName = name.replace(/^refs\/remotes\//, '');
    const remote = remotes.find((r) => cleanName === r || cleanName.startsWith(r + '/')) || remotes[0] || 'origin';
    let branchName = cleanName;
    if (cleanName.startsWith(remote + '/')) {
      branchName = cleanName.slice(remote.length + 1);
    }

    const res = await runGit(['push', remote, '--delete', branchName], wsDir, 60000);
    if (!res.ok) {
      return { ok: false, error: res.stderr || res.stdout || '删除远程分支失败' };
    }
    await runGit(['branch', '-r', '-d', `${remote}/${branchName}`], wsDir);
    return { ok: true, message: res.stdout || res.stderr || `已删除远程分支 ${remote}/${branchName}` };
  }

  const curRes = await runGit(['branch', '--show-current'], wsDir);
  if (curRes.stdout.trim() === name) {
    return { ok: false, error: `无法删除当前处于检出状态的分支 "${name}"，请先切换到其他分支。` };
  }

  const res = await runGit(['branch', force ? '-D' : '-d', name], wsDir);
  if (!res.ok) {
    return { ok: false, error: res.stderr || res.stdout || '删除分支失败' };
  }
  return { ok: true, message: res.stdout || res.stderr };
});

app.api('/api/git/branch-merge', async (data) => {
  const wsDir = resolveWorkspaceDir(data?.workspaceUri);
  const branch = data?.branch?.trim();
  const noFf = !!data?.noFf;
  const message = data?.message?.trim();

  if (!branch) return { ok: false, error: '合并源分支不能为空' };

  const args = ['merge'];
  if (noFf) args.push('--no-ff');
  if (message) args.push('-m', message);
  args.push(branch);

  const res = await runGit(args, wsDir);
  const output = (res.stdout || '') + '\n' + (res.stderr || '');
  if (!res.ok) {
    const hasConflict = output.includes('CONFLICT') || output.includes('Automatic merge failed');
    return {
      ok: false,
      conflict: hasConflict,
      error: res.stderr || res.stdout || '合并失败',
      output,
    };
  }
  return { ok: true, output: res.stdout || res.stderr || '合并完成' };
});

app.api('/api/git/merge-abort', async (data) => {
  const wsDir = resolveWorkspaceDir(data?.workspaceUri);
  const res = await runGit(['merge', '--abort'], wsDir);
  if (!res.ok) {
    return { ok: false, error: res.stderr || res.stdout || '中止合并失败' };
  }
  return { ok: true, output: res.stdout || res.stderr || '已中止合并并恢复原分支状态' };
});

app.api('/api/git/branch-rebase', async (data) => {
  const wsDir = resolveWorkspaceDir(data?.workspaceUri);
  const upstream = data?.upstream?.trim();
  const autostash = data?.autostash !== false;

  if (!upstream) return { ok: false, error: '变基基准分支 (Upstream) 不能为空' };

  const args = ['rebase'];
  if (autostash) args.push('--autostash');
  args.push(upstream);

  const res = await runGit(args, wsDir);
  const output = (res.stdout || '') + '\n' + (res.stderr || '');
  if (!res.ok) {
    const hasConflict =
      output.includes('CONFLICT') || output.includes('could not apply') || output.includes('Resolve all conflicts');
    return {
      ok: false,
      conflict: hasConflict,
      error: res.stderr || res.stdout || '变基失败',
      output,
    };
  }
  return { ok: true, output: res.stdout || res.stderr || '变基完成' };
});

app.api('/api/git/rebase-abort', async (data) => {
  const wsDir = resolveWorkspaceDir(data?.workspaceUri);
  const res = await runGit(['rebase', '--abort'], wsDir);
  if (!res.ok) {
    return { ok: false, error: res.stderr || res.stdout || '中止变基失败' };
  }
  return { ok: true, output: res.stdout || res.stderr || '已中止变基并恢复原状态' };
});

app.api('/api/git/rebase-continue', async (data) => {
  const wsDir = resolveWorkspaceDir(data?.workspaceUri);
  const res = await runGit(['-c', 'core.editor=true', 'rebase', '--continue'], wsDir);
  const output = (res.stdout || '') + '\n' + (res.stderr || '');
  if (!res.ok) {
    const hasConflict =
      output.includes('CONFLICT') || output.includes('could not apply') || output.includes('Resolve all conflicts');
    return {
      ok: false,
      conflict: hasConflict,
      error: res.stderr || res.stdout || '继续变基失败，请确保所有冲突已解决并暂存',
      output,
    };
  }
  return { ok: true, output: res.stdout || res.stderr || '变基继续执行成功' };
});

app.api('/api/git/rebase-skip', async (data) => {
  const wsDir = resolveWorkspaceDir(data?.workspaceUri);
  const res = await runGit(['rebase', '--skip'], wsDir);
  const output = (res.stdout || '') + '\n' + (res.stderr || '');
  if (!res.ok) {
    return { ok: false, error: res.stderr || res.stdout || '跳过提交失败', output };
  }
  return { ok: true, output: res.stdout || res.stderr || '已跳过当前提交并继续变基' };
});

app.api('/api/git/cherry-pick', async (data) => {
  const wsDir = resolveWorkspaceDir(data?.workspaceUri);
  const hash = data?.commitHash?.trim();
  const action = data?.action || 'pick';

  if (action === 'abort') {
    const res = await runGit(['cherry-pick', '--abort'], wsDir);
    return { ok: res.ok, error: res.ok ? undefined : res.stderr || res.stdout };
  }
  if (action === 'continue') {
    const res = await runGit(['-c', 'core.editor=true', 'cherry-pick', '--continue'], wsDir);
    return { ok: res.ok, error: res.ok ? undefined : res.stderr || res.stdout };
  }

  if (!hash) return { ok: false, error: 'Commit hash is required' };
  const res = await runGit(['cherry-pick', hash], wsDir);
  const output = (res.stdout || '') + '\n' + (res.stderr || '');
  if (!res.ok) {
    const conflict = output.includes('CONFLICT') || output.includes('could not apply');
    return { ok: false, conflict, error: res.stderr || res.stdout || 'Cherry-pick 失败' };
  }
  return { ok: true, output: res.stdout || res.stderr || 'Cherry-pick 成功' };
});

app.api('/api/git/branch-pull', async (data) => {
  const wsDir = resolveWorkspaceDir(data?.workspaceUri);
  const branch = data?.branch?.trim();
  const remote = data?.remote?.trim();
  const rebase = !!data?.rebase;

  const args = ['pull'];
  if (rebase) args.push('--rebase');
  if (remote && branch) {
    args.push(remote, branch);
  } else if (branch) {
    args.push('origin', branch);
  }

  const res = await runGit(args, wsDir, 60000);
  const output = (res.stdout || '') + '\n' + (res.stderr || '');
  if (!res.ok) {
    const hasConflict = output.includes('CONFLICT') || output.includes('could not apply');
    return {
      ok: false,
      conflict: hasConflict,
      error: res.stderr || res.stdout || '拉取失败',
      output,
    };
  }
  return { ok: true, output: res.stdout || res.stderr || '拉取完成' };
});

app.api('/api/git/branch-diff', async (data) => {
  const wsDir = resolveWorkspaceDir(data?.workspaceUri);
  const target = data?.targetBranch?.trim();
  let base = data?.baseBranch?.trim();

  if (!target) return { ok: false, error: '目标分支不能为空' };

  if (!base) {
    const curRes = await runGit(['branch', '--show-current'], wsDir);
    base = curRes.stdout.trim() || 'HEAD';
  }

  let [diffRes, aheadLogRes, behindLogRes] = await Promise.all([
    runGit(['diff', `${base}...${target}`], wsDir),
    runGit(['log', '--pretty=format:%H%00%h%00%an%00%ar%00%s', `${base}..${target}`], wsDir),
    runGit(['log', '--pretty=format:%H%00%h%00%an%00%ar%00%s', `${target}..${base}`], wsDir),
  ]);

  if (!diffRes.ok) {
    diffRes = await runGit(['diff', `${base}..${target}`], wsDir);
  }

  const parseCommits = (raw) => {
    if (!raw) return [];
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, shortHash, author, relativeDate, subject] = line.split('\x00');
        return { hash, shortHash, author, relativeDate, subject };
      });
  };

  const commitsTargetNotBase = aheadLogRes.ok ? parseCommits(aheadLogRes.stdout) : [];
  const commitsBaseNotTarget = behindLogRes.ok ? parseCommits(behindLogRes.stdout) : [];

  return {
    ok: true,
    base,
    target,
    diff: diffRes.ok ? diffRes.stdout : '',
    error: diffRes.ok ? undefined : diffRes.stderr,
    commitsTargetNotBase,
    commitsBaseNotTarget,
    aheadCount: commitsTargetNotBase.length,
    behindCount: commitsBaseNotTarget.length,
  };
});

app.api('/api/git/branch-push', async (data) => {
  const wsDir = resolveWorkspaceDir(data?.workspaceUri);
  const branch = data?.branch?.trim();
  const setUpstream = data?.setUpstream !== false;
  const force = !!data?.force;

  let remote = data?.remote?.trim();
  if (!remote) {
    const remotesRes = await runGit(['remote'], wsDir);
    const remotes = remotesRes.ok ? remotesRes.stdout.split('\n').map((r) => r.trim()).filter(Boolean) : [];
    remote = remotes.includes('origin') ? 'origin' : remotes[0] || 'origin';
  }

  let targetBranch = branch;
  if (!targetBranch) {
    const branchRes = await runGit(['branch', '--show-current'], wsDir);
    targetBranch = branchRes.stdout.trim();
  }

  if (!targetBranch) return { ok: false, error: '未找到要推送的分支' };

  const args = ['push'];
  if (setUpstream) args.push('-u');
  if (force) args.push('--force-with-lease');
  args.push(remote, targetBranch);

  const res = await runGit(args, wsDir, 60000);
  if (!res.ok) {
    return { ok: false, error: res.stderr || res.stdout || '推送分支失败' };
  }
  return { ok: true, output: res.stdout || res.stderr || '推送成功' };
});

function parseNumStat(stdout) {
  const map = new Map();
  if (!stdout) return map;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length >= 3) {
      const add = parts[0] === '-' ? null : parseInt(parts[0], 10) || 0;
      const del = parts[1] === '-' ? null : parseInt(parts[1], 10) || 0;
      let p = unquoteGitPath(parts.slice(2).join('\t'));
      // Handle rename notation in numstat: "dir/{old => new}" or "old => new"
      if (p.includes(' => ')) {
        p = p.replace(/\{[^}]* => ([^}]*)\}/g, '$1');
        if (p.includes(' => ')) {
          p = p.split(' => ').pop().trim();
        }
      }
      map.set(p, { additions: add, deletions: del });
    }
  }
  return map;
}

const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

app.api('/api/git/status', async (data) => {
  const wsDir = resolveWorkspaceDir(data?.workspaceUri);
  const [statusRes, unstagedStatRes, stagedStatRes, repoState] = await Promise.all([
    runGit(['status', '--porcelain=v1', '-uall'], wsDir),
    runGit(['diff', '--numstat'], wsDir),
    runGit(['diff', '--cached', '--numstat'], wsDir),
    getRepoState(wsDir),
  ]);

  if (!statusRes.ok) {
    return { ok: false, error: statusRes.stderr || 'Git status failed', repoState };
  }

  const unstagedStats = parseNumStat(unstagedStatRes.stdout);
  const stagedStats = parseNumStat(stagedStatRes.stdout);

  const conflicts = [];
  const staged = [];
  const unstaged = [];
  const untracked = [];

  const lines = statusRes.stdout.split('\n');
  for (const line of lines) {
    if (line.length < 4) continue;
    const indexStatus = line[0];
    const workTreeStatus = line[1];
    const xy = indexStatus + workTreeStatus;
    let filePath = line.slice(3).replace(/\r$/, '');

    if (filePath.includes(' -> ')) {
      filePath = filePath.split(' -> ').pop();
    }
    filePath = unquoteGitPath(filePath);

    if (CONFLICT_CODES.has(xy)) {
      conflicts.push({ path: filePath, status: 'C', code: xy, additions: null, deletions: null });
      continue;
    }

    if (indexStatus === '?' && workTreeStatus === '?') {
      untracked.push({ path: filePath, status: 'U', additions: null, deletions: null });
      continue;
    }

    if (indexStatus !== ' ' && indexStatus !== '?') {
      const st = stagedStats.get(filePath) || { additions: null, deletions: null };
      staged.push({ path: filePath, status: indexStatus, ...st });
    }

    if (workTreeStatus !== ' ' && workTreeStatus !== '?') {
      const st = unstagedStats.get(filePath) || { additions: null, deletions: null };
      unstaged.push({ path: filePath, status: workTreeStatus, ...st });
    }
  }

  return {
    ok: true,
    conflicts,
    staged,
    unstaged,
    untracked,
    totalChanges: conflicts.length + staged.length + unstaged.length + untracked.length,
    repoState,
  };
});

app.api('/api/git/commit', async (data) => {
  const wsDir = resolveWorkspaceDir(data?.workspaceUri);
  const message = data?.message?.trim();
  const amend = !!data?.amend;
  const stageAll = !!data?.stageAll;

  if (!message) {
    return { ok: false, error: '请输入提交说明 (Commit Message)' };
  }

  if (stageAll) {
    const addRes = await runGit(['add', '-A'], wsDir);
    if (!addRes.ok) {
      return { ok: false, error: addRes.stderr || '自动暂存失败' };
    }
  }

  const args = ['commit', '-m', message];
  if (amend) args.push('--amend');

  const res = await runGit(args, wsDir);
  if (!res.ok) {
    return { ok: false, error: res.stderr || res.stdout || '提交失败' };
  }
  return { ok: true, output: res.stdout || res.stderr };
});

app.api('/api/git/fetch', async (data) => {
  const wsDir = resolveWorkspaceDir(data?.workspaceUri);
  const res = await runGit(['fetch', '--all', '--prune'], wsDir, 60000);
  if (!res.ok) {
    return { ok: false, error: res.stderr || res.stdout || 'Fetch 失败' };
  }
  return { ok: true, output: res.stdout || res.stderr || '已同步远端引用' };
});

app.api('/api/git/pull', async (data) => {
  const wsDir = resolveWorkspaceDir(data?.workspaceUri);
  const res = await runGit(['pull'], wsDir, 60000);
  if (!res.ok) {
    return { ok: false, error: res.stderr || res.stdout || 'Pull 失败' };
  }
  return { ok: true, output: res.stdout || res.stderr };
});

app.api('/api/git/push', async (data) => {
  const wsDir = resolveWorkspaceDir(data?.workspaceUri);
  let res = await runGit(['push'], wsDir, 60000);
  if (!res.ok && (res.stderr.includes('no upstream branch') || res.stderr.includes('set-upstream'))) {
    const branchRes = await runGit(['branch', '--show-current'], wsDir);
    const branch = branchRes.stdout.trim();
    if (branch) {
      const remotesRes = await runGit(['remote'], wsDir);
      const remotes = remotesRes.ok ? remotesRes.stdout.split('\n').map((r) => r.trim()).filter(Boolean) : [];
      const remote = remotes.includes('origin') ? 'origin' : remotes[0] || 'origin';
      res = await runGit(['push', '-u', remote, branch], wsDir, 60000);
    }
  }
  if (!res.ok) {
    return { ok: false, error: res.stderr || res.stdout || 'Push 失败' };
  }
  return { ok: true, output: res.stdout || res.stderr || '推送成功' };
});

app.api('/api/git/stash', async (data) => {
  const wsDir = resolveWorkspaceDir(data?.workspaceUri);
  const action = data?.action || 'list';

  if (action === 'push') {
    const msg = data?.message?.trim() || `WIP on ${new Date().toLocaleTimeString()}`;
    const res = await runGit(['stash', 'push', '-u', '-m', msg], wsDir);
    if (!res.ok) return { ok: false, error: res.stderr || res.stdout };
    return { ok: true, output: res.stdout || res.stderr };
  }

  if (action === 'apply') {
    const args = ['stash', 'apply'];
    if (data?.ref) args.push(data.ref);
    const res = await runGit(args, wsDir);
    if (!res.ok) return { ok: false, error: res.stderr || res.stdout };
    return { ok: true, output: res.stdout || res.stderr };
  }

  if (action === 'pop') {
    const args = ['stash', 'pop'];
    if (data?.ref) args.push(data.ref);
    const res = await runGit(args, wsDir);
    if (!res.ok) return { ok: false, error: res.stderr || res.stdout };
    return { ok: true, output: res.stdout || res.stderr };
  }

  if (action === 'drop') {
    const args = ['stash', 'drop'];
    if (data?.ref) args.push(data.ref);
    const res = await runGit(args, wsDir);
    if (!res.ok) return { ok: false, error: res.stderr || res.stdout };
    return { ok: true, output: res.stdout || res.stderr };
  }

  // list
  const res = await runGit(['stash', 'list', '--pretty=format:%gd%x00%ar%x00%gs'], wsDir);
  if (!res.ok) return { ok: false, error: res.stderr };
  const stashes = [];
  for (const line of res.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [ref, date, subject] = line.split('\x00');
    stashes.push({ ref, date, subject });
  }
  return { ok: true, stashes };
});

app.api('/api/git/discard-all', async (data) => {
  const wsDir = resolveWorkspaceDir(data?.workspaceUri);
  const [coRes, cleanRes] = await Promise.all([
    runGit(['checkout', '--', '.'], wsDir),
    runGit(['clean', '-fd'], wsDir),
  ]);
  if (!coRes.ok && !cleanRes.ok) {
    return { ok: false, error: coRes.stderr || cleanRes.stderr || '放弃更改失败' };
  }
  return { ok: true };
});

app.api('/api/git/diff', async (data) => {
  const wsDir = resolveWorkspaceDir(data?.workspaceUri);
  const relPath = data?.relativePath;
  const isStaged = !!data?.staged;
  const commitHash = data?.commitHash;

  if (commitHash) {
    const args = ['show', commitHash];
    if (relPath) {
      args.push('--', relPath);
    }
    const res = await runGit(args, wsDir);
    return { ok: res.ok, diff: res.stdout, error: res.stderr };
  }

  if (isStaged) {
    const args = ['diff', '--cached'];
    if (relPath) args.push('--', relPath);
    const res = await runGit(args, wsDir);
    return { ok: res.ok, diff: res.stdout, error: res.stderr };
  }

  if (relPath) {
    const statusRes = await runGit(['status', '--porcelain=v1', '--', relPath], wsDir);
    if (statusRes.stdout.startsWith('??')) {
      const targetFile = resolveSafePath(wsDir, relPath);
      try {
        const st = statSync(targetFile);
        if (st.size > 1024 * 1024) {
          return {
            ok: true,
            diff: `diff --git a/${relPath} b/${relPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1,1 @@\n+[新文件过大 (${(st.size / 1024 / 1024).toFixed(2)} MB)，未展开全文 Diff]`,
            isUntracked: true,
          };
        }
        const buf = readFileSync(targetFile);
        const checkLen = Math.min(buf.length, 512);
        for (let i = 0; i < checkLen; i++) {
          if (buf[i] === 0) {
            return {
              ok: true,
              diff: `diff --git a/${relPath} b/${relPath}\nnew file mode 100644\nBinary files /dev/null and b/${relPath} differ`,
              isUntracked: true,
            };
          }
        }
        const content = buf.toString('utf8');
        const contentLines = content.split('\n');
        const diffLines = [
          `diff --git a/${relPath} b/${relPath}`,
          'new file mode 100644',
          '--- /dev/null',
          `+++ b/${relPath}`,
          `@@ -0,0 +1,${contentLines.length} @@`,
          ...contentLines.map((l) => `+${l}`),
        ].join('\n');
        return { ok: true, diff: diffLines, isUntracked: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
  }

  const args = ['diff'];
  if (relPath) args.push('--', relPath);
  const res = await runGit(args, wsDir);
  return { ok: res.ok, diff: res.stdout, error: res.stderr };
});

app.api('/api/git/commits', async (data) => {
  const wsDir = resolveWorkspaceDir(data?.workspaceUri);
  const count = typeof data?.limit === 'number' ? Math.max(1, Math.min(data.limit, 200)) : 40;
  const skip = typeof data?.skip === 'number' && data.skip > 0 ? data.skip : 0;
  const search = data?.search?.trim() || '';
  const args = ['log', `-n`, `${count}`];
  if (skip > 0) {
    args.push(`--skip=${skip}`);
  }
  args.push('--pretty=format:%H%x00%h%x00%an%x00%ar%x00%ad%x00%s%x00%D');
  if (search) {
    args.push(`--grep=${search}`, '-i');
  }
  const res = await runGit(args, wsDir);

  if (!res.ok) {
    // Unborn repository (no commits yet) should return empty list cleanly
    if (res.stderr.includes('does not have any commits yet') || res.stderr.includes('your current branch')) {
      return { ok: true, commits: [], hasMore: false };
    }
    return { ok: false, error: res.stderr || 'Git log failed' };
  }

  const commits = [];
  const entries = res.stdout.split('\n');
  for (const entry of entries) {
    if (!entry.trim()) continue;
    const [hash, shortHash, author, relativeDate, fullDate, subject, refs] = entry.split('\x00');
    commits.push({
      hash,
      shortHash,
      author,
      relativeDate,
      fullDate,
      subject,
      refs: refs ? refs.split(',').map((r) => r.trim()).filter(Boolean) : [],
    });
  }

  return { ok: true, commits, hasMore: commits.length >= count };
});

app.api('/api/git/commit-detail', async (data) => {
  const wsDir = resolveWorkspaceDir(data?.workspaceUri);
  const commitHash = data?.commitHash;
  if (!commitHash) return { ok: false, error: 'Commit hash is required' };

  const [headerRes, filesRes] = await Promise.all([
    runGit(['show', '--quiet', '--pretty=format:%H%x00%an%x00%ae%x00%ar%x00%s%x00%b', commitHash], wsDir),
    runGit(['show', '--name-status', '--pretty=format:', commitHash], wsDir),
  ]);

  if (!headerRes.ok) {
    return { ok: false, error: headerRes.stderr || 'Failed to inspect commit' };
  }

  const [hash, author, email, date, subject, body] = headerRes.stdout.split('\x00');
  const files = [];
  for (const line of filesRes.stdout.split('\n')) {
    const trimmed = line.replace(/\r$/, '').trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t');
    if (parts.length >= 2) {
      const status = parts[0];
      // For renames (R100\told\tnew), take the new path
      const path = unquoteGitPath(parts.length >= 3 ? parts[2] : parts[1]);
      files.push({ status, path });
    }
  }

  return {
    ok: true,
    commit: {
      hash,
      author,
      email,
      date,
      subject,
      body: body?.trim(),
      files,
    },
  };
});

app.api('/api/git/stage', async (data) => {
  const wsDir = resolveWorkspaceDir(data?.workspaceUri);
  const relPath = data?.relativePath;
  const args = relPath && relPath !== '.' ? ['add', '--', relPath] : ['add', '-A'];
  const res = await runGit(args, wsDir);
  return { ok: res.ok, error: res.stderr || res.stdout };
});

app.api('/api/git/unstage', async (data) => {
  const wsDir = resolveWorkspaceDir(data?.workspaceUri);
  const relPath = data?.relativePath;
  const args = relPath && relPath !== '.' ? ['restore', '--staged', '--', relPath] : ['restore', '--staged', '.'];
  let res = await runGit(args, wsDir);
  // Fallback for unborn HEAD (initial commit before HEAD exists)
  if (!res.ok && (res.stderr.includes('could not resolve HEAD') || res.stderr.includes('not a valid object name'))) {
    const fallbackArgs = relPath && relPath !== '.' ? ['rm', '--cached', '--', relPath] : ['rm', '-r', '--cached', '.'];
    res = await runGit(fallbackArgs, wsDir);
  }
  return { ok: res.ok, error: res.stderr || res.stdout };
});

app.api('/api/git/discard', async (data) => {
  const wsDir = resolveWorkspaceDir(data?.workspaceUri);
  const relPath = data?.relativePath;
  const isUntracked = !!data?.untracked;
  if (!relPath) return { ok: false, error: 'relativePath is required' };

  if (isUntracked) {
    try {
      const full = resolveSafePath(wsDir, relPath);
      if (existsSync(full)) {
        if (statSync(full).isDirectory()) {
          rmSync(full, { recursive: true, force: true });
        } else {
          unlinkSync(full);
        }
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  const res = await runGit(['checkout', '--', relPath], wsDir);
  return { ok: res.ok, error: res.stderr || res.stdout };
});

// Run server
app.run();
