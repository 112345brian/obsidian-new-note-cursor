import type { TAbstractFile, TFile } from 'obsidian';

import { MarkdownView } from 'obsidian';
import { PluginBase } from 'obsidian-dev-utils/obsidian/plugin/plugin-base';

import type { PluginTypes } from './PluginTypes.ts';

import { PluginSettingsManager } from './PluginSettingsManager.ts';
import { PluginSettingsTab } from './PluginSettingsTab.ts';

// How long after creation we'll still treat a file-open as "new note"
const NEW_FILE_TTL_MS = 5_000;

export class Plugin extends PluginBase<PluginTypes> {
  private readonly recentlyCreated = new Map<string, number>();

  protected override createSettingsManager(): PluginSettingsManager {
    return new PluginSettingsManager(this);
  }

  protected override createSettingsTab(): null | PluginSettingsTab {
    return new PluginSettingsTab(this);
  }

  protected override async onloadImpl(): Promise<void> {
    await super.onloadImpl();

    // Record every newly created markdown file with a timestamp
    this.registerEvent(
      this.app.vault.on('create', this.handleCreate.bind(this))
    );

    // When the workspace opens a file, check if it was just created
    this.registerEvent(
      this.app.workspace.on('file-open', this.handleFileOpen.bind(this))
    );
  }

  public handleCreate(file: TAbstractFile): void {
    if (file.path.endsWith('.md')) {
      this.recentlyCreated.set(file.path, Date.now());
    }
  }

  public handleFileOpen(file: TFile | null): void {
    if (!file) {
      return;
    }

    const createdAt = this.recentlyCreated.get(file.path);
    if (createdAt === undefined) {
      return;
    }

    // Discard entries from before this session (e.g. crash-recovery reopens)
    if (Date.now() - createdAt > NEW_FILE_TTL_MS) {
      this.recentlyCreated.delete(file.path);
      return;
    }

    this.recentlyCreated.delete(file.path);

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.file?.path !== file.path) {
      return;
    }

    this.applyPosition(view);
  }

  public getBodyStart(view: MarkdownView): { ch: number; line: number } {
    const editor = view.editor;

    // Skip YAML frontmatter: opening --- on line 0, find the closing ---
    if (editor.lineCount() > 1 && editor.getLine(0).trim() === '---') {
      for (let i = 1; i < editor.lineCount(); i++) {
        if (editor.getLine(i).trim() === '---') {
          let bodyLine = i + 1;
          // Skip one empty line if present (standard blank line after frontmatter)
          if (bodyLine < editor.lineCount() && editor.getLine(bodyLine).trim() === '') {
            bodyLine += 1;
          }
          return { ch: 0, line: Math.min(bodyLine, editor.lineCount() - 1) };
        }
      }
    }

    return { ch: 0, line: 0 };
  }

  public applyPosition(view: MarkdownView): void {
    const { cursorPosition } = this.settings;

    if (cursorPosition === 'title') {
      // Put cursor at end of inline title — works on desktop and mobile
      view.leaf.setEphemeralState({ rename: 'end' });
      return;
    }

    if (cursorPosition === 'title-highlighted') {
      // Select entire title so typing immediately overwrites it.
      // Uses the same API Templater uses for the same effect.
      view.leaf.setEphemeralState({ rename: 'all' });
      return;
    }

    if (cursorPosition === 'body') {
      view.editor.focus();
      view.editor.setCursor(this.getBodyStart(view));
    }
  }
}
