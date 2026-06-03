import type { TAbstractFile, TFile } from 'obsidian';

import { MarkdownView, Platform } from 'obsidian';
import { PluginBase } from 'obsidian-dev-utils/obsidian/plugin/plugin-base';

import type { CursorPosition, CursorPositionOrNone } from './PluginSettings.ts';
import type { PluginTypes } from './PluginTypes.ts';

import { PluginSettingsManager } from './PluginSettingsManager.ts';
import { PluginSettingsTab } from './PluginSettingsTab.ts';

const NEW_FILE_TTL_MS = 5_000;
const TEMPLATER_DEFER_MS = 350;
// If Obsidian never focuses the title (e.g. inline title was just toggled off),
// clean up our interceptor after this long.
const MOBILE_INTERCEPT_TIMEOUT_MS = 2_000;

const VALID_FRONTMATTER_VALUES: readonly CursorPositionOrNone[] = [
  'title', 'body', 'end', 'title-highlighted', 'none',
];

interface FileRecord {
  createdAt: number;
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
    this.registerEvent(this.app.vault.on('create', this.handleCreate.bind(this)));
    this.registerEvent(this.app.workspace.on('file-open', this.handleFileOpen.bind(this)));
  }

  public handleCreate(file: TAbstractFile): void {
    if (!file.path.endsWith('.md')) {
      return;
    }
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

    if (this.isExcluded(file)) {
      return;
    }

    const view = this.findActiveMarkdownView(file);
    if (!view) {
      return;
    }

    if (isNew && record.templaterWillProcess) {
      window.setTimeout(() => {
        const fresh = this.findActiveMarkdownView(file);
        if (!fresh) {
          return;
        }
        const override = this.getFrontmatterOverride(fresh, true);
        if (override && override !== 'none') {
          this.setCursorPosition(fresh, override);
        }
      }, TEMPLATER_DEFER_MS);
      return;
    }

    const position = this.resolvePosition(view, isNew);
    if (position === 'none') {
      return;
    }

    // On mobile, Obsidian asynchronously focuses the inline title after
    // file-open for new notes — any cursor change we make here gets
    // overridden. Instead of fighting the timing, we listen for the focus
    // event Obsidian will trigger and redirect from inside that callback,
    // so we are guaranteed to run last.
    if (isNew && Platform.isMobile) {
      this.scheduleMobilePosition(view, file, position);
      return;
    }

    this.setCursorPosition(view, position);
  }

  public consumeRecord(file: TFile): FileRecord | null {
    const rec = this.recentlyCreated.get(file.path);
    if (!rec) {
      return null;
    }
    this.recentlyCreated.delete(file.path);
    return Date.now() - rec.createdAt <= NEW_FILE_TTL_MS ? rec : null;
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

  // Synchronous cursor placement — used on desktop and for open events on mobile.
  // For new notes on mobile use scheduleMobilePosition instead.
  public setCursorPosition(view: MarkdownView, position: CursorPosition): void {
    if (position === 'title' || position === 'title-highlighted') {
      const rename = position === 'title-highlighted' ? 'all' : 'end';
      view.leaf.setEphemeralState({ rename });

      const titleEl = view.containerEl.querySelector<HTMLElement>('.inline-title');
      if (!titleEl) {
        // Inline title disabled — fall back to body start
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

  // Mobile-specific handler for new note creation.
  // Obsidian focuses the inline title asynchronously after file-open, overriding
  // anything we set synchronously. We register a one-time focus listener on that
  // element and apply our positioning from inside it — guaranteed to run after
  // Obsidian finishes its own initialization.
  public scheduleMobilePosition(view: MarkdownView, file: TFile, position: CursorPosition): void {
    const titleEl = view.containerEl.querySelector<HTMLElement>('.inline-title');

    if (!titleEl) {
      // No race condition without an inline title — apply directly.
      this.setCursorPosition(view, position);
      return;
    }

    if (position === 'title') {
      // Obsidian's default for new notes is already cursor-at-title-end.
      return;
    }

    const onTitleFocused = (): void => {
      // Yield one tick so the browser finishes the focus transition, then redirect.
      window.setTimeout(() => {
        const fresh = this.findActiveMarkdownView(file);
        if (!fresh) {
          return;
        }

        if (position === 'title-highlighted') {
          // Title is already focused — just extend to a full selection.
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

        // body / end — move focus away from the title into the editor.
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

    // Safety valve: if Obsidian never focuses the title (edge case), clean up.
    window.setTimeout(() => {
      titleEl.removeEventListener('focus', onTitleFocused);
    }, MOBILE_INTERCEPT_TIMEOUT_MS);
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
    const leaf = (this.app.workspace as any).activeLeaf;
    if (!leaf) {
      return null;
    }
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) {
      return null;
    }
    return view.file?.path === file.path ? view : null;
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
