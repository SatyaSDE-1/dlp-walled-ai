/** Types and constants shared by the Electron main process, the preloads and the React shell. */

export type SiteId = 'chatgpt' | 'perplexity';

export interface SiteInfo {
  id: SiteId;
  name: string;
}

/** Everything the toolbar needs to render. */
export interface ShellState {
  sites: SiteInfo[];
  active: SiteId;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export type BackendState = 'starting' | 'ready' | 'restarting' | 'failed' | 'stopped';

export interface BackendStatus {
  state: BackendState;
  /** Python package version reported by the backend's `ping`. */
  version?: string;
  /** Human-readable reason, for `failed` / `restarting`. */
  detail?: string;
  /** How many times the child process has been restarted after crashing. */
  restarts: number;
}

/**
 * The ONLY API the trusted shell UI gets (exposed by preload-shell.ts).
 * Deliberately has no generic "call the backend" or file-system method.
 */
export interface ShellApi {
  getState(): Promise<ShellState>;
  selectSite(id: SiteId): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  onState(cb: (state: ShellState) => void): () => void;
  getBackendStatus(): Promise<BackendStatus>;
  onBackendStatus(cb: (status: BackendStatus) => void): () => void;
}

export const IPC = {
  getState: 'shell:get-state',
  selectSite: 'shell:select-site',
  goBack: 'shell:go-back',
  goForward: 'shell:go-forward',
  reload: 'shell:reload',
  state: 'shell:state',
  getBackendStatus: 'shell:get-backend-status',
  backendStatus: 'shell:backend-status',
} as const;

/** Height (px) of the React toolbar. The site views are laid out directly below it. */
export const TOOLBAR_HEIGHT = 56;

export const isSiteId = (v: unknown): v is SiteId => v === 'chatgpt' || v === 'perplexity';
