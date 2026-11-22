# Walled DLP

Walled DLP embeds ChatGPT and Perplexity in an Electron desktop app. A React toolbar switches between
the two persistent browser sessions. The TypeScript main process forwards inspection requests to the
existing Python backend over newline-delimited JSON on stdin and stdout.

The site preload holds marked prompts and selected files before handing them to the website. If Python
finds `WALLED_SENSITIVE`, it shows the native Continue/Cancel dialog. The preload releases only the
prompt or file the backend approved.

## Start the desktop app

Use Node.js 22.12+ and Python 3.9+. From the repository root on macOS or Linux:

```sh
python3 -m venv server/.venv
server/.venv/bin/python -m pip install -r server/requirements.txt
cd react
npm ci
npm start
```

On Windows, create the environment with `py -3 -m venv server/.venv` and install the Python requirements
with `server/.venv/Scripts/python.exe`. The desktop build and launcher select `WALLED_PYTHON`, then
the environment under `server/.venv`, then the system interpreter. Set `WALLED_PYTHON` to an absolute
interpreter path to use a different environment.

Use `npm run dev` in `react/` to launch Electron with the Vite toolbar dev server on loopback. Open the
desired site from the toolbar. Each site keeps its login in a separate Electron profile across restarts.

RapidOCR handles image and scanned PDF text. The optional Tesseract fallback uses the system
`tesseract` executable and the `pytesseract` Python package. Linux uses Zenity, KDialog or Tk
for confirmation. Windows uses Tk and macOS uses the system dialog through `osascript`.

## Package for macOS

On an Apple Silicon Mac running macOS 14 or later with native ARM64 Node.js 22.12+, run from the repository root:

```sh
cd react
npm ci
npm run dist
```

Open `react/dist/mac-arm64/Walled DLP.app` in Finder. The build downloads a checksum-verified
standalone CPython runtime, installs the backend's production Python dependencies, and fetches the
default RapidOCR models. The app includes those files and uses macOS's built-in `osascript` for
confirmation dialogs. It can launch without a separate Python installation or the development `.venv`.

This build is ad-hoc signed for local use. Distribution to other Macs through Gatekeeper requires
Developer ID signing and Apple notarization.

## Try the guard

- Send a prompt without the marker. The site submits it normally and the answer uses the configured colour.
- Type `Summarise WALLED_SENSITIVE notes` and press Enter or click Send. Cancel keeps the draft in the
  composer. Continue submits the approved draft.
- Attach a text file containing the marker using the picker, drag-and-drop, or a file-bearing paste.
  In a multi-file selection, Cancel drops only the file being reviewed. Other approved files proceed.

Python inspects supported text, PDF, image and ZIP-based files, including DOCX, XLSX and PPTX. It blocks
uploads that exceed 30 MiB, encrypted PDFs, PDFs with embedded files, unsupported files and files it
cannot fully inspect.
The guard covers the composer and attachment actions in the embedded tabs. Site markup changes may
require updates to the input selectors in `server/dlp/inject/config.json` or the response selectors in
`server/dlp/config.py`. Rebuild Electron after changing the colour or selectors.

## Maintain the Python backend independently

From `server/`, run `.venv/bin/python -m dlp.server --no-ocr-warmup` for an interactive stdio session
(use `.venv/Scripts/python.exe` on Windows). The server writes a `ready` event followed by one JSON
reply per request. Enter `{"id":1,"op":"ping"}`, wait for its reply, then enter
`{"id":2,"op":"shutdown"}` to exit. The server also supports `prompt`, `file`, `request`, and
`init_script`. Diagnostics go to stderr.

## Project layout

| Path | Role |
|---|---|
| `react/src/` | React toolbar |
| `react/electron/` | Main process, embedded views, isolated preloads and Python process manager |
| `server/dlp/server.py` | Python stdio IPC server |
| `server/dlp/guard.py`, `scanner.py`, `ocr.py` | Inspection policy, file scanning and OCR |
| `server/dlp/dialog.py`, `dialog_tk.py` | Native Continue/Cancel dialog |
| `server/dlp/inject/` | Shared page hooks and document configuration |

## Checks

From `server/`, install `requirements-dev.txt` into the Python environment and run
`python -m pytest tests` for scanner, dialog, guard and IPC checks.

From `react/`, use `npm run typecheck` and `npm run test:unit`. The Electron end-to-end suite uses
the JavaScript Playwright development dependency to drive the installed Electron app against local
mock pages. On Linux, `npm run test:e2e` uses `xvfb-run`. On macOS, run
`npm run build && node test/e2e.mjs` from a desktop session.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the process boundaries and inspection flow.
