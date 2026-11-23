/*
 * Walled DLP - page-side hooks.
 *
 * Installed before page scripts by the Electron site preload. The backend's
 * init_script operation packages the same hooks with its scan transport adapter.
 *
 * What it does
 *   1. Prompts : capture-phase Enter / Send-button hooks. Prompts requiring a
 *                scan are held for a Python decision before they can be replayed.
 *   2. Files   : capture-phase hooks on <input type=file> change, drag-and-drop and paste.
 *                File bytes go to Python for inspection (text / PDF / OCR). Only the files
 *                the user approved are replayed to the site; denied ones are dropped.
 *   3. Colour  : a constructable stylesheet colours every AI answer. (Constructable sheets
 *                are not subject to the page's CSP, unlike injected <style> tags.)
 *
 * Hooks are on `window` in the capture phase so they run before the site's own listeners.
 * The file hooks ignore only the specific events they replay.
 */
function installWalledGuard(CFG, site, scan) {
  'use strict';

  if (window.top !== window || window.__walledInstalled) return;
  const sendSelector = site.sendSelectors.join(',');
  const composerSelector = site.composerSelectors.join(',');
  // Invalid protection selectors must surface as a preload failure before the page can be used.
  document.querySelector(`${sendSelector},${composerSelector}`);
  window.__walledInstalled = true;

  const dbg = (...a) => { if (CFG.debug) console.log('[walled-dlp]', ...a); };

  const replayedEvents = new WeakSet();
  let promptPending = false;
  let replayButton = null;
  let replaySubmission = null;
  let holdEnterRelease = false;
  let pageGeneration = 0;
  window.addEventListener('pagehide', () => { pageGeneration += 1; }, true);

  function samePage() {
    const url = location.href;
    const generation = pageGeneration;
    return () => generation === pageGeneration && url === location.href;
  }

  const dispatchReplay = (target, event) => {
    replayedEvents.add(event);
    try { target.dispatchEvent(event); } finally { replayedEvents.delete(event); }
  };
  const swallow = (event) => { event.preventDefault(); event.stopImmediatePropagation(); };

  /* ------------------------------------------------------------------ bridge */
  async function ask(message) {
    if (typeof scan !== 'function') {
      console.warn('[walled-dlp] Python bridge unavailable. Action blocked.');
      return false;
    }
    try {
      const reply = await scan(message);
      if (reply?.error) console.warn('[walled-dlp] Inspection failed. Action blocked.');
      return reply?.allow === true && !reply.error;
    } catch {
      console.warn('[walled-dlp] Python bridge error. Action blocked.');
      return false;
    }
  }

  /* ------------------------------------------------------- 3. response colour */
  function installResponseColor() {
    if (!site.responseSelectors.length || !globalThis.CSS?.supports?.('color', CFG.color)) return;
    const answer = `:is(${site.responseSelectors.join(', ')})`;
    const excludedSelectors = [...site.userMessageSelectors, ...site.composerSelectors];
    const excluded = `:is(${excludedSelectors.join(', ')})`;
    // Skip enclosures of user content too, since text colour inherits.
    const scope = excludedSelectors.length ? `:not(${excluded}, ${excluded} *, :has(${excluded}))` : '';
    const css =
      `:root:root:root ${answer}${scope}, :root:root:root ${answer} *${scope} {` +
      ` color: ${CFG.color} !important;` +
      ` -webkit-text-fill-color: ${CFG.color} !important; }`;
    let apply;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      apply = () => {
        if (!document.adoptedStyleSheets.includes(sheet)) {
          document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        }
      };
      apply();
    } catch (err) {
      const style = document.createElement('style');
      style.textContent = css;
      apply = () => {
        if (!style.isConnected) (document.head || document.documentElement)?.appendChild(style);
      };
      apply();
    }
    // CSS also matches streamed nodes added after this document has loaded.
    document.addEventListener('DOMContentLoaded', apply, { once: true });
    window.addEventListener('pageshow', apply);
  }

  /* ------------------------------------------------------------ 2. file hooks */
  const canScanFileEvent = (event) => event.isTrusted || !CFG.requireTrustedFileEvents;
  const readBase64 = (file) =>
    new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        const comma = typeof result === 'string' ? result.indexOf(',') : -1;
        resolve(comma >= 0 && result.slice(0, comma).endsWith(';base64') ? result.slice(comma + 1) : null);
      };
      reader.onerror = () => resolve(null);
      reader.onabort = () => resolve(null);
      reader.readAsDataURL(new Blob([file]));
    });

  async function filterFiles(files, isCurrent) {
    const allowed = [];
    for (const file of new Set(files)) {
      if (!isCurrent()) break;
      const { name, type: mimeType, size, lastModified } = file;
      let snapshot = null;
      let b64 = null;
      if (size <= CFG.maxFileBytes) {
        try {
          const bytes = await file.arrayBuffer();
          if (bytes.byteLength !== size) throw new Error('File size changed while reading');
          // Replay a memory-backed copy of the exact bytes sent to Python.
          snapshot = new File([bytes], name, { type: mimeType, lastModified });
          b64 = await readBase64(snapshot);
        } catch {
          console.warn('[walled-dlp] File read failed.');
        }
      }
      if (!isCurrent()) break;
      const approved = await ask({ kind: 'file', site: site.name, name, mimeType, size, b64 });
      if (approved && snapshot && b64 !== null) allowed.push(snapshot);
    }
    return allowed;
  }

  const toDataTransfer = (files) => {
    const transfer = new DataTransfer();
    files.forEach((file) => transfer.items.add(file));
    return transfer;
  };

  const warnUpload = () => console.warn('[walled-dlp] File selection blocked.');

  // A native picker emits input and change for one selection.
  const pendingInputs = new WeakMap();
  function onFileInput(event) {
    if (replayedEvents.has(event)) return;
    const input = event.composedPath()[0];
    if (!(input instanceof HTMLInputElement) || input.type !== 'file') return;

    const pending = pendingInputs.get(input);
    const selected = input.files;
    if (!selected?.length || selected === pending?.approved) {
      if (pending) event.stopImmediatePropagation();
      return;
    }

    event.stopImmediatePropagation();
    if (!canScanFileEvent(event)) {
      input.value = '';
      return;
    }

    inspectFileSelection(input, Array.from(selected));
  }

  function inspectFileSelection(input, files) {
    const selection = { approved: null };
    pendingInputs.set(input, selection);
    // Remove the unscanned selection before the browser emits its paired change.
    input.value = '';
    const inPage = samePage();
    const isCurrent = () => inPage() && pendingInputs.get(input) === selection && input.isConnected && input.type === 'file';

    void filterFiles(files, isCurrent).then((allowed) => {
      if (!allowed.length || !isCurrent() || input.files?.length) return;
      input.files = toDataTransfer(allowed).files;
      selection.approved = input.files;
      const replayed = Array.from(input.files);
      dispatchReplay(input, new Event('input', { bubbles: true, composed: true }));
      if (isCurrent() && input.files === selection.approved && input.files.length === replayed.length
        && replayed.every((file, index) => input.files[index] === file)) {
        dispatchReplay(input, new Event('change', { bubbles: true }));
      }
    }).catch(warnUpload).finally(() => {
      if (pendingInputs.get(input) === selection) pendingInputs.delete(input);
    });
  }
  window.addEventListener('input', onFileInput, true);
  window.addEventListener('change', onFileInput, true);

  function filesInTransfer(transfer) {
    if (!transfer) return null;
    if (transfer.files.length) return Array.from(transfer.files);
    const items = Array.from(transfer.items).filter((item) => item.kind === 'file');
    if (items.length) return items.map((item) => item.getAsFile()).filter(Boolean);
    return transfer.types.includes('Files') ? [] : null;
  }

  function hasUnsupportedFileData(transfer) {
    if (!transfer) return false;
    if (transfer.types.some((type) => /^(?:image\/|audio\/|video\/|application\/(?:pdf|octet-stream)$)/i.test(type))) {
      return true;
    }

    // Some clipboard producers embed an image or local URL in HTML instead of exposing a File.
    const fileReference = /(?:^|[\s,'"(])(?:data|blob|file|filesystem|cid):/i;
    const looksLikeFile = (value) => fileReference.test(value.replace(/[\t\r\n]/g, '').trim());
    const uriList = transfer.getData('text/uri-list');
    if (uriList.split(/\r?\n/).some((line) => !line.startsWith('#') && looksLikeFile(line))) return true;
    const html = transfer.getData('text/html');
    if (!html) return false;
    if (html.length > CFG.maxFileBytes) return true;

    // A detached template keeps copied markup inert while decoding HTML entity references.
    const template = document.implementation.createHTMLDocument().createElement('template');
    template.innerHTML = html;
    const attributes = ['src', 'srcset', 'href', 'xlink:href', 'poster', 'data', 'background', 'style'];
    if (template.content.querySelector('svg')) return true;
    const resources = attributes.map((attribute) => `[${CSS.escape(attribute)}]`).join(',');
    return Array.from(template.content.querySelectorAll(resources)).some((element) =>
      attributes.some((attribute) => looksLikeFile(element.getAttribute(attribute) ?? '')));
  }

  function onFileTransfer(event) {
    if (replayedEvents.has(event)) return;
    const drop = event.type === 'drop';
    const transfer = drop ? event.dataTransfer : event.clipboardData;
    let files;
    try {
      files = filesInTransfer(transfer);
      if (files === null) {
        if (hasUnsupportedFileData(transfer)) {
          swallow(event);
          warnUpload();
        }
        return;
      }
    } catch {
      swallow(event);
      warnUpload();
      return;
    }
    swallow(event);
    if (!canScanFileEvent(event)) return;

    const source = event.composedPath()[0];
    if (drop && source instanceof HTMLInputElement && source.type === 'file') {
      // A synthetic drop does not run the browser's default file-picker action.
      if (files.length && !source.disabled) inspectFileSelection(source, source.multiple ? files : files.slice(0, 1));
      return;
    }
    const target = source instanceof Node ? source : document.body;
    const inPage = samePage();
    const isCurrent = () => inPage() && target?.isConnected && (target === document || target.ownerDocument === document);
    const { clientX, clientY } = event;

    void filterFiles(files, isCurrent).then((allowed) => {
      if (!isCurrent()) return;
      if (!allowed.length) {
        if (drop) dispatchReplay(target, new DragEvent('dragleave', { bubbles: true, composed: true }));
        return;
      }

      const approvedTransfer = toDataTransfer(allowed);
      const options = { bubbles: true, cancelable: true, composed: true };
      if (drop) {
        dispatchReplay(target, new DragEvent('drop', { ...options, clientX, clientY, dataTransfer: approvedTransfer }));
      } else {
        dispatchReplay(target, new ClipboardEvent('paste', { ...options, clipboardData: approvedTransfer }));
      }
    }).catch(warnUpload);
  }
  window.addEventListener('drop', onFileTransfer, true);
  window.addEventListener('paste', onFileTransfer, true);

  /* ---------------------------------------------------------- 1. prompt hooks */
  function findEditable(node) {
    let el = node instanceof Element ? node : node && node.parentElement;
    while (el) {
      if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search)$/i.test(el.type))) return el;
      if (el.isContentEditable) {
        while (el.parentElement && el.parentElement.isContentEditable) el = el.parentElement;
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  const readText = (el) => ('value' in el && typeof el.value === 'string') ? el.value : (el.innerText || el.textContent || '');

  const isSendEnabled = (button) => !button.disabled && button.getAttribute('aria-disabled') !== 'true';
  const formOf = (element) => element.form || element.closest('form');

  function visibleComposers() {
    const editors = Array.from(document.querySelectorAll(composerSelector), findEditable);
    return [...new Set(editors.filter((editable) => editable?.getClientRects().length))];
  }

  function composersForButton(button, composers = visibleComposers()) {
    const form = formOf(button);
    const owned = form ? composers.filter((editable) => formOf(editable) === form) : [];
    return owned.length ? owned : composers;
  }

  function findSendButton(editable) {
    const visible = visibleComposers();
    const scopes = [formOf(editable), document].filter(Boolean);
    for (const scope of scopes) {
      for (const sel of site.sendSelectors) {
        for (const button of scope.querySelectorAll(sel)) {
          if (!isSendEnabled(button) || !button.getClientRects().length) continue;
          const composers = composersForButton(button, visible);
          if (composers.length === 1 && composers[0] === editable) {
            return button;
          }
        }
      }
    }
    return null;
  }

  async function guardPrompt(editable, text, resume) {
    if (promptPending) return;
    promptPending = true;
    const inPage = samePage();
    try {
      const approved = await ask({ kind: 'prompt', site: site.name, text });
      if (approved && inPage() && editable.isConnected && readText(editable) === text) {
        resume();
      }
    } catch {
      console.warn('[walled-dlp] Prompt could not be resumed.');
    } finally {
      promptPending = false;
    }
  }

  const needsScan = (text, trusted) => text.includes(CFG.marker) || (trusted && CFG.inspectCleanPrompts !== false);

  function withApprovedSubmit(form, submitter, editable, action) {
    replaySubmission = { form, submitter, editable, text: readText(editable) };
    try { action(); } finally { replaySubmission = null; }
  }

  function replaySend(button, editable) {
    if (!button.isConnected || !isSendEnabled(button)) return;
    const composers = composersForButton(button);
    if (composers.length !== 1 || composers[0] !== editable) return;
    replayButton = button;
    try {
      withApprovedSubmit(formOf(button), button, editable, () => button.click());
    } finally {
      replayButton = null;
    }
  }

  function requestSubmit(form, submitter, editable) {
    if (!form.isConnected || formOf(editable) !== form || (submitter && submitter.form !== form)) return;
    withApprovedSubmit(form, submitter, editable,
      () => HTMLFormElement.prototype.requestSubmit.call(form, submitter ?? undefined));
  }

  function holdSubmission(event, composers, resume) {
    const editable = composers.find((candidate) => needsScan(readText(candidate), event.isTrusted));
    if (!editable) return;
    swallow(event);
    // An ambiguous button or form cannot be safely replayed for one of several drafts.
    if (event.isTrusted && composers.length === 1) {
      void guardPrompt(editable, readText(editable), () => resume(editable));
    }
  }

  // Enter key in the prompt box.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || replayedEvents.has(e)) return;
    if (e.isTrusted && !e.repeat) holdEnterRelease = false;
    if (e.isTrusted && e.repeat && holdEnterRelease) {
      swallow(e);
      return;
    }
    if (e.shiftKey || e.altKey || e.isComposing) return;
    const editable = findEditable(e.composedPath()[0]);
    if (!editable || !editable.closest(composerSelector)) return;
    const text = readText(editable);
    if (!needsScan(text, e.isTrusted)) return;
    swallow(e);
    if (!e.isTrusted || e.repeat) return;
    holdEnterRelease = true;
    void guardPrompt(editable, text, () => {
      const button = findSendButton(editable);
      if (button) return replaySend(button, editable);
      const form = formOf(editable);
      if (form && editable instanceof HTMLInputElement) return requestSubmit(form, null, editable);
      const replay = new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true,
      });
      withApprovedSubmit(form, null, editable, () => dispatchReplay(editable, replay));
    });
  }, true);

  window.addEventListener('keyup', (e) => {
    if (e.key === 'Enter' && e.isTrusted && holdEnterRelease) {
      holdEnterRelease = false;
      swallow(e);
    }
  }, true);

  // Click on the send button.
  window.addEventListener('click', (e) => {
    const button = e.composedPath().find((target) => target instanceof Element && target.matches(sendSelector));
    if (!button) return;
    if (!e.isTrusted && button === replayButton) {
      replayButton = null;
      return;
    }
    holdSubmission(e, composersForButton(button), (editable) => replaySend(button, editable));
  }, true);

  // Covers implicit form submission and submit controls outside the configured button selectors.
  window.addEventListener('submit', (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    const composers = visibleComposers().filter((editable) => formOf(editable) === form);
    const submitter = e.submitter ?? null;
    const approval = replaySubmission;
    if (approval && approval.form === form && approval.submitter === submitter
      && composers.length === 1 && composers[0] === approval.editable
      && readText(approval.editable) === approval.text) {
      replaySubmission = null;
      return;
    }
    holdSubmission(e, composers, (editable) => requestSubmit(form, submitter, editable));
  }, true);

  /* -------------------------------------------------------------------- init */
  installResponseColor();
  dbg('installed on', site.name);
}

if (typeof module === 'object' && module.exports) module.exports = { installWalledGuard };
