import { PluginSettingsTabBase } from 'obsidian-dev-utils/obsidian/plugin/plugin-settings-tab-base';
import { SettingEx } from 'obsidian-dev-utils/obsidian/setting-ex';

import type { PluginTypes } from './PluginTypes.ts';

const POSITION_OPTIONS = {
  'body': 'Beginning of the body',
  'end': 'End of the note',
  'title': 'At the title',
  'title-highlighted': 'Title highlighted (typing overwrites it)'
};

export class PluginSettingsTab extends PluginSettingsTabBase<PluginTypes> {
public override display(): void {
    super.display();
    this.containerEl.empty();

    // Split into two statements so separatorSetting is fully assigned before addText's
    // Callback runs and references it via updateDesc (avoids temporal dead zone crash).
    const separatorSetting = new SettingEx(this.containerEl)
      .setName('Title separator');

    separatorSetting.setDesc(
      'Only applies to "Title highlighted" mode. '
      + 'When the title is fully selected, pressing the first character of this string '
      + 'appends it instead of replacing the title. '
      + 'Example: a space gives "20260604 My Note", " - " gives "20260604 - My Note". '
      + 'Leave empty to disable.'
    );

    const bodySetting = new SettingEx(this.containerEl)
      .setName('Title → body key')
      .setDesc(
        'Only applies to "Title highlighted" mode. '
        + 'When the title is fully selected, pressing this key moves the cursor '
        + 'directly to the body. Example: Enter. Leave empty to disable.'
      );

    bodySetting.addText((text) => {
      text.setPlaceholder('Example: enter key name');
      this.bind(text, 'titleBodyKey');

      text.inputEl.value = text.inputEl.value.replace(/ /g, '␣');

      text.inputEl.addEventListener('focus', () => {
        text.inputEl.value = text.inputEl.value.replace(/␣/g, ' ');
      });

      text.inputEl.addEventListener('blur', () => {
        text.inputEl.value = text.inputEl.value.replace(/ /g, '␣');
      });
    });

    separatorSetting.addText((text) => {
      text.setPlaceholder('Space, " - ", "_", …');
      // Let bind handle load/save as normal.
      this.bind(text, 'titleSeparator');

      // After bind sets the initial value, replace spaces with ␣ for display.
      // Setting .value directly does not fire input/change events, so bind
      // Never sees the ␣ character — only the real value on actual edits.
      text.inputEl.value = text.inputEl.value.replace(/ /g, '␣');

      text.inputEl.addEventListener('focus', () => {
        // Restore real spaces so the user edits the actual value.
        text.inputEl.value = text.inputEl.value.replace(/␣/g, ' ');
      });

      text.inputEl.addEventListener('blur', () => {
        // Back to visual form without triggering a save.
        text.inputEl.value = text.inputEl.value.replace(/ /g, '␣');
      });
    });

    new SettingEx(this.containerEl)
      .setName('On note creation')
      .setDesc(
        'Where the cursor lands when a new note is created. '
        + 'Override per note with cursor-position-create: <value> in frontmatter '
        + '(or cursor-position: <value> as a fallback for both events).'
      )
      .addDropdown((dropdown) => {
        dropdown.addOptions(POSITION_OPTIONS);
        this.bind(dropdown, 'onCreate');
      });

    new SettingEx(this.containerEl)
      .setName('On note open')
      .setDesc(
        'Where the cursor lands when an existing note is opened. '
        + '"None" leaves the cursor wherever Obsidian puts it. '
        + 'Override per note with cursor-position-open: <value> in frontmatter.'
      )
      .addDropdown((dropdown) => {
        dropdown.addOptions({ none: 'None (don\'t move cursor)', ...POSITION_OPTIONS });
        this.bind(dropdown, 'onOpen');
      });

    new SettingEx(this.containerEl)
      .setName('Excluded folders')
      .setDesc(
        'Notes inside these folders will never have their cursor moved. '
        + 'One folder path per line. Example: Templates'
      )
      .addMultipleText((multipleText) => {
        multipleText.setPlaceholder('Templates');
        this.bind(multipleText, 'excludedFolders');
      });
  }
}
