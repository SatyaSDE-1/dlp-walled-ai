import type { ShellApi } from '../shared/types';

declare global {
  interface Window {
    /** Injected by electron/preload-shell.ts (toolbar window only). */
    walledShell?: ShellApi;
  }
}

export { };
