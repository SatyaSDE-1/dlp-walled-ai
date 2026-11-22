/// <reference lib="dom" />

import { contextBridge } from 'electron';

type IdentityRequestOptions = CredentialRequestOptions & {
  identity?: { providers?: { configURL: string }[] };
};

// Run before site scripts so passive Google One Tap requests never reach Chromium's account chooser.
// The wrapper runs entirely in the page and uses Chromium's transient activation for sign-in clicks.
contextBridge.executeInMainWorld({
  func: () => {
    const credentials = navigator.credentials;
    if (!credentials) return;
    const get = credentials.get;

    credentials.get = function (this: CredentialsContainer, options?: IdentityRequestOptions) {
      if (!navigator.userActivation.isActive) {
        const providers = options?.identity?.providers;
        if (Array.isArray(providers) && providers.some(
          (provider) => URL.parse(provider?.configURL)?.origin === 'https://accounts.google.com',
        )) {
          return Promise.reject(new DOMException('Google sign-in requires user interaction.', 'NotAllowedError'));
        }
      }
      return get.call(this, options);
    };
  },
});
