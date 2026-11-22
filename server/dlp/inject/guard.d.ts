interface GuardConfig {
  marker: string;
  color: string;
  maxFileBytes: number;
  debug?: boolean;
  inspectCleanPrompts?: boolean;
  requireTrustedFileEvents?: boolean;
}

interface GuardSite {
  name: string;
  composerSelectors: string[];
  sendSelectors: string[];
  responseSelectors: string[];
  userMessageSelectors: string[];
}

type GuardAction =
  | { kind: 'prompt'; text: string }
  | { kind: 'file'; name: string; mimeType: string; size: number; b64: string | null };

interface GuardDecision {
  allow: boolean;
  error?: { code: string; message: string };
}

export function installWalledGuard(
  config: GuardConfig,
  site: GuardSite,
  scan: (action: GuardAction) => Promise<GuardDecision>,
): void;
