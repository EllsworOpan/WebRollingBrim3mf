import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  // Pages supplies the site's actual base path; local/Docker builds use root.
  // Vite applies this to the app bundle, worker, example model and public assets.
  base: process.env.BASE_PATH || '/',
  assetsInclude: ['**/*.stl'],
  worker: { format: 'es' },
  test: { environment: 'node', testTimeout: 30000 },
});
