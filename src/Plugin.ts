import type { TAbstractFile, TFile } from 'obsidian';

import { MarkdownView } from 'obsidian';
import { PluginBase } from 'obsidian-dev-utils/obsidian/plugin/plugin-base';

import type { CursorPosition, CursorPositionOrNone } from './PluginSettings.ts';
import type { PluginTypes } from './PluginTypes.ts';

import { PluginSettingsManager } from './PluginSettingsManager.ts';
import { PluginSettingsTab } from './PluginSettingsTab.ts';

const NEW_FILE_TTL_MS = 5_000;

export const FRONTMATTER_KEY = 'cursor-position';

const VALID_POSITIONS: readonly CursorPosition[] = ['title', 'body', 'end', 'title-highlighted'];

// Templater waits 300 ms before writing templates; we wait a bit longer.
const TEMPLATER_DEFER_MS = 350;

interface FileRecord {
  createdAt: number;
  // Snapshot of Templater state at vault.on('create') time — avoids a
  // second lookup at file-open time when the set may have changed.
  templaterWillProcess: boolean;
}

export class Plugin extends PluginBase<PluginTypes> {
  private readonly recentlyCreated = new Map<string, FileRecord>();

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
    if (!file.path.endsWith('.md')) {
      return;
    }

    // Snapshot Templater state right now, at creation time:
    //  - files_with_pending_templates: explicit template creation flow
    //  - trigger_on_file_creation: folder-trigger flow (Templater adds to the
    //    set only after its own 300ms delay, so we'd miss it at file-open time)
    this.recentlyCreated.set(file.path, {
      createdAt: Date.now(),
      templaterWillProcess: this.templaterWillProcess(file as TFile),
    });
  }

  public handleFileOpen(file: TFile | null): void {
    if (!file) {
      return;
    }

    const record = this.consumeRecord(file);
    const isNew = record !== null;

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.file?.path !== file.path) {
      return;
    }

    if (isNew && record.templaterWillProcess) {
      // Templater will write template content and place its own cursor.
      // Defer past its 300ms delay. Only apply if the template has an
      // explicit cursor-position key — otherwise Templater owns the cursor.
      window.setTimeout(() => {
        const fresh = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!fresh || fresh.file?.path !== file.path) {
          return;
        }
        const override = this.getFrontmatterOverride(fresh);
        if (override) {
          this.setCursorPosition(fresh, override);
        }
      }, TEMPLATER_DEFER_MS);
      return;
    }

    const position = this.resolvePosition(view, isNew);
    if (position !== 'none') {
      this.setCursorPosition(view, position);
    }
  }

  // Removes and returns the record if the file was recently created, or null.
  public consumeRecord(file: TFile): FileRecord | null {
    const record = this.recentlyCreated.get(file.path);
    if (!record) {
      return null;
    }
    this.recentlyCreated.delete(file.path);
    if (Date.now() - record.createdAt > NEW_FILE_TTL_MS) {
      return null;
    }
    return record;
  }

  public resolvePosition(view: MarkdownView, isNew: boolean): CursorPositionOrNone {
    const override = this.getFrontmatterOverride(view);
    if (override) {
      return override;
    }
    return isNew ? this.settings.onCreate : this.settings.onOpen;
  }

  public getFrontmatterOverride(view: MarkdownView): CursorPosition | null {
    const editor = view.editor;

    if (editor.lineCount() < 2 || editor.getLine(0).trim() !== '---') {
      return null;
    }

    for (let i = 1; i < editor.lineCount(); i++) {
      const line = editor.getLine(i);

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

  public setCursorPosition(view: MarkdownView, position: CursorPosition): void {
    if (position === 'title') {
      view.leaf.setEphemeralState({ rename: 'end' });
      view.containerEl.querySelector<HTMLElement>('.inline-title')?.focus();
      return;
    }

    if (position === 'title-highlighted') {
      view.leaf.setEphemeralState({ rename: 'all' });
      view.containerEl.querySelector<HTMLElement>('.inline-title')?.focus();
      return;
    }

    if (position === 'body') {
      view.editor.focus();
      view.editor.setCursor(this.getBodyStart(view));
      return;
    }

    if (position === 'end') {
      const editor = view.editor;
      const lastLine = editor.lineCount() - 1;
      editor.focus();
      editor.setCursor({ ch: editor.getLine(lastLine).length, line: lastLine });
    }
  }

  // Returns true if Templater is installed and will process this file:
  // - explicit template creation: already in files_with_pending_templates
  // - folder-trigger: trigger_on_file_creation is on (Templater adds to the
  //   pending set only after its own 300ms delay, so we must decide here)
  public templaterWillProcess(file: TFile): boolean {
    const plugin = (this.app as any).plugins?.plugins?.['templater-obsidian'];
    if (!plugin) {
      return false;
    }
    if (plugin.templater?.files_with_pending_templates?.has(file.path)) {
      return true;
    }
    return plugin.settings?.trigger_on_file_creation === true;
  }
}
