// /Users/anurag/waller-ai/walled-dlp/walled-dlp/react/electron/main.ts
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { IPC, TOOLBAR_HEIGHT, isSiteId } from '../shared/types';
import { PythonBackend } from './python-backend';
import { SiteViews } from './site-views';
import { DLP_CONFIG, loadSites } from './sites';

const SITES = loadSites(app.isPackaged ? {} : process.env);
const E2E = Object.values(SITES).every((site) => site.testOrigin);
const BACKEND_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'server')
  : path.resolve(__dirname, '..', '..', 'server');
const TOOLBAR_FILE_URL = pathToFileURL(path.join(__dirname, '..', 'dist-renderer', 'index.html')).href;
const TOOLBAR_URL = toolbarUrl(app.isPackaged ? undefined : process.env.VITE_DEV_SERVER_URL);
const MAX_PROMPT_LENGTH = 20_000_000; // Maximum accepted by dlp.server.
const MAX_FILE_BASE64_LENGTH = 4 * Math.ceil(DLP_CONFIG.maxFileBytes / 3);

let win: BrowserWindow | null = null;
let views: SiteViews | null = null;
const externalOpened: string[] = [];                          // e2e only: what we would have handed to the OS

function toolbarUrl(devUrl: string | undefined): string {
  if (devUrl) {
    try {
      const url = new URL(devUrl);
      if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port
        && !url.username && !url.password && url.pathname === '/' && !url.search) {
        return url.origin + '/';
      }
    } catch {
      // Fall back to the local toolbar bundle.
    }
    console.warn('Ignoring an invalid toolbar development URL');
  }
  return TOOLBAR_FILE_URL;
}

let googleSignInPending = false;
async function openExternal(url: URL, emailRoutedSite?: string): Promise<void> {
  try {
    if (emailRoutedSite) {
      if (googleSignInPending || !win || win.isDestroyed()) return;
      googleSignInPending = true;
      const parent = win;
      try {
        const { response } = await dialog.showMessageBox(parent, {
          type: 'info',
          message: 'Google sign-in is unavailable inside Walled DLP',
          detail: `${emailRoutedSite} routed this email sign-in to Google.\n\n`
            + `You can open ${emailRoutedSite} in your default browser and sign in with Google there. `
            + 'That sign-in applies only to your browser session. Walled DLP protects activity in its own window.\n\n'
            + `To use ${emailRoutedSite} here, go back and choose another sign-in method available for your account or continue as a guest.`,
          buttons: ['Back to ChatGPT', 'Open Website in Browser'],
          defaultId: 0,
          cancelId: 0,
        });
        if (response !== 1 || parent.isDestroyed() || !views) return;
      } finally {
        googleSignInPending = false;
      }
    }
    if (E2E) externalOpened.push(url.href);
    else await shell.openExternal(url.href);
  } catch {
    console.warn('Could not open the link in the system browser');
  }
}

const backend = new PythonBackend({
  root: BACKEND_ROOT,
  pythonPath: app.isPackaged ? path.join(process.resourcesPath, 'python', 'bin', 'python3') : undefined,
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
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const restrictToolbarNavigation = (event: { isMainFrame: boolean; url: string; preventDefault(): void }) => {
    if (!event.isMainFrame || !isToolbarDocument(event.url)) event.preventDefault();
  };
  win.webContents.on('will-frame-navigate', restrictToolbarNavigation);
  win.webContents.on('will-redirect', restrictToolbarNavigation);

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

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function isToolbarDocument(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).href.split('#', 1)[0] === TOOLBAR_URL;
  } catch {
    return false;
  }
}

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
  if (!site || !frame || typeof message !== 'object' || message === null) return blocked;

  const url = frame.url;
  const epoch = siteViews?.inspectionEpoch;
  const action = message as Record<string, unknown>;
  try {
    const { kind, text, name, mimeType, size, b64 } = action;
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

    if (views !== siteViews || siteViews?.inspectionEpoch !== epoch || siteViews?.scanSite(event) !== site
      || event.senderFrame !== frame || frame.url !== url) {
      return blocked;
    }
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

  handle(IPC.getState, () => views?.getState() ?? null);
  handle(IPC.selectSite, (id) => {
    if (!isSiteId(id)) throw new Error('invalid site');
    views?.select(id);
  });
  handle(IPC.goBack, () => views?.goBack());
  handle(IPC.goForward, () => views?.goForward());
  handle(IPC.reload, () => views?.reload());
  handle(IPC.getBackendStatus, () => backend.status);
  ipcMain.handle(IPC.scanSiteAction, scanSiteAction);
  ipcMain.on(IPC.openSiteLink, (event, url: unknown) => views?.openExternalLink(event, url));
  ipcMain.on(IPC.siteSignIn, (event, action: unknown) => views?.requestSignIn(event, action));
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
    // The preload still blocks actions that need a Python decision.
    console.error('Python backend failed to start:', (err as Error).message);
  }
}).catch(() => {
  console.error('Could not initialize the desktop application');
  app.quit();
});

let quitState: 'running' | 'waiting' | 'ready' = 'running';
app.on('before-quit', (event) => {
  if (quitState === 'ready') return;
  event.preventDefault();
  if (quitState === 'waiting') return;
  quitState = 'waiting';
  win?.hide();
  views?.dispose();
  views = null;
  void backend.stop().finally(() => {
    quitState = 'ready';
    app.quit();
  });
});
app.on('window-all-closed', () => app.quit());
