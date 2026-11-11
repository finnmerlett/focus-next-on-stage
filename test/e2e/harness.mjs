// Launches an isolated VS Code window on a fixture git repo and drives it.
// Clicks and keys go to the window's renderer over the Chrome DevTools Protocol (CDP), and
// extension-host code runs through the test bridge extension in ./bridge.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT = join(HERE, '..', '..');
const CODE = process.env.FLN_CODE_BIN ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const CODE_CLI = process.env.FLN_CODE_CLI ?? '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';

// VS Code puts an IPC socket in the user data dir and refuses paths over 103 characters,
// so the profile goes in a short directory rather than a deep scratch path.
const TMP_ROOT = process.env.FLN_TMP ?? '/tmp/claude-501/fln';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function waitFor(check, { timeout = 8000, interval = 25, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await check();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const BASE_SETTINGS = {
  'workbench.startupEditor': 'none',
  'security.workspace.trust.enabled': false,
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'extensions.autoUpdate': false,
  'extensions.autoCheckUpdates': false,
  'workbench.tips.enabled': false,
  'chat.disableAIFeatures': true,
  'git.autoRepositoryDetection': true,
  'git.openRepositoryInParentFolders': 'never',
  'workbench.editor.enablePreview': true,
  'window.restoreWindows': 'none',
};

/**
 * Creates a git repo with one commit, then applies `changes` on top.
 * `files` maps path → content for the first commit. `changes` maps path → content, or null to delete.
 */
export function createRepo(dir, { files, changes = {}, staged = [] }) {
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, stdio: 'pipe' }).toString();
  const write = (p, content) => {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), content);
  };
  mkdirSync(dir, { recursive: true });
  for (const [p, c] of Object.entries(files)) write(p, c);
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-qm', 'init');
  for (const [p, c] of Object.entries(changes)) {
    if (c === null) rmSync(join(dir, p));
    else write(p, c);
  }
  if (staged.length) git('add', '--', ...staged);
  return { git };
}

// Bounds of the macOS primary display (the one with the menu bar), in the top-left-origin
// coordinates Electron uses. A fresh profile would otherwise open on the display under the cursor.
function primaryDisplayBounds() {
  try {
    const out = execFileSync('osascript', ['-l', 'JavaScript', '-e',
      'ObjC.import("AppKit"); const s = $.NSScreen.screens.objectAtIndex(0); const f = s.frame, v = s.visibleFrame;' +
      'JSON.stringify({ w: f.size.width, h: f.size.height, top: f.size.height - v.size.height - v.origin.y })'], { stdio: 'pipe' }).toString();
    return JSON.parse(out);
  } catch {
    return { w: 1440, h: 900, top: 25 };
  }
}

// VS Code restores an extension development window from windowsState.lastPluginDevelopmentHostWindow.
function windowState() {
  const d = primaryDisplayBounds();
  const width = Math.min(1400, d.w - 40);
  const height = Math.min(900, d.h - d.top - 20);
  const uiState = { mode: 1, x: Math.round((d.w - width) / 2), y: Math.round(d.top + 10), width, height };
  return { windowsState: { lastPluginDevelopmentHostWindow: { uiState }, lastActiveWindow: { uiState } } };
}

/**
 * Launches VS Code on a fixture. Pass `repo` for one repository, opened as the workspace folder,
 * `repos` (name → spec) for a folder that holds several repositories, or `folder` to open an
 * existing repository as it is.
 */
