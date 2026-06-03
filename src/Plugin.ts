import type { TFile } from 'obsidian';

import { MarkdownView, Platform } from 'obsidian';
import { PluginBase } from 'obsidian-dev-utils/obsidian/plugin/plugin-base';

import type { CursorPosition, CursorPositionOrNone } from './PluginSettings.ts';
import type { PluginTypes } from './PluginTypes.ts';

import { PluginSettingsManager } from './PluginSettingsManager.ts';
import { PluginSettingsTab } from './PluginSettingsTab.ts';

// A file whose ctime is within this window is treated as newly created.
const NEW_FILE_TTL_MS = 5_000;

// Templater waits 300 ms before writing templates; we wait a bit longer.
const TEMPLATER_DEFER_MS = 350;

// Safety-valve timeout for the mobile focus interceptor.
const MOBILE_INTERCEPT_TIMEOUT_MS = 2_000;

const VALID_FRONTMATTER_VALUES: readonly CursorPositionOrNone[] = [
  'title', 'body', 'end', 'title-highlighted', 'none',
];

export class Plugin extends PluginBase<PluginTypes> {
  protected override createSettingsManager(): PluginSettingsManager {
    return new PluginSettingsManager(this);
  }

  protected override createSettingsTab(): null | PluginSettingsTab {
    return new PluginSettingsTab(this);
  }

  protected override async onloadImpl(): Promise<void> {
    await super.onloadImpl();
    this.registerEvent(
      this.app.workspace.on('file-open', this.handleFileOpen.bind(this))
    );
  }

  public handleFileOpen(file: TFile | null): void {
    if (!file) {
      return;
    }

    if (this.isExcluded(file)) {
      return;
    }

    const view = this.findActiveMarkdownView(file);
    if (!view) {
      return;
    }

    // Use ctime to detect new files — this sidesteps the event-ordering race
    // between vault.on('create') and workspace.on('file-open').
    const isNew = this.isNewlyCreated(file);

    // If Templater will write template content, defer until after it finishes
    // so we see the final frontmatter (and don't fight over cursor ownership).
    if (isNew && this.templaterWillProcess(file)) {
      window.setTimeout(() => {
        const fresh = this.findActiveMarkdownView(file);
        if (!fresh) {
          return;
        }
        const override = this.getFrontmatterOverride(fresh, true);
        if (override && override !== 'none') {
          this.applyPosition(fresh, file, override, true);
        }
      }, TEMPLATER_DEFER_MS);
      return;
    }

    const position = this.resolvePosition(view, isNew);
    if (position === 'none') {
      return;
    }

    this.applyPosition(view, file, position, isNew);
  }

  // Route to the correct placement strategy based on platform + event type.
  public applyPosition(view: MarkdownView, file: TFile, position: CursorPosition, isNew: boolean): void {
    if (isNew && Platform.isMobile) {
      // On mobile, Obsidian asynchronously focuses the inline title after
      // file-open for new notes. Intercept that focus event so we run last.
      this.scheduleMobilePosition(view, file, position);
    } else {
      this.setCursorPosition(view, position);
    }
  }

  public resolvePosition(view: MarkdownView, isNew: boolean): CursorPositionOrNone {
    return this.getFrontmatterOverride(view, isNew) ??
      (isNew ? this.settings.onCreate : this.settings.onOpen);
  }

  public getFrontmatterOverride(view: MarkdownView, isNew: boolean): CursorPositionOrNone | null {
    const specificKey = isNew ? 'cursor-position-create' : 'cursor-position-open';
    return this.readFrontmatterKey(view, specificKey)
      ?? this.readFrontmatterKey(view, 'cursor-position');
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
    if (position === 'title' || position === 'title-highlighted') {
      const rename = position === 'title-highlighted' ? 'all' : 'end';
      view.leaf.setEphemeralState({ rename });

      const titleEl = view.containerEl.querySelector<HTMLElement>('.inline-title');
      if (!titleEl) {
        view.editor.focus();
        view.editor.setCursor(this.getBodyStart(view));
        return;
      }

      titleEl.focus();
      if (position === 'title-highlighted') {
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

  // Mobile: intercept Obsidian's async title focus rather than fighting it.
  public scheduleMobilePosition(view: MarkdownView, file: TFile, position: CursorPosition): void {
    const titleEl = view.containerEl.querySelector<HTMLElement>('.inline-title');

    if (!titleEl) {
      this.setCursorPosition(view, position);
      return;
    }

    if (position === 'title') {
      // Obsidian's default for new notes is already cursor-at-title-end.
      return;
    }

    const onTitleFocused = (): void => {
      window.setTimeout(() => {
        const fresh = this.findActiveMarkdownView(file);
        if (!fresh) {
          return;
        }
        if (position === 'title-highlighted') {
          const freshTitle = fresh.containerEl.querySelector<HTMLElement>('.inline-title');
          if (freshTitle) {
            const sel = window.getSelection();
            if (sel) {
              const range = document.createRange();
              range.selectNodeContents(freshTitle);
              sel.removeAllRanges();
              sel.addRange(range);
            }
          }
          return;
        }
        fresh.editor.focus();
        if (position === 'end') {
          const lastLine = fresh.editor.lineCount() - 1;
          fresh.editor.setCursor({ ch: fresh.editor.getLine(lastLine).length, line: lastLine });
        } else {
          fresh.editor.setCursor(this.getBodyStart(fresh));
        }
      }, 0);
    };

    titleEl.addEventListener('focus', onTitleFocused, { once: true });
    window.setTimeout(() => {
      titleEl.removeEventListener('focus', onTitleFocused);
    }, MOBILE_INTERCEPT_TIMEOUT_MS);
  }

  // True when the file's ctime is within NEW_FILE_TTL_MS of now.
  // Using ctime avoids the vault.on('create') / file-open event-ordering race.
  public isNewlyCreated(file: TFile): boolean {
    return (Date.now() - file.stat.ctime) <= NEW_FILE_TTL_MS;
  }

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

  public isExcluded(file: TFile): boolean {
    return this.settings.excludedFolders.some((folder) => {
      const normalized = folder.replace(/\/+$/, '');
      if (!normalized) {
        return false;
      }
      return file.path === normalized || file.path.startsWith(normalized + '/');
    });
  }

  public findActiveMarkdownView(file: TFile): MarkdownView | null {
    // Try the standard API first (works for main workspace).
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.file?.path === file.path) {
      return view;
    }
    // Fall back to activeLeaf (covers hover editors, popout windows).
    const leaf = (this.app.workspace as any).activeLeaf;
    if (!leaf) {
      return null;
    }
    const leafView = leaf.view;
    if (!(leafView instanceof MarkdownView)) {
      return null;
    }
    return leafView.file?.path === file.path ? leafView : null;
  }

  private readFrontmatterKey(view: MarkdownView, key: string): CursorPositionOrNone | null {
    const editor = view.editor;
    if (editor.lineCount() < 2 || editor.getLine(0).trim() !== '---') {
      return null;
    }
    const escapedKey = key.replace(/-/g, '\\-');
    const pattern = new RegExp(`^${escapedKey}:\\s*["']?([^"'\\s]+)["']?`);
    for (let i = 1; i < editor.lineCount(); i++) {
      const line = editor.getLine(i);
      if (line.trim() === '---') {
        break;
      }
      const match = pattern.exec(line);
      if (match) {
        const value = match[1] as CursorPositionOrNone;
        if (VALID_FRONTMATTER_VALUES.includes(value)) {
          return value;
        }
      }
    }
    return null;
  }
}
