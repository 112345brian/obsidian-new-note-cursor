import { configs } from './scripts/eslint-config.ts';

const pluginConfigs = [
  ...configs,
  {
    ignores: ['src/__mocks__/**', 'src/**/*.test.ts']
  },
  {
    // Config/build files run in Node and legitimately import Node builtins
    files: ['vitest.config.ts', 'scripts/**/*.ts'],
    rules: {
      'import-x/no-nodejs-modules': 'off'
    }
  },
  {
    // Obsidian-dev-utils@55 still uses display() — suppress until the framework migrates
    files: ['src/PluginSettingsTab.ts'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off'
    }
  }
];

export default pluginConfigs;
