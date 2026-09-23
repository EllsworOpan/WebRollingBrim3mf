import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], base: process.env.BASE_PATH || '/', assetsInclude: ['**/*.stl'], worker: { format: 'es' }, test: { environment: 'node', testTimeout: 30000 } });
