import type { TAbstractFile, TFile } from 'obsidian';

import { MarkdownView } from 'obsidian';
import { PluginBase } from 'obsidian-dev-utils/obsidian/plugin/plugin-base';

import type { CursorPosition } from './PluginSettings.ts';
import type { PluginTypes } from './PluginTypes.ts';

import { PluginSettingsManager } from './PluginSettingsManager.ts';
import { PluginSettingsTab } from './PluginSettingsTab.ts';

// How long after creation we'll still treat a file-open as "new note"
const NEW_FILE_TTL_MS = 5_000;

// Frontmatter key users can set in individual notes to override the global setting.
// Example: cursor-position: body
export const FRONTMATTER_KEY = 'cursor-position';

const VALID_POSITIONS: readonly CursorPosition[] = ['title', 'body', 'end', 'title-highlighted'];

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

    this.registerEvent(
      this.app.vault.on('create', this.handleCreate.bind(this))
    );

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

  // Read cursor-position from the note's own frontmatter, parsed directly
  // from editor lines so there's no metadata-cache timing risk on fresh files.
  public getFrontmatterOverride(view: MarkdownView): CursorPosition | null {
    const editor = view.editor;

    if (editor.lineCount() < 2 || editor.getLine(0).trim() !== '---') {
      return null;
    }

    for (let i = 1; i < editor.lineCount(); i++) {
      const line = editor.getLine(i);

      // Stop at closing delimiter
      if (line.trim() === '---') {
        break;
      }

      const match = /^cursor-position:\s*["']?([^"'\s]+)["']?/.exec(line);
      if (match) {
        const value = match[1] as CursorPosition;
        if (VALID_POSITIONS.includes(value)) {
          return value;
        }
      }
    }

    return null;
  }

  public getBodyStart(view: MarkdownView): { ch: number; line: number } {
    const editor = view.editor;

    if (editor.lineCount() > 1 && editor.getLine(0).trim() === '---') {
      for (let i = 1; i < editor.lineCount(); i++) {
        if (editor.getLine(i).trim() === '---') {
          let bodyLine = i + 1;
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
    const cursorPosition = this.getFrontmatterOverride(view) ?? this.settings.cursorPosition;

    if (cursorPosition === 'title') {
      view.leaf.setEphemeralState({ rename: 'end' });
      return;
    }

    if (cursorPosition === 'title-highlighted') {
      view.leaf.setEphemeralState({ rename: 'all' });
      return;
    }

    if (cursorPosition === 'body') {
      view.editor.focus();
      view.editor.setCursor(this.getBodyStart(view));
      return;
    }

    if (cursorPosition === 'end') {
      const editor = view.editor;
      const lastLine = editor.lineCount() - 1;
      editor.focus();
      editor.setCursor({ ch: editor.getLine(lastLine).length, line: lastLine });
    }
  }
}
