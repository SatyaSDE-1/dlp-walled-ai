// Bundles the Electron main process and the two preload scripts into dist-electron/*.cjs.
// Preloads run sandboxed, so each must be a single self-contained file that only requires 'electron'.
import { build } from 'esbuild';

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
  sourcemap: true,
  logLevel: 'info',
});
