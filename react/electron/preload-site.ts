// /Users/anurag/waller-ai/walled-dlp/walled-dlp/react/electron/preload-site.ts

/// <reference lib="dom" />
import { contextBridge, ipcRenderer } from 'electron';
import { installWalledGuard } from '../../server/dlp/inject/guard.js';
import { IPC, type SiteId } from '../shared/types';
import { authenticationTarget, DLP_CONFIG, externalLinkUrl, isChatGptSignInDocument, isDlpDocument, isNavigationAllowed, SITE_CONFIG_ARG, type SiteDef } from './sites';

declare const __WALLED_RESPONSE_STYLE__: {
  color: string;
  sites: Record<SiteId, { responseSelectors: string[]; userMessageSelectors: string[] }>;
};

type IdentityRequestOptions = CredentialRequestOptions & {
  identity?: { providers?: { configURL: string }[] };
};

function requireActivationForGoogleOneTap(): void {
  // Run in the page before its scripts so Chromium does not show an automatic chooser.
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

function watchChatGptSignInCompletion(): void {
  const statusText = /^(?:(?:completing|finishing) (?:your )?(?:sign[ -]?in|log[ -]?in|signing (?:you )?in)|(?:sign[ -]?in|log[ -]?in) (?:approved|complete))\s*[.!…]*$/i;
  const isCompleting = () => Array.from(document.querySelectorAll('h1, h2, [role=heading], [role=status], [aria-live], main p'))
    .some((element) => element.checkVisibility({ visibilityProperty: true, opacityProperty: true })
      && statusText.test((element.textContent ?? '').replace(/\s+/g, ' ').replace(/[‐‑‒–—]/g, '-').trim()));
  let retry: ReturnType<typeof setTimeout> | undefined;
  const update = () => {
    if (!isCompleting()) {
      clearTimeout(retry);
      retry = undefined;
    } else if (retry === undefined) {
      // Give the site's normal redirect time to finish before requesting a single recovery load.
      retry = setTimeout(() => {
        if (isCompleting()) {
          observer.disconnect();
          ipcRenderer.send(IPC.siteSignIn, 'retry-chatgpt-completion');
        }
      }, 6000);
    }
  };
  const observer = new MutationObserver(update);
  observer.observe(document, {
    childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['hidden', 'class', 'style', 'aria-hidden'],
  });
  window.addEventListener('pagehide', () => {
    clearTimeout(retry);
    observer.disconnect();
  }, { once: true });
  update();
}

// Install against the site DOM synchronously in the isolated preload world.
const config = process.argv.find((argument) => argument.startsWith(SITE_CONFIG_ARG));
if (process.isMainFrame) {
  if (!config) throw new Error('Missing DLP site configuration');
  const site = JSON.parse(config.slice(SITE_CONFIG_ARG.length)) as SiteDef;
  if (location.href !== 'about:blank' && isNavigationAllowed(site, location.href)) requireActivationForGoogleOneTap();
  if (isChatGptSignInDocument(site, location.href)) watchChatGptSignInCompletion();
  if (isDlpDocument(site, location.href)) {
    const { color, sites } = __WALLED_RESPONSE_STYLE__;
    const guardConfig = { ...DLP_CONFIG, color, inspectCleanPrompts: false, requireTrustedFileEvents: true };
    const guardSite = { ...DLP_CONFIG.sites[site.id], ...sites[site.id] };
    installWalledGuard(guardConfig, guardSite, async (action) => {
      if (action.kind === 'prompt') return ipcRenderer.invoke(IPC.scanSiteAction, { kind: 'prompt', text: action.text });
      const { name, mimeType, size, b64 } = action;
      return ipcRenderer.invoke(IPC.scanSiteAction, { kind: 'file', name, mimeType, size, b64 });
    });
  }

  const credentialField = 'input[type=email], input[type=password]';
  const sendSignIn = (usesEmail: boolean) =>
    ipcRenderer.send(IPC.siteSignIn, site.id === 'chatgpt' && usesEmail ? 'email-sign-in' : 'sign-in');
  window.addEventListener('click', (event) => {
    if (!event.isTrusted || event.defaultPrevented || event.button !== 0) return;
    const control = event.composedPath().find((target): target is Element =>
      target instanceof Element && target.matches('a[href], button, [role=button], input[type=submit]'));
    if (!control) return;
    const label = (control.getAttribute('aria-label') || control.textContent || '').replace(/\s+/g, ' ').trim();
    const destination = control instanceof HTMLAnchorElement ? authenticationTarget(site, control.href) : null;
    const credential = /^(?:continue|next)$/i.test(label) || control.matches('button[type=submit], input[type=submit]')
      ? control.closest('form, dialog, [role=dialog]')?.querySelector<HTMLInputElement>(credentialField)
      : undefined;
    if (destination === 'google' || /^(?:continue|sign in|log in) with google$/i.test(label)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      ipcRenderer.send(IPC.siteSignIn, 'google');
    } else if (destination === 'sign-in' || /^(?:log[ -]?in|sign[ -]?(?:in|up))$/i.test(label)
      || /^(?:continue|sign in|log in) with (?:apple|microsoft|email|phone(?: number)?)$/i.test(label)
      || credential) {
      sendSignIn(credential?.type === 'email');
    }
  }, true);
  window.addEventListener('keydown', (event) => {
    // A programmatic requestSubmit() also emits a trusted submit event.
    const field = event.composedPath()[0];
    if (event.isTrusted && event.key === 'Enter' && !event.repeat && !event.isComposing
      && field instanceof HTMLInputElement && field.matches(credentialField)) {
      sendSignIn(field.type === 'email');
    }
  }, true);

  const openExternalLink = (event: MouseEvent) => {
    if (!event.isTrusted || event.defaultPrevented || event.button !== (event.type === 'click' ? 0 : 1)) return;
    const link = event.composedPath().find((target): target is HTMLAnchorElement =>
      target instanceof HTMLAnchorElement && target.hasAttribute('href'));
    if (!link || link.hasAttribute('download') || isNavigationAllowed(site, link.href)) return;

    const url = externalLinkUrl(link.href);
    if (!url) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    ipcRenderer.send(IPC.openSiteLink, url.href);
  };

  window.addEventListener('click', openExternalLink, true);
  window.addEventListener('auxclick', openExternalLink, true);
}