export async function launch({ repo, repos, folder, settings = {}, keybindings = [], extensions = [], port, bridgePort }) {
  mkdirSync(TMP_ROOT, { recursive: true });
  const root = mkdtempSync(join(TMP_ROOT, 'vsc-'));
  const userData = join(root, 'ud');
  const extDir = join(root, 'ext');
  mkdirSync(join(userData, 'User', 'globalStorage'), { recursive: true });
  mkdirSync(extDir, { recursive: true });
  writeFileSync(join(userData, 'User', 'settings.json'), JSON.stringify({ ...BASE_SETTINGS, ...settings }, null, 2));
  writeFileSync(join(userData, 'User', 'keybindings.json'), JSON.stringify(keybindings, null, 2));
  writeFileSync(join(userData, 'User', 'globalStorage', 'storage.json'), JSON.stringify(windowState(), null, 2));

  let repoDir, openDir, repoDirs = {};
  if (folder) {
    // An existing repository, such as a snapshot of real work.
    repoDir = openDir = folder;
  } else if (repos) {
    openDir = join(root, 'ws');
    for (const [name, spec] of Object.entries(repos)) {
      repoDirs[name] = join(openDir, name);
      createRepo(repoDirs[name], spec);
    }
  } else {
    repoDir = openDir = join(root, 'repo');
    createRepo(repoDir, repo);
  }
  const repositoryCount = repos ? Object.keys(repos).length : 1;

  // FLN_VSIX installs a packaged build into the throwaway profile instead of loading the source folder.
  if (process.env.FLN_VSIX) {
    execFileSync(CODE_CLI, [`--user-data-dir=${userData}`, `--extensions-dir=${extDir}`, '--install-extension', process.env.FLN_VSIX], { stdio: 'pipe' });
    extensions = extensions.filter(p => p !== PROJECT);
  }
  // FLN_EXTRA_EXTENSIONS loads other extension folders too, for example an installed VSCodeVim, to
  // test alongside them. Paths are separated by the platform's path delimiter.
  const extra = (process.env.FLN_EXTRA_EXTENSIONS ?? '').split(delimiter).filter(Boolean);
  const devPaths = [join(HERE, 'bridge'), ...extensions, ...extra].map(p => `--extensionDevelopmentPath=${p}`);
  // A new window takes focus when it opens. Unless FLN_SHOW is set, the main process starts paused
  // (--inspect-brk) so the harness can tell it to hide the window as soon as VS Code creates it,
  // which leaves whatever app was in front where it was.
  const hidden = !process.env.FLN_SHOW;
  const mainInspectPort = port + 1000;
  const child = spawn(CODE, [
    `--user-data-dir=${userData}`, `--extensions-dir=${extDir}`, `--remote-debugging-port=${port}`,
    ...(hidden ? [`--inspect-brk=${mainInspectPort}`] : []),
    '--new-window', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
    // Debug logging for this extension, written under <user data>/logs.
    '--log=finnbuilds.focus-next-on-stage:debug',
    ...devPaths, openDir,
  ], { stdio: 'ignore', detached: true, env: { ...process.env, FLN_BRIDGE_PORT: String(bridgePort), FLN_TEST_IGNORE_WINDOW_FOCUS: '1' } });
  child.unref();
  // Close the window if the runner exits early, for example on a failed assertion.
  const kill = () => { try { process.kill(child.pid); } catch { /* already gone */ } };
  process.once('exit', kill);
  if (hidden) {
    await hideNewWindows(mainInspectPort);
  }

  const bridge = async body => {
    // Without a timeout, a command blocked behind a dialog waits for the default of 5 minutes.
    const res = await fetch(`http://127.0.0.1:${bridgePort}/`, { method: 'POST', body, signal: AbortSignal.timeout(60000) })
      .catch(err => { throw new Error(`${err.message}: ${body.slice(0, 120)}`); });
    const json = await res.json();
    if (json.error) throw new Error(json.error);
    return json.value;
  };

  await waitFor(async () => fetch(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false), { timeout: 30000, what: 'CDP endpoint' });
  const cdp = await waitFor(async () => connect(port).catch(() => null), { timeout: 30000, what: 'workbench page' });
  await waitFor(async () => bridge('return true').catch(() => false), { timeout: 30000, what: 'test bridge' });
  // Wait for the git extension to pick up the repository.
  await waitFor(() => bridge(`return git.repositories.length >= ${repositoryCount}`), { timeout: 30000, what: 'git repositories' });

  const isRunning = () => { try { process.kill(child.pid, 0); return true; } catch { return false; } };
  // Quit through VS Code so the window closes normally. Killing the process only if that fails.
  const close = async () => {
    bridge(`setTimeout(() => vscode.commands.executeCommand('workbench.action.quit'), 50); return true`).catch(() => {});
    await waitFor(() => !isRunning(), { timeout: 10000, what: 'VS Code to quit' }).catch(kill);
    cdp.close();
    process.removeListener('exit', kill);
    if (!process.env.FLN_KEEP) rmSync(root, { recursive: true, force: true });
  };
  return { cdp, bridge, repoDir, repoDirs, root, close, pid: child.pid };
}

