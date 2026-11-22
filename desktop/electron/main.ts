import path from 'node:path';
import { app, BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { IPC, TOOLBAR_HEIGHT, isSiteId } from '../shared/types';
import { PythonBackend } from './python-backend';
import { SiteViews } from './site-views';
import { loadSites } from './sites';

const E2E = process.env.WALLED_E2E === '1';
const REPO_ROOT = path.resolve(__dirname, '..', '..');       // dist-electron -> desktop -> repo root (has ./dlp)

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
  root: REPO_ROOT,
  args: E2E && process.env.WALLED_BACKEND_ARGS ? process.env.WALLED_BACKEND_ARGS.split(' ') : [],
});

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
    if (!event.url.startsWith(process.env.VITE_DEV_SERVER_URL ?? 'file://')) event.preventDefault();
  });

  views = new SiteViews(win, loadSites(), path.join(__dirname, 'preload-site.cjs'), openExternal);
  views.on('state', (state) => send(IPC.state, state));
  backend.on('status', (status) => send(IPC.backendStatus, status));

  if (process.env.VITE_DEV_SERVER_URL) void win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else void win.loadFile(path.join(__dirname, '..', 'dist-renderer', 'index.html'));

  win.webContents.once('did-finish-load', () => views?.select('chatgpt'));
  win.on('closed', () => {
    win = null;
    views = null;
  });
}

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** Privileged IPC is only honoured from the toolbar window's own page. */
function trusted(event: IpcMainInvokeEvent): boolean {
  return !!win && event.sender === win.webContents;
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
}

app.whenReady().then(async () => {
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
    // The shell stays usable; the toolbar shows the failure. Protection is NOT active in this state.
    console.error('Python backend failed to start:', (err as Error).message);
  }
});

app.on('before-quit', () => backend.killNow());
app.on('window-all-closed', () => app.quit());
