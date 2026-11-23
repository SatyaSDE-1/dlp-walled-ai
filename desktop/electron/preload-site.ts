/// <reference lib="dom" />

import { contextBridge, ipcRenderer } from 'electron';
import { installWalledGuard } from '../../server/dlp/inject/guard.js';
import { IPC, type SiteId } from '../shared/types';
import { DLP_CONFIG, isDlpDocument, SITE_CONFIG_ARG, type SiteDef } from './sites';

declare const __WALLED_RESPONSE_STYLE__: {
  color: string;
  sites: Record<SiteId, { responseSelectors: string[]; userMessageSelectors: string[] }>;
};

type IdentityRequestOptions = CredentialRequestOptions & {
  identity?: { providers?: { configURL: string }[] };
};

// Run before site scripts so passive Google One Tap requests never reach Chromium's account chooser.
// The wrapper runs entirely in the page and uses Chromium's transient activation for sign-in clicks.
function requireActivationForGoogleOneTap(): void {
  contextBridge.executeInMainWorld({
    func: () => {
      const credentials = navigator.credentials;
      if (!credentials) return;
      const get = credentials.get;

      credentials.get = function (this: CredentialsContainer, options?: IdentityRequestOptions) {
        const providers = options?.identity?.providers;
        if (!navigator.userActivation.isActive && Array.isArray(providers) && providers.some(
          (provider) => typeof provider?.configURL === 'string'
            && URL.parse(provider.configURL)?.origin === 'https://accounts.google.com',
        )) {
          return Promise.reject(new DOMException('Google sign-in requires user interaction.', 'NotAllowedError'));
        }
        return get.call(this, options);
      };
    },
  });
}

if (process.isMainFrame) {
  const config = process.argv.find((argument) => argument.startsWith(SITE_CONFIG_ARG));
  if (!config) throw new Error('Missing DLP site configuration');
  const site = JSON.parse(config.slice(SITE_CONFIG_ARG.length)) as SiteDef;

  if (location.href !== 'about:blank') requireActivationForGoogleOneTap();
  if (isDlpDocument(site, location.href)) {
    const { color, sites } = __WALLED_RESPONSE_STYLE__;
    const guardConfig = { ...DLP_CONFIG, color, inspectCleanPrompts: false, requireTrustedFileEvents: true };
    const guardSite = { ...DLP_CONFIG.sites[site.id], ...sites[site.id] };
    installWalledGuard(guardConfig, guardSite, (action) => ipcRenderer.invoke(IPC.scanSiteAction, action));
  }
}