// Runs in the VS Code main process before any of its own code. Electron's show() and focus() would
// bring the app to the front, so they become no-ops that don't. Each new window is minimized and
// the app hidden, which hands focus back to the app that had it. VS Code turns background
// throttling off, so the hidden page keeps running and rendering.
const HIDE_WINDOWS = mainScript => `(() => {
  const require = process.getBuiltinModule('module').createRequire(${JSON.stringify(mainScript)});
  const { app, BrowserWindow } = require('electron');
  app.focus = () => {};
  BrowserWindow.prototype.focus = function () {};
  BrowserWindow.prototype.show = function () { this.showInactive(); };
  app.on('browser-window-created', (_event, win) => { win.minimize(); setTimeout(() => app.hide(), 0); });
  return 'patched';
})()`;

async function hideNewWindows(inspectPort) {
  const target = await waitFor(async () => {
    try { return (await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json())[0]; } catch { return null; }
  }, { timeout: 30000, what: 'main process inspector' });
  const socket = await openSocket(target.webSocketDebuggerUrl);
  await socket.send('Runtime.enable');
  await socket.send('Debugger.enable');
  // --inspect-brk waits for this, then stops on the first line of the main script.
  await socket.send('Runtime.runIfWaitingForDebugger');
  await waitFor(() => socket.events.some(e => e.method === 'Debugger.paused'), { timeout: 10000, what: 'main process to pause' });
  const mainScript = join(dirname(CODE), '..', 'Resources', 'app', 'out', 'main.js');
  const result = await socket.send('Runtime.evaluate', { expression: HIDE_WINDOWS(mainScript), returnByValue: true });
  if (result.result?.value !== 'patched') {
    throw new Error(`Couldn't patch the main process: ${JSON.stringify(result)}`);
  }
  await socket.send('Debugger.disable');
  socket.close();
}

