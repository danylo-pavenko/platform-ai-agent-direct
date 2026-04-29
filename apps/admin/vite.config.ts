import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';

export default defineConfig(({ mode }) => {
  // Load all root .env vars (including non-VITE_ ones) so we can forward
  // BRAND_NAME into the build without requiring a duplicate VITE_BRAND_NAME field.
  const env = loadEnv(mode, resolve(__dirname, '..', '..'), '');

  return {
  plugins: [vue()],
  envDir: resolve(__dirname, '..', '..'),
  define: {
    'import.meta.env.VITE_BRAND_NAME': JSON.stringify(env.BRAND_NAME || 'AI Agent Platform'),
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 3101,
    proxy: {
      '/api': {
        target: 'http://localhost:3100',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  };
});
