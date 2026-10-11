import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/** Unit / owner-flow tests for pure admin modules (no Vue mount). */
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
