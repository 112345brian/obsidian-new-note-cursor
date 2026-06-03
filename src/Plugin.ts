import type { TAbstractFile, TFile } from 'obsidian';

import { MarkdownView } from 'obsidian';
import { PluginBase } from 'obsidian-dev-utils/obsidian/plugin/plugin-base';

import type { PluginTypes } from './PluginTypes.ts';

import { PluginSettingsManager } from './PluginSettingsManager.ts';
import { PluginSettingsTab } from './PluginSettingsTab.ts';

// How long after creation we'll still treat a file-open as "new note"
const NEW_FILE_TTL_MS = 5000;

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

    // Track newly created files
    this.registerEvent(
      this.app.vault.on('create', this.handleCreate.bind(this))
    );

    // When a file is opened in the editor, check if it was just created
    this.registerEvent(
      this.app.workspace.on('file-open', this.handleFileOpen.bind(this))
    );
  }

  private handleCreate(file: TAbstractFile): void {
    if (file.path.endsWith('.md')) {
      this.recentlyCreated.set(file.path, Date.now());
    }
  }

  private handleFileOpen(file: TFile | null): void {
    if (!file) {
      return;
    }

    const createdAt = this.recentlyCreated.get(file.path);
    if (createdAt === undefined) {
      return;
    }

    // Ignore stale entries (e.g. vault reload after a crash)
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

  private getBodyStart(view: MarkdownView): { ch: number; line: number } {
    const editor = view.editor;
    // If the note opens with a YAML frontmatter block, skip past it
    if (editor.lineCount() > 1 && editor.getLine(0) === '---') {
      for (let i = 1; i < editor.lineCount(); i++) {
        if (editor.getLine(i) === '---') {
          const bodyLine = i + 1;
          return { ch: 0, line: Math.min(bodyLine, editor.lineCount() - 1) };
        }
      }
    }
    return { ch: 0, line: 0 };
  }

  private applyPosition(view: MarkdownView): void {
    const { cursorPosition } = this.settings;

    if (cursorPosition === 'title') {
      const titleEl = view.containerEl.querySelector<HTMLElement>('.inline-title');
      titleEl?.focus();
      return;
    }

    if (cursorPosition === 'title-highlighted') {
      const titleEl = view.containerEl.querySelector<HTMLElement>('.inline-title');
      if (titleEl) {
        titleEl.focus();
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          range.selectNodeContents(titleEl);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
      return;
    }

    if (cursorPosition === 'body') {
      view.editor.focus();
      view.editor.setCursor(this.getBodyStart(view));
    }
  }
}
