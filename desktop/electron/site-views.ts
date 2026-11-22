import { EventEmitter } from 'node:events';
import { BrowserWindow, WebContentsView, session } from 'electron';
import { TOOLBAR_HEIGHT, type ShellState, type SiteId } from '../shared/types';
import { isNavigationAllowed, type SiteDef } from './sites';

/** One persistent profile shared by both sites, so logins survive restarts. */
export const SITE_PARTITION = 'persist:walled-sites';

/** Chrome-looking user agent. Electron's default ("... Electron/x ...") is flagged by some bot checks. */
function chromeUserAgent(): string {
  const major = process.versions.chrome.split('.')[0];
  const platform =
    process.platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : process.platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/** Permissions a chat site legitimately needs. Everything else (camera, mic, geolocation...) is denied. */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write']);

/**
 * Owns the embedded browser views (one Electron WebContentsView per site), keeps them laid out below
 * the toolbar, and enforces what website content may do. Emits `state` whenever the toolbar must update.
 */
export class SiteViews extends EventEmitter {
  private readonly views = new Map<SiteId, WebContentsView>();
  private active: SiteId;

  constructor(
    private readonly win: BrowserWindow,
    private readonly sites: Record<SiteId, SiteDef>,
    private readonly preloadPath: string,
    private readonly openExternal: (url: string) => void,
  ) {
    super();
    this.active = 'chatgpt';
    this.configureSession();
    for (const ev of ['resize', 'resized', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) {
      win.on(ev as 'resize', () => this.layout());
    }
  }

  // ---------------------------------------------------------------- public
  select(id: SiteId): void {
    if (!this.sites[id]) throw new Error(`unknown site: ${id}`);
    let view = this.views.get(id);
    if (!view) {
      view = this.createView(this.sites[id]);
      this.views.set(id, view);
      this.win.contentView.addChildView(view);
      void view.webContents.loadURL(this.sites[id].url);
    }
    this.active = id;
    for (const [key, v] of this.views) v.setVisible(key === id);
    this.layout();
    this.emitState();
  }

  goBack(): void {
    const h = this.current()?.webContents.navigationHistory;
    if (h?.canGoBack()) h.goBack();
  }

  goForward(): void {
    const h = this.current()?.webContents.navigationHistory;
    if (h?.canGoForward()) h.goForward();
  }

  reload(): void {
    this.current()?.webContents.reload();
  }

  getState(): ShellState {
    const wc = this.current()?.webContents;
    return {
      sites: Object.values(this.sites).map((s) => ({ id: s.id, name: s.name })),
      active: this.active,
      url: wc?.getURL() ?? '',
      title: wc?.getTitle() ?? '',
      loading: wc?.isLoading() ?? false,
      canGoBack: wc?.navigationHistory.canGoBack() ?? false,
      canGoForward: wc?.navigationHistory.canGoForward() ?? false,
    };
  }

  /** Test / diagnostics access. */
  get all(): ReadonlyMap<SiteId, WebContentsView> {
    return this.views;
  }

  // --------------------------------------------------------------- internals
  private current(): WebContentsView | undefined {
    return this.views.get(this.active);
  }

  private emitState(): void {
    this.emit('state', this.getState());
  }

  /** Every view fills the area below the toolbar (hidden ones too, so they are right when shown). */
  layout(): void {
    const [width, height] = this.win.getContentSize();
    const bounds = { x: 0, y: TOOLBAR_HEIGHT, width, height: Math.max(0, height - TOOLBAR_HEIGHT) };
    for (const view of this.views.values()) view.setBounds(bounds);
  }

  private configureSession(): void {
    const ses = session.fromPartition(SITE_PARTITION);
    ses.setUserAgent(chromeUserAgent());
    ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
    // Older One Tap flows render their automatic chooser in a dedicated iframe.
    ses.webRequest.onBeforeRequest({ urls: ['https://accounts.google.com/gsi/iframe/select*'] }, (details, callback) => {
      callback({ cancel: details.resourceType === 'subFrame' && new URL(details.url).pathname === '/gsi/iframe/select' });
    });
  }

  private createView(site: SiteDef): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        partition: SITE_PARTITION,
        preload: this.preloadPath,
        // Website content is untrusted: no Node, isolated world, OS-level sandbox.
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
      },
    });
    view.setBackgroundColor('#ffffff');
    const wc = view.webContents;

    // Links that open a new window: stay in this view if the destination is allowed, else hand to the OS browser.
    wc.setWindowOpenHandler(({ url }) => {
      if (isNavigationAllowed(site, url)) void wc.loadURL(url);
      else this.openExternal(url);
      return { action: 'deny' };
    });

    // Top-level navigations (links, redirects, location changes) may not leave the allowlist.
    const guard = (event: { url: string; preventDefault(): void }) => {
      if (!isNavigationAllowed(site, event.url)) {
        event.preventDefault();
        this.openExternal(event.url);
      }
    };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);

    for (const ev of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated'] as const) {
      wc.on(ev as 'did-navigate', () => {
        if (this.views.get(this.active) === view) this.emitState();
      });
    }
    return view;
  }
}
