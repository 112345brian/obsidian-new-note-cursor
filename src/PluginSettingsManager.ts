import { PluginSettingsManagerBase } from 'obsidian-dev-utils/obsidian/plugin/plugin-settings-manager-base';

import type { PluginTypes } from './PluginTypes.ts';

import { PluginSettings } from './PluginSettings.ts';

export class PluginSettingsManager extends PluginSettingsManagerBase<PluginTypes> {
  protected override createDefaultSettings(): PluginSettings {
    return new PluginSettings();
  }

  protected override async onLoadRecord(record: Record<string, unknown>): Promise<void> {
    await super.onLoadRecord(record);

    // Migrate from v0.1.x: single `cursorPosition` → `onCreate`
    if (record['cursorPosition'] !== undefined && record['onCreate'] === undefined) {
      record['onCreate'] = record['cursorPosition'];
    }
  }
}
