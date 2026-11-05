const { app, BrowserWindow, clipboard, desktopCapturer, globalShortcut, ipcMain,
  net, powerMonitor, protocol, screen, session } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { encodeInput } = require('./input.cjs');

const origin = 'anysys-app://desktop';
const assets = new Set(['/index.html', '/styles.css', '/renderer.js', '/signaling.js',
  '/viewer-input.js', '/indicator.html', '/indicator.css', '/indicator.js']);
protocol.registerSchemesAsPrivileged([
  { scheme: 'anysys-app', privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);

const stopShortcut = 'Ctrl+Alt+Shift+F12';
let window;
let indicator;
let sharing;
let shortcutReady;

function stopSharing() {
  const current = sharing;
  sharing = undefined;
  current?.helper?.stdin.end();
  indicator?.destroy();
  indicator = undefined;
}

function emergencyStop(reason) {
  if (!sharing) return;
  stopSharing();
  if (window && !window.isDestroyed()) window.webContents.send('session:stop', reason);
}

function localFrame(event, target) {
  return target && !target.isDestroyed() && event.senderFrame === target.webContents.mainFrame;
}

function handle(channel, action) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!localFrame(event, window)) throw new Error('Invalid request origin.');
    return action(...args);
  });
}

function newWindow(options) {
  const result = new BrowserWindow({
    ...options,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  result.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  result.webContents.on('will-navigate', event => event.preventDefault());
  result.webContents.on('will-attach-webview', event => event.preventDefault());
  return result;
}

function startHelper(current) {
  const exe = app.isPackaged
    ? path.join(process.resourcesPath, 'AnySys.Input.exe')
    : path.join(__dirname, '..', 'build', 'AnySys.Input.exe');
  const monitors = screen.getAllDisplays().map(display => screen.dipToScreenRect(null, display.bounds));
  const left = Math.min(...monitors.map(rect => rect.x));
  const top = Math.min(...monitors.map(rect => rect.y));
  const right = Math.max(...monitors.map(rect => rect.x + rect.width));
  const bottom = Math.max(...monitors.map(rect => rect.y + rect.height));
  const geometry = [left, top, right - left, bottom - top].map(String);
  const helper = spawn(exe, geometry, { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  current.helper = helper;
  const failed = () => {
    if (sharing === current) emergencyStop('Windows input stopped. Start a new session to retry.');
  };
  helper.on('error', failed);
  helper.on('exit', failed);
  helper.stdin.on('error', failed);
  return new Promise((resolve, reject) => {
    helper.once('spawn', resolve);
    helper.once('error', reject);
  });
}

function showIndicator(control, display) {
  const area = display.workArea;
  indicator = newWindow({
    width: 328, height: 52, x: area.x + area.width - 344, y: area.y + 16,
    frame: false, alwaysOnTop: true, skipTaskbar: true, resizable: false,
    show: false, backgroundColor: '#211b16'
  });
  indicator.on('close', event => {
    event.preventDefault();
    emergencyStop('Sharing stopped on this PC.');
  });
  indicator.once('ready-to-show', () => indicator?.showInactive());
  return indicator.loadURL(`${origin}/indicator.html?control=${control}`);
}

app.whenReady().then(async () => {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('AnySys requires 64-bit Windows with an x64 Electron runtime.');
  }
  protocol.handle('anysys-app', request => {
    const url = new URL(request.url);
    if (url.host !== 'desktop' || !assets.has(url.pathname)) return new Response(null, { status: 404 });
    return net.fetch(pathToFileURL(path.join(__dirname, url.pathname.slice(1))).href);
  });
  const browserSession = session.defaultSession;
  browserSession.setPermissionCheckHandler((contents, permission) =>
    contents === window?.webContents && permission === 'display-capture' && Boolean(sharing));
  browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(contents === window?.webContents && details.isMainFrame &&
      permission === 'display-capture' && Boolean(sharing));
  });
  browserSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const current = sharing;
    if (!current || current.requested || !request.userGesture ||
        request.frame !== window?.webContents.mainFrame || !request.videoRequested ||
        request.audioRequested !== current.audio) {
      callback(null);
      return;
    }
    current.requested = true;
    let streams = null;
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find(item => item.display_id === String(current.display.id));
      if (sharing === current && source) {
        current.granted = true;
        streams = { video: source, ...(current.audio ? { audio: 'loopback' } : {}) };
      }
    } catch (error) {
      console.error('Screen enumeration failed:', error.message);
    }
    callback(streams);
  });

  shortcutReady = globalShortcut.register(stopShortcut, () => emergencyStop('Sharing stopped by the local shortcut.'));
  powerMonitor.on('lock-screen', () => emergencyStop('Sharing ended because Windows locked.'));
  powerMonitor.on('suspend', () => emergencyStop('Sharing ended because Windows is sleeping.'));
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screen.on(event, () => emergencyStop('The display configuration changed. Start a new session.'));
  }

  handle('displays:list', () => {
    const primary = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((display, index) => {
      const bounds = screen.dipToScreenRect(null, display.bounds);
      const label = display.label || `Display ${index + 1}`;
      return {
        id: display.id,
        label: `${label} · ${bounds.width} × ${bounds.height}${display.id === primary ? ' · Primary' : ''}`,
        primary: display.id === primary
      };
    });
  });
  handle('clipboard:copy', value => {
    if (typeof value !== 'string' || value.length > 8192) throw new Error('Invalid invite.');
    clipboard.writeText(value);
  });
  handle('share:prepare', (id, audio, control) => {
    if (sharing || typeof audio !== 'boolean' || typeof control !== 'boolean') {
      throw new Error('Screen sharing is already active or the request is invalid.');
    }
    if (control && !shortcutReady) {
      throw new Error('The emergency shortcut is unavailable. Free Ctrl+Alt+Shift+F12 and restart AnySys, or approve view-only.');
    }
    const display = screen.getAllDisplays().find(item => item.id === id);
    if (!display) throw new Error('The selected display is unavailable.');
    sharing = { display, audio, control, bounds: screen.dipToScreenRect(null, display.bounds) };
  });
  handle('share:activate', async () => {
    const current = sharing;
    if (!current?.granted || current.active || current.activating) throw new Error('Capture is unavailable.');
    current.activating = true;
    await showIndicator(current.control, current.display);
    if (sharing !== current) throw new Error('Sharing stopped.');
    if (current.control) await startHelper(current);
    if (sharing !== current) throw new Error('Sharing stopped.');
    current.active = true;
    current.tokens = 240;
    current.refillAt = performance.now();
  });
  handle('share:stop', stopSharing);
  ipcMain.on('indicator:stop', event => {
    if (localFrame(event, indicator)) emergencyStop('Sharing stopped on this PC.');
  });
  ipcMain.on('share:input', (event, input) => {
    const current = sharing;
    if (!current?.active || !current.helper || !localFrame(event, window)) return;
    const now = performance.now();
    current.tokens = Math.min(240, current.tokens + (now - current.refillAt) * 0.24);
    current.refillAt = now;
    if (current.tokens < 1 || current.helper.stdin.writableLength > 2048) {
      emergencyStop('Remote input exceeded its safety limit.');
      return;
    }
    current.tokens--;
    const command = encodeInput(input, current.bounds);
    if (command) current.helper.stdin.write(command + '\n');
  });

  window = newWindow({
    title: 'AnySys', width: 1040, height: 780, minWidth: 780, minHeight: 620,
    backgroundColor: '#10131a', autoHideMenuBar: true
  });
  window.webContents.on('render-process-gone', () => stopSharing());
  window.on('unresponsive', () => {
    if (sharing) window.destroy();
  });
  window.on('closed', () => { stopSharing(); app.quit(); });
  await window.loadURL(origin + '/index.html');
}).catch(error => {
  console.error(error);
  app.exit(1);
});

app.on('will-quit', () => {
  stopSharing();
  globalShortcut.unregisterAll();
});
