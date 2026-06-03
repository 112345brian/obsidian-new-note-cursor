import { PluginSettingsTabBase } from 'obsidian-dev-utils/obsidian/plugin/plugin-settings-tab-base';
import { SettingEx } from 'obsidian-dev-utils/obsidian/setting-ex';

import type { PluginTypes } from './PluginTypes.ts';

const POSITION_OPTIONS = {
  'title': 'At the title',
  'body': 'Beginning of the body',
  'end': 'End of the note',
  'title-highlighted': 'Title highlighted (typing overwrites it)',
};

export class PluginSettingsTab extends PluginSettingsTabBase<PluginTypes> {
  public override display(): void {
    super.display();
    this.containerEl.empty();

    new SettingEx(this.containerEl)
      .setName('On note creation')
      .setDesc('Where the cursor lands when a new note is created. Override per note with cursor-position: <value> in frontmatter.')
      .addDropdown((dropdown) => {
        dropdown.addOptions(POSITION_OPTIONS);
        this.bind(dropdown, 'onCreate');
      });

    new SettingEx(this.containerEl)
      .setName('On note open')
      .setDesc('Where the cursor lands when an existing note is opened. "None" leaves the cursor wherever Obsidian puts it. Override per note with cursor-position: <value> in frontmatter.')
      .addDropdown((dropdown) => {
        dropdown.addOptions({ 'none': 'None (don\'t move cursor)', ...POSITION_OPTIONS });
        this.bind(dropdown, 'onOpen');
      });
  }
}
