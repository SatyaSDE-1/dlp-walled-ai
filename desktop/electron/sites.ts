import type { SiteId } from '../shared/types';

export interface SiteDef {
  id: SiteId;
  name: string;
  /** Page loaded the first time the tab is opened. */
  url: string;
  /** Top-level navigations are only allowed to these hosts (and their subdomains). */
  navHosts: string[];
  /** Allow plain http for these hosts. Production sites are https-only; only e2e tests add entries. */
  httpHosts: string[];
}

/** Identity providers the sites' "Continue with ..." logins redirect through. */
const AUTH_HOSTS = ['accounts.google.com', 'appleid.apple.com', 'login.microsoftonline.com', 'login.live.com'];

const PRODUCTION: Record<SiteId, SiteDef> = {
  chatgpt: {
    id: 'chatgpt',
    name: 'ChatGPT',
    url: 'https://chatgpt.com/',
    navHosts: ['chatgpt.com', 'openai.com', ...AUTH_HOSTS],
    httpHosts: [],
  },
  perplexity: {
    id: 'perplexity',
    name: 'Perplexity',
    url: 'https://www.perplexity.ai/',
    navHosts: ['perplexity.ai', ...AUTH_HOSTS],
    httpHosts: [],
  },
};

/**
 * Test hook: with WALLED_E2E=1 and WALLED_E2E_SITES='{"chatgpt":"http://127.0.0.1:1234/","perplexity":"..."}'
 * the tabs point at local mock pages. Ignored unless WALLED_E2E=1, so it cannot affect normal runs.
 */
export function loadSites(env: NodeJS.ProcessEnv = process.env): Record<SiteId, SiteDef> {
  const sites: Record<SiteId, SiteDef> = structuredClone(PRODUCTION);
  if (env.WALLED_E2E === '1' && env.WALLED_E2E_SITES) {
    const overrides = JSON.parse(env.WALLED_E2E_SITES) as Partial<Record<SiteId, string>>;
    for (const id of Object.keys(sites) as SiteId[]) {
      const override = overrides[id];
      if (!override) continue;
      const host = new URL(override).hostname;
      sites[id] = { ...sites[id], url: override, navHosts: [host], httpHosts: [host] };
    }
  }
  return sites;
}

const hostMatches = (host: string, allowed: string) => host === allowed || host.endsWith('.' + allowed);

/** Is a top-level navigation to `rawUrl` allowed inside this site's view? */
export function isNavigationAllowed(site: SiteDef, rawUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol === 'https:') return site.navHosts.some((h) => hostMatches(host, h));
  if (u.protocol === 'http:') return site.httpHosts.some((h) => hostMatches(host, h));
  return u.protocol === 'about:' && rawUrl === 'about:blank';
}
