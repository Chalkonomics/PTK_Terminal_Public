import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: 'src/renderer',
  base: './',
  // Sound files: served at ./<file> in dev and copied into the build.
  publicDir: here('./effects'),
  // Tailwind only processes CSS that imports it (the dashboard's); the panel keeps plain CSS.
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': here('./src/renderer/dashboard') } },
  server: { port: 5173, strictPort: true },
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    // One page per window.
    rolldownOptions: {
      input: {
        panel: here('./src/renderer/index.html'),
        dashboard: here('./src/renderer/dashboard.html'),
      },
    },
  },
});
