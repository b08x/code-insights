import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

// Pure-logic unit tests only (node environment, no DOM). Component tests would
// need jsdom + @testing-library, which the dashboard does not depend on yet.
export default defineConfig({
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/dist/**', '**/node_modules/**'],
  },
});
