import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** API paths the dev server forwards to the API started with `npm run dev` in the repo root. */
const API_PATHS = ['/api', '/me', '/companies', '/holding', '/admin'];
const API_URL = 'http://127.0.0.1:3000';

export default defineConfig({
  // served by the API under /app/ (src/http/web.ts); client routes live below it
  base: '/app/',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: {
    // a developer's machine only: never listen on other interfaces
    host: '127.0.0.1',
    proxy: Object.fromEntries(API_PATHS.map((p) => [p, { target: API_URL }])),
  },
});
