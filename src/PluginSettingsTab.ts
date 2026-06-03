import { PluginSettingsTabBase } from 'obsidian-dev-utils/obsidian/plugin/plugin-settings-tab-base';
import { SettingEx } from 'obsidian-dev-utils/obsidian/setting-ex';

import type { PluginTypes } from './PluginTypes.ts';

export class PluginSettingsTab extends PluginSettingsTabBase<PluginTypes> {
  public override display(): void {
    super.display();
    this.containerEl.empty();

    new SettingEx(this.containerEl)
      .setName('Cursor position on new note')
      .setDesc('Where the cursor should land after a new note is created.')
      .addDropdown((dropdown) => {
        dropdown.addOptions({
          'title': 'At the title (default)',
          'body': 'Beginning of the body',
          'title-highlighted': 'Title highlighted (typing overwrites it)',
        });
        this.bind(dropdown, 'cursorPosition');
      });
  }
}
