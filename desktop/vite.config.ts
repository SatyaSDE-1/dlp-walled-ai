import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/** Strict CSP for the production shell page. Not applied in dev (Vite HMR needs inline scripts). */
function cspOnBuild(): Plugin {
  const csp =
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";
  return {
    name: 'walled-csp-on-build',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (html) => html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`),
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), cspOnBuild()],
  build: { outDir: 'dist-renderer', emptyOutDir: true, sourcemap: true },
  server: { port: 5173, strictPort: true },
});
