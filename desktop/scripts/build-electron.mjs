// Bundles the Electron main process and the two preload scripts into dist-electron/*.cjs.
// Preloads run sandboxed, so each must be a single self-contained file that only requires 'electron'.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const backendRoot = fileURLToPath(new URL('../../server/', import.meta.url));
const venv = process.platform === 'win32'
  ? path.join(backendRoot, '.venv', 'Scripts', 'python.exe')
  : path.join(backendRoot, '.venv', 'bin', 'python');
const systemPython = process.platform === 'win32' ? 'python' : 'python3';
const python = process.env.WALLED_PYTHON || (existsSync(venv) ? venv : systemPython);
const responseStyle = execFileSync(python, [
  '-B', '-c', 'import json; from dlp.config import response_style_config; print(json.dumps(response_style_config()))',
], { cwd: backendRoot, encoding: 'utf8' }).trim();

await build({
  entryPoints: {
    main: 'electron/main.ts',
    'preload-shell': 'electron/preload-shell.ts',
    'preload-site': 'electron/preload-site.ts',
  },
  outdir: 'dist-electron',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  define: { __WALLED_RESPONSE_STYLE__: responseStyle },
  sourcemap: true,
  logLevel: 'info',
});