/** A CDP or Node inspector WebSocket with a request helper and a list of the events it got. */
async function openSocket(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WebSocket ${url} did not open`)), 5000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', err => { clearTimeout(timer); reject(err); }, { once: true });
  });
  const events = [];
  ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id === undefined) events.push(m); });
  let id = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const my = ++id;
    const onMsg = ev => {
      const m = JSON.parse(ev.data);
      if (m.id !== my) return;
      ws.removeEventListener('message', onMsg);
      m.error ? reject(new Error(`${method}: ${JSON.stringify(m.error)}`)) : resolve(m.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: my, method, params }));
  });
  return { send, events, close: () => ws.close() };
}

export async function connect(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find(t => t.type === 'page' && t.url.includes('workbench'));
  if (!page) throw new Error('no workbench page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP WebSocket did not open')), 5000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', err => { clearTimeout(timer); reject(err); }, { once: true });
  });
  let id = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const my = ++id;
    const onMsg = ev => {
      const m = JSON.parse(ev.data);
      if (m.id !== my) return;
      ws.removeEventListener('message', onMsg);
      m.error ? reject(new Error(`${method}: ${JSON.stringify(m.error)}`)) : resolve(m.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: my, method, params }));
  });
  // Lets the window behave as focused while it sits behind other windows.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const NAMED = {
    Enter: { code: 'Enter', keyCode: 13, text: '\r' }, Escape: { code: 'Escape', keyCode: 27 },
    ArrowDown: { code: 'ArrowDown', keyCode: 40 }, ArrowUp: { code: 'ArrowUp', keyCode: 38 },
    ArrowLeft: { code: 'ArrowLeft', keyCode: 37 }, ArrowRight: { code: 'ArrowRight', keyCode: 39 },
    Space: { code: 'Space', keyCode: 32, text: ' ', key: ' ' },
  };
  // Modifier bits: Alt=1, Ctrl=2, Meta=4, Shift=8.
  const key = async (k, modifiers = 0) => {
    const named = NAMED[k];
    const letter = !named && /^[a-z]$/i.test(k);
    const keyCode = named ? named.keyCode : k.toUpperCase().charCodeAt(0);
    const code = named ? named.code : letter ? `Key${k.toUpperCase()}` : k;
    const printable = named ? named.text : (modifiers & ~8) ? undefined : (modifiers & 8 ? k.toUpperCase() : k);
    const base = { key: named ? (named.key ?? k) : (modifiers & 8 ? k.toUpperCase() : k), code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
    await send('Input.dispatchKeyEvent', { type: printable ? 'keyDown' : 'rawKeyDown', ...base, text: printable, unmodifiedText: printable });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };
  const click = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const hover = (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  return { send, evaluate, key, click, hover, close: () => ws.close() };
}

// Reads the SCM tree rows, the focused and selected rows, where DOM focus is and the active tab.
export const SCM_STATE = `(() => {
  const v = document.querySelector('.scm-view');
  if (!v) return null;
  const rows = [...v.querySelectorAll('.monaco-list-row')].map(r => ({
    i: +r.getAttribute('data-index'), label: r.getAttribute('aria-label'), level: +r.getAttribute('aria-level'),
    expanded: r.getAttribute('aria-expanded'),
    focused: r.classList.contains('focused'), selected: r.classList.contains('selected'),
  })).sort((a, b) => a.i - b.i);
  const ae = document.activeElement;
  const tab = document.querySelector('.editor-group-container.active .tabs-container .tab.active')
    ?? document.querySelector('.tabs-container .tab.active');
  return {
    rows,
    focused: rows.find(r => r.focused)?.label ?? null,
    selected: rows.filter(r => r.selected).map(r => r.label),
    domFocusInScmTree: !!(ae && v.querySelector('.monaco-list')?.contains(ae)),
    domFocusInScmInput: !!(ae && ae.closest && ae.closest('.scm-editor')),
    domFocusInEditor: !!(ae && ae.closest && ae.closest('.editor-group-container.active .monaco-editor')),
    activeTab: tab ? tab.getAttribute('aria-label') : null,
  };
})()`;

export function formatRows(state) {
  return state.rows.map(r => (r.focused ? '>' : ' ') + (r.selected ? '*' : ' ') + '  '.repeat(Math.max(0, r.level - 1)) + r.label).join('\n');
}

// Centre of the row with this aria-label, and of its inline action buttons.
export const rowGeometry = label => `(() => {
  const r = [...document.querySelectorAll('.scm-view .monaco-list-row')].find(r => r.getAttribute('aria-label') === ${JSON.stringify(label)});
  if (!r) return null;
  const b = r.getBoundingClientRect();
  return { x: b.left + 60, y: b.top + b.height / 2 };
})()`;

export const rowActions = label => `(() => {
  const r = [...document.querySelectorAll('.scm-view .monaco-list-row')].find(r => r.getAttribute('aria-label') === ${JSON.stringify(label)});
  if (!r) return null;
  return [...r.querySelectorAll('.action-label')].map(a => {
    const b = a.getBoundingClientRect();
    return { title: a.getAttribute('aria-label'), x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
})()`;

export { existsSync };
