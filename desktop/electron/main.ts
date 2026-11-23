import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { IPC, TOOLBAR_HEIGHT, isSiteId } from '../shared/types';
import { PythonBackend } from './python-backend';
import { SiteViews } from './site-views';
import { DLP_CONFIG, loadSites } from './sites';

const SITES = loadSites(app.isPackaged ? {} : process.env);
const E2E = Object.values(SITES).every((site) => site.testOrigin);
const BACKEND_ROOT = path.resolve(__dirname, '..', '..', 'server');
const TOOLBAR_URL = process.env.VITE_DEV_SERVER_URL
  ?? pathToFileURL(path.join(__dirname, '..', 'dist-renderer', 'index.html')).href;
const MAX_PROMPT_LENGTH = 20_000_000;
const MAX_FILE_BASE64_LENGTH = 4 * Math.ceil(DLP_CONFIG.maxFileBytes / 3);

let win: BrowserWindow | null = null;
let views: SiteViews | null = null;
const externalOpened: string[] = [];                          // e2e only: what we would have handed to the OS

/** Only https links ever leave the app, and only via the user's default browser. */
function openExternal(url: string): void {
  if (E2E) {
    externalOpened.push(url);
    return;
  }
  try {
    if (new URL(url).protocol === 'https:') void shell.openExternal(url);
  } catch {
    /* ignore malformed URLs */
  }
}

const backend = new PythonBackend({
  root: BACKEND_ROOT,
  marker: DLP_CONFIG.marker,
  args: E2E && process.env.WALLED_BACKEND_ARGS ? process.env.WALLED_BACKEND_ARGS.split(' ') : [],
});
backend.on('status', (status) => send(IPC.backendStatus, status));

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 760,
    minHeight: 520,
    title: 'Walled DLP',
    backgroundColor: '#14161a',
    webPreferences: {
      preload: path.join(__dirname, 'preload-shell.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  // The toolbar page is ours, but it still may not open windows or navigate away.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => {
    if (!isToolbarDocument(event.url)) event.preventDefault();
  });
  win.webContents.on('will-redirect', (event) => {
    if (!event.isMainFrame || !isToolbarDocument(event.url)) event.preventDefault();
  });

  const siteViews = new SiteViews(win, SITES, path.join(__dirname, 'preload-site.cjs'), openExternal);
  views = siteViews;
  siteViews.on('state', (state) => send(IPC.state, state));

  void win.loadURL(TOOLBAR_URL).catch((error) => console.error('Could not load the toolbar:', error));
  siteViews.select('chatgpt');

  win.on('closed', () => {
    win = null;
    views = null;
    siteViews.dispose();
  });
}

function isToolbarDocument(url: string): boolean {
  return url.split('#', 1)[0] === TOOLBAR_URL;
}

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** Privileged IPC is only honoured from the toolbar window's own page. */
function trusted(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return !!win && event.sender === win.webContents && !!frame
    && frame === event.sender.mainFrame && isToolbarDocument(frame.url);
}

async function scanSiteAction(event: IpcMainInvokeEvent, message: unknown) {
  const siteViews = views;
  const site = siteViews?.scanSite(event);
  const frame = event.senderFrame;
  const blocked = { allow: false };
  if (!siteViews || !site || !frame || typeof message !== 'object' || message === null) return blocked;

  const url = frame.url;
  const epoch = siteViews.inspectionEpoch;
  const { kind, text, name, mimeType, size, b64 } = message as Record<string, unknown>;
  try {
    let decision;
    if (kind === 'prompt' && typeof text === 'string' && text.length <= MAX_PROMPT_LENGTH
      && text.includes(DLP_CONFIG.marker)) {
      decision = await backend.call('prompt', { site: site.name, text });
    } else if (kind === 'file' && typeof name === 'string' && name.length <= 1024
      && typeof mimeType === 'string' && mimeType.length <= 1024
      && typeof size === 'number' && Number.isSafeInteger(size) && size >= 0
      && (b64 === null || (typeof b64 === 'string' && b64.length <= MAX_FILE_BASE64_LENGTH))) {
      decision = await backend.call('file', { site: site.name, name, mimeType, size, b64 });
    } else {
      return blocked;
    }

    if (views !== siteViews || siteViews.inspectionEpoch !== epoch || siteViews.scanSite(event) !== site
      || event.senderFrame !== frame || frame.url !== url) return blocked;
    return decision;
  } catch {
    return { allow: false, error: { code: 'scan_unavailable', message: 'Python could not inspect this action.' } };
  }
}

function registerIpc(): void {
  const handle = (channel: string, fn: (...args: unknown[]) => unknown) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (!trusted(event)) throw new Error(`untrusted sender for ${channel}`);
      return fn(...args);
    });

  handle(IPC.getState, () => views?.getState());
  handle(IPC.selectSite, (id) => {
    if (!isSiteId(id)) throw new Error('invalid site');
    views?.select(id);
  });
  handle(IPC.goBack, () => views?.goBack());
  handle(IPC.goForward, () => views?.goForward());
  handle(IPC.reload, () => views?.reload());
  handle(IPC.getBackendStatus, () => backend.status);
  ipcMain.handle(IPC.scanSiteAction, scanSiteAction);
}

void app.whenReady().then(async () => {
  registerIpc();
  createWindow();

  if (E2E) {
    // Test-only introspection handle; absent in normal runs.
    (globalThis as Record<string, unknown>).__walledTest = {
      backend,
      externalOpened,
      toolbarHeight: TOOLBAR_HEIGHT,
      get win() { return win; },
      get views() { return views; },
    };
  }

  try {
    await backend.start();
    console.log(`Python backend ready (v${backend.status.version}, pid ${backend.pid})`);
  } catch (err) {
    // The preload still holds actions that require an inspection decision.
    console.error('Python backend failed to start:', (err as Error).message);
  }
}).catch(() => {
  console.error('Could not initialize the desktop application');
  app.quit();
});

let quitState: 'running' | 'stopping' | 'ready' = 'running';
app.on('before-quit', (event) => {
  if (quitState === 'ready') return;
  event.preventDefault();
  if (quitState === 'stopping') return;
  quitState = 'stopping';
  win?.hide();
  views?.dispose();
  views = null;
  void backend.stop().finally(() => {
    quitState = 'ready';
    app.quit();
  });
});
app.on('window-all-closed', () => app.quit());
