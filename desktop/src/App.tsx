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

  useEffect(() => {
    const api = window.walledShell;
    void api.getState().then(setShell);
    void api.getBackendStatus().then(setBackend);
    const offState = api.onState(setShell);
    const offBackend = api.onBackendStatus(setBackend);
    return () => {
      offState();
      offBackend();
    };
  }, []);

  const api = window.walledShell;
  const host = shell?.url ? safeHost(shell.url) : '';

  return (
    <header className="toolbar">
      <div className="brand" aria-label="Walled DLP">
        <span className="brand-mark" aria-hidden="true" />
        Walled DLP
      </div>

      <nav className="tabs" role="tablist" aria-label="Sites">
        {shell?.sites.map((site) => (
          <button
            key={site.id}
            role="tab"
            aria-selected={shell.active === site.id}
            className={shell.active === site.id ? 'tab active' : 'tab'}
            onClick={() => void api.selectSite(site.id)}
          >
            {site.name}
          </button>
        ))}
      </nav>

      <div className="nav-buttons">
        <button aria-label="Back" title="Back" disabled={!shell?.canGoBack} onClick={() => void api.goBack()}>
          ‹
        </button>
        <button aria-label="Forward" title="Forward" disabled={!shell?.canGoForward} onClick={() => void api.goForward()}>
          ›
        </button>
        <button aria-label="Reload" title="Reload" onClick={() => void api.reload()}>
          ⟳
        </button>
      </div>

      <div className="address" title={shell?.url}>
        {shell?.loading ? <span className="spinner" aria-label="Loading" /> : null}
        {host}
      </div>

      <div className={`pill pill-${backend.state}`} title={backend.detail ?? ''} data-testid="backend-status">
        <span className="dot" aria-hidden="true" />
        Python backend: {BACKEND_LABEL[backend.state]}
        {backend.state === 'ready' && backend.version ? ` · v${backend.version}` : ''}
      </div>
    </header>
  );
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
