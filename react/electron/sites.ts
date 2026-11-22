import DLP_CONFIG from '../../server/dlp/inject/config.json';
import type { SiteId } from '../shared/types';

export { DLP_CONFIG };
export const SITE_CONFIG_ARG = '--walled-site=';

export interface SiteDef {
  id: SiteId;
  name: string;
  /** Page loaded the first time the tab is opened. */
  url: string;
  /** Top-level navigations are only allowed to these hosts (and their subdomains). */
  navHosts: string[];
  /** Only the explicit loopback origin for a mock site. */
  testOrigin?: string;
}

/** Identity providers the sites' "Continue with ..." logins redirect through. */
const AUTH_HOSTS = ['accounts.google.com', 'appleid.apple.com', 'login.microsoftonline.com', 'login.live.com'];
const OPENAI_AUTH_HOSTS = ['auth.openai.com', 'auth0.openai.com'];
const SITE_AUTH_PATH = /^\/(?:auth|api\/auth|log-?in|sign-?in|sign-?up|register)(?:\/|$)/i;

const PRODUCTION: Record<SiteId, SiteDef> = {
  chatgpt: {
    id: 'chatgpt',
    name: DLP_CONFIG.sites.chatgpt.name,
    url: DLP_CONFIG.sites.chatgpt.startUrl,
    navHosts: [...DLP_CONFIG.sites.chatgpt.hosts, 'openai.com', ...AUTH_HOSTS],
  },
  perplexity: {
    id: 'perplexity',
    name: DLP_CONFIG.sites.perplexity.name,
    url: DLP_CONFIG.sites.perplexity.startUrl,
    navHosts: [...DLP_CONFIG.sites.perplexity.hosts, ...AUTH_HOSTS],
  },
};

/**
 * Test hook: with WALLED_E2E=1 and WALLED_E2E_SITES='{"chatgpt":"http://127.0.0.1:1234/","perplexity":"..."}'
 * the tabs point at local mock pages. Ignored unless WALLED_E2E=1, so it cannot affect normal runs.
 */
export function loadSites(env: NodeJS.ProcessEnv = process.env): Record<SiteId, SiteDef> {
  const sites: Record<SiteId, SiteDef> = structuredClone(PRODUCTION);
  if (env.WALLED_E2E === '1' && env.WALLED_E2E_SITES) {
    let overrides: Partial<Record<SiteId, string>> | null;
    try {
      overrides = JSON.parse(env.WALLED_E2E_SITES);
    } catch {
      return sites;
    }
    for (const id of Object.keys(sites) as SiteId[]) {
      const override = overrides?.[id];
      if (typeof override !== 'string') continue;
      const url = parseUrl(override);
      if (url?.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port) {
        sites[id] = { ...sites[id], url: url.href, navHosts: [], testOrigin: url.origin };
      }
    }
  }
  return sites;
}

const hostMatches = (host: string, allowed: string) => host === allowed || host.endsWith('.' + allowed);

export function isDlpDocument(site: SiteDef, rawUrl: string): boolean {
  const url = parseUrl(rawUrl);
  if (!url || authenticationTarget(site, rawUrl)) return false;
  if (site.testOrigin) return url.origin === site.testOrigin;
  return url.protocol === 'https:' && !url.port
    && DLP_CONFIG.sites[site.id].hosts.some((host) => hostMatches(url.hostname, host));
}

/** Is a top-level navigation to `rawUrl` allowed inside this site's view? */
export function isNavigationAllowed(site: SiteDef, rawUrl: string): boolean {
  const url = parseUrl(rawUrl);
  if (!url) return false;
  if (rawUrl === 'about:blank') return true;
  if (site.testOrigin) return url.origin === site.testOrigin;
  return url.protocol === 'https:' && !url.port && site.navHosts.some((host) => hostMatches(url.hostname, host));
}

export function authenticationTarget(site: SiteDef, rawUrl: string): 'google' | 'sign-in' | null {
  const url = parseUrl(rawUrl);
  if (!url || !isNavigationAllowed(site, rawUrl)) return null;
  if (hostMatches(url.hostname, 'accounts.google.com')) return 'google';
  // ChatGPT starts Google sign-in through its own origin before redirecting to Google.
  if (site.id === 'chatgpt' && (site.testOrigin || hostMatches(url.hostname, 'chatgpt.com'))
    && url.pathname === '/auth/login_with' && url.searchParams.get('connection') === 'google-oauth2') return 'google';
  if (AUTH_HOSTS.some((host) => hostMatches(url.hostname, host))
    || (site.id === 'chatgpt' && OPENAI_AUTH_HOSTS.some((host) => hostMatches(url.hostname, host)))
    || SITE_AUTH_PATH.test(url.pathname)) return 'sign-in';
  return null;
}

export function isChatGptSignInDocument(site: SiteDef, rawUrl: string): boolean {
  if (site.id !== 'chatgpt' || authenticationTarget(site, rawUrl) !== 'sign-in') return false;
  const { hostname } = new URL(rawUrl);
  return !!site.testOrigin || hostname === 'chatgpt.com' || OPENAI_AUTH_HOSTS.includes(hostname);
}

export function externalLinkUrl(rawUrl: string): URL | null {
  const url = parseUrl(rawUrl);
  return url?.protocol === 'https:' ? url : null;
}

function parseUrl(rawUrl: string): URL | null {
  try {
    const url = new URL(rawUrl);
    return url.username || url.password ? null : url;
  } catch {
    return null;
  }
}
