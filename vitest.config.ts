import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Point `obsidian` and `obsidian-dev-utils` imports to our stubs so
      // tests run in Node without the Obsidian desktop runtime.
      obsidian: resolve(__dirname, 'src/__mocks__/obsidian.ts'),
      'obsidian-dev-utils/obsidian/plugin/plugin-base': resolve(__dirname, 'src/__mocks__/obsidian-dev-utils.ts'),
      'obsidian-dev-utils/obsidian/plugin/plugin-settings-manager-base': resolve(__dirname, 'src/__mocks__/obsidian-dev-utils.ts'),
      'obsidian-dev-utils/obsidian/plugin/plugin-settings-tab-base': resolve(__dirname, 'src/__mocks__/obsidian-dev-utils.ts'),
      'obsidian-dev-utils/obsidian/plugin/plugin-types-base': resolve(__dirname, 'src/__mocks__/obsidian-dev-utils.ts'),
      'obsidian-dev-utils/obsidian/setting-ex': resolve(__dirname, 'src/__mocks__/obsidian-dev-utils.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.*.ts', 'src/__mocks__/**'],
    },
  },
});
