/**
 * Trusted preload for the React toolbar window ONLY (never attached to a website view).
 * Exposes a small, typed, fixed API - not ipcRenderer, not Node - via contextBridge.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, isSiteId, type BackendStatus, type ShellApi, type ShellState, type SiteId } from '../shared/types';

const subscribe = <T>(channel: string, cb: (value: T) => void): (() => void) => {
  const listener = (_event: unknown, value: T) => cb(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

const api: ShellApi = {
  getState: () => ipcRenderer.invoke(IPC.getState) as Promise<ShellState | null>,
  selectSite: (id: SiteId) => {
    if (!isSiteId(id)) return Promise.reject(new Error('invalid site'));
    return ipcRenderer.invoke(IPC.selectSite, id);
  },
  goBack: () => ipcRenderer.invoke(IPC.goBack),
  goForward: () => ipcRenderer.invoke(IPC.goForward),
  reload: () => ipcRenderer.invoke(IPC.reload),
  onState: (cb) => subscribe<ShellState>(IPC.state, cb),
  getBackendStatus: () => ipcRenderer.invoke(IPC.getBackendStatus) as Promise<BackendStatus>,
  onBackendStatus: (cb) => subscribe<BackendStatus>(IPC.backendStatus, cb),
};

contextBridge.exposeInMainWorld('walledShell', api);
