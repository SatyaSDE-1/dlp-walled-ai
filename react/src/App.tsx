// /Users/anurag/waller-ai/walled-dlp/walled-dlp/react/src/App.tsx
import { useEffect, useState } from 'react';
import type { BackendStatus, ShellState } from '../shared/types';

const BACKEND_LABEL: Record<BackendStatus['state'], string> = {
  starting: 'Starting',
  ready: 'Ready',
  restarting: 'Restarting',
  failed: 'Unavailable',
  stopped: 'Stopped',
};

export default function App() {
  const [shell, setShell] = useState<ShellState | null>(null);
  const [backend, setBackend] = useState<BackendStatus>({ state: 'starting', restarts: 0 });
  const api = window.walledShell;

  useEffect(() => {
    if (!api) {
      setBackend({ state: 'failed', restarts: 0 });
      return;
    }
    let mounted = true;
    let sawShellUpdate = false;
    let sawBackendUpdate = false;
    const offState = api.onState((state) => {
      sawShellUpdate = true;
      setShell(state);
    });
    const offBackend = api.onBackendStatus((status) => {
      sawBackendUpdate = true;
      setBackend(status);
    });
    void api.getState().then((state) => {
      if (mounted && !sawShellUpdate) setShell(state);
    }).catch(() => {
      if (mounted) console.warn('Could not read browser state');
    });
    void api.getBackendStatus().then((status) => {
      if (mounted && !sawBackendUpdate) setBackend(status);
    }).catch(() => {
      if (mounted && !sawBackendUpdate) setBackend({ state: 'failed', restarts: 0 });
    });
    return () => {
      mounted = false;
      offState();
      offBackend();
    };
  }, [api]);

  const host = shell?.host ?? '';
  const navigate = (request: Promise<void> | undefined) => {
    void request?.catch(() => console.warn('Browser navigation request failed'));
  };

  return (
    <header className="toolbar">
      <div className="brand" aria-label="Walled DLP">
        <span className="brand-mark" aria-hidden="true" />
        Walled AI DLP
      </div>

      <nav className="tabs" role="tablist" aria-label="Sites">
        {shell?.sites.map((site) => (
          <button
            key={site.id}
            role="tab"
            aria-selected={shell.active === site.id}
            className={shell.active === site.id ? 'tab active' : 'tab'}
            onClick={() => navigate(api?.selectSite(site.id))}
          >
            {site.name}
          </button>
        ))}
      </nav>

      <div className="nav-buttons">
        <button aria-label="Back" title="Back" disabled={!shell?.canGoBack} onClick={() => navigate(api?.goBack())}>
          ‹
        </button>
        <button aria-label="Forward" title="Forward" disabled={!shell?.canGoForward} onClick={() => navigate(api?.goForward())}>
          ›
        </button>
        <button aria-label="Reload" title="Reload" disabled={!shell} onClick={() => navigate(api?.reload())}>
          ⟳
        </button>
      </div>

      <div className="address" title={host} aria-live="polite">
        {shell?.loading ? <span className="spinner" aria-label="Loading" /> : null}
        {shell?.loadFailed ? `Couldn’t load ${host || 'the page'}` : host}
      </div>

      <div className={`pill pill-${backend.state}`} title={backend.detail ?? ''} data-testid="backend-status">
        <span className="dot" aria-hidden="true" />
        Python backend: {BACKEND_LABEL[backend.state]}
        {backend.state === 'ready' && backend.version ? ` · v${backend.version}` : ''}
      </div>
    </header>
  );
}
