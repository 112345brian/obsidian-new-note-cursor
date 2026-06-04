import type {
  MarkdownFileInfo, TFile
} from 'obsidian';

import {
 MarkdownView, Platform
} from 'obsidian';
import { PluginBase } from 'obsidian-dev-utils/obsidian/plugin/plugin-base';

import type {
  CursorPosition, CursorPositionOrNone
} from './PluginSettings.ts';
import type { PluginTypes } from './PluginTypes.ts';

import { PluginSettingsManager } from './PluginSettingsManager.ts';
import { PluginSettingsTab } from './PluginSettingsTab.ts';

const NEW_FILE_TTL_MS = 5_000;
const TEMPLATER_DEFER_MS = 350;
// Inspired by obsidian-last-position: apply, verify, retry if wrong.
// Mobile Obsidian initializes more slowly so we give it a longer window.
const MAX_RETRIES_DESKTOP = 10; //  10 × 100 ms = 1 s
const MAX_RETRIES_MOBILE = 20; //  20 × 100 ms = 2 s
const RETRY_DELAY_MS = 100;
// Frontmatter requires at least an opening --- and one closing line.
const FRONTMATTER_MIN_LINES = 2;

const VALID_FRONTMATTER_VALUES: readonly CursorPositionOrNone[] = [
  'body', 'end', 'none', 'title', 'title-highlighted'
];

interface EditorPosition {
  ch: number;
  line: number;
}

interface ObsidianPluginsRecord {
  plugins?: Record<string, TemplaterPlugin>;
}

// Internal Obsidian plugin shape we need to inspect for Templater detection.
interface TemplaterPlugin {
  settings?: TemplaterPluginSettings;
  templater?: TemplaterPluginCore;
}

interface TemplaterPluginCore {
  files_with_pending_templates?: Set<string>;
}

interface TemplaterPluginSettings {
  trigger_on_file_creation?: boolean;
}

export class Plugin extends PluginBase<PluginTypes> {
  public getBodyStart(editorInfo: MarkdownFileInfo): EditorPosition {
    const ed = editorInfo.editor;
    if (!ed) {
      return { ch: 0, line: 0 };
    }
    if (ed.lineCount() > 1 && ed.getLine(0).trim() === '---') {
      for (let i = 1; i < ed.lineCount(); i++) {
        if (ed.getLine(i).trim() === '---') {
          let bodyLine = i + 1;
          if (bodyLine < ed.lineCount() && ed.getLine(bodyLine).trim() === '') {
            bodyLine += 1;
          }
          return { ch: 0, line: Math.min(bodyLine, ed.lineCount() - 1) };
        }
      }
    }
    return { ch: 0, line: 0 };
  }

  public getFrontmatterOverride(view: MarkdownView, isNew: boolean): CursorPositionOrNone | null {
    const specificKey = isNew ? 'cursor-position-create' : 'cursor-position-open';
    return this.readFrontmatterKey(view, specificKey)
      ?? this.readFrontmatterKey(view, 'cursor-position');
  }

  public handleFileOpen(file: null | TFile): void {
    if (!file) {
      return;
    }

    if (this.isExcluded(file)) {
      this.log('excluded:', file.path);
      return;
    }

    const isNew = this.isNewlyCreated(file);
    const activeEditor = this.app.workspace.activeEditor;
    this.log('file-open', { activeEditor: activeEditor?.file?.path ?? null, ctime: file.stat.ctime, isNew, now: Date.now(), path: file.path });

    // Templater writes template content after its own 300 ms delay.
    // Defer past that so we read the final frontmatter and only apply
    // If the template explicitly declares a cursor-position key.
    if (isNew && this.templaterWillProcess(file)) {
      this.log('deferring for Templater');
      window.setTimeout(() => {
        const editor = this.app.workspace.activeEditor;
        if (!editor?.editor || editor.file?.path !== file.path) {
          return;
        }
        const view = editor instanceof MarkdownView ? editor : null;
        const override = view ? this.getFrontmatterOverride(view, true) : null;
        // Frontmatter override takes priority; fall back to the onCreate setting.
        // Override can be 'none' (explicit suppression) or null (not set — use setting).
        const templaterPosition = override ?? this.settings.onCreate;
        this.log('Templater defer resolved', { override, templaterPosition });
        if (templaterPosition !== 'none') {
          this.setCursorPosition(editor, templaterPosition);
        }
      }, TEMPLATER_DEFER_MS);
      return;
    }

    const position = isNew
      ? this.resolvePositionForNew(file)
      : this.resolvePositionForOpen(file);

    this.log('resolved position:', position, '| settings onCreate:', this.settings.onCreate, 'onOpen:', this.settings.onOpen);

    if (position === 'none') {
      return;
    }

    if (isNew) {
      this.watchAndRedirect(file, position);
    } else {
      // Existing notes have no async initialization — apply immediately.
      const editor = this.app.workspace.activeEditor;
      if (!editor?.editor || editor.file?.path !== file.path) {
        this.log('activeEditor mismatch on open, skipping');
        return;
      }
      this.setCursorPosition(editor, position);
    }
  }

  public isExcluded(file: TFile): boolean {
    return this.settings.excludedFolders.some((folder) => {
      const normalized = folder.replace(/\/+$/, '');
      if (!normalized) {
        return false;
      }
      return file.path === normalized || file.path.startsWith(`${normalized}/`);
    });
  }

  public isNewlyCreated(file: TFile): boolean {
    return (Date.now() - file.stat.ctime) <= NEW_FILE_TTL_MS;
  }

  public log(...args: unknown[]): void {
    if (this.settings.debugMode) {
      console.debug('[CursorControl]', ...args);
    }
  }

  public readFrontmatterKey(view: MarkdownView, key: string): CursorPositionOrNone | null {
    const editor = view.editor;
    if (editor.lineCount() < FRONTMATTER_MIN_LINES || editor.getLine(0).trim() !== '---') {
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

  public resolvePositionForNew(file: TFile): CursorPositionOrNone {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.file?.path === file.path) {
      const override = this.getFrontmatterOverride(view, true);
      if (override !== null) {
        return override;
      }
    }
    return this.settings.onCreate;
  }

  public resolvePositionForOpen(file: TFile): CursorPositionOrNone {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.file?.path === file.path) {
      const override = this.getFrontmatterOverride(view, false);
      if (override !== null) {
        return override;
      }
    }
    return this.settings.onOpen;
  }

  public retryCursor(file: TFile, position: CursorPosition, retriesLeft: number): void {
    if (retriesLeft <= 0) {
      return;
    }

    window.setTimeout(() => {
      const fresh = this.app.workspace.activeEditor;

      // Editor not ready yet — keep watching rather than giving up.
      if (!fresh) {
        this.retryCursor(file, position, retriesLeft - 1);
        return;
      }

      // A different file became active — the user navigated away, stop.
      if (!fresh.editor || fresh.file?.path !== file.path) {
        return;
      }

      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      const titleEl = view?.containerEl.querySelector<HTMLElement>('.inline-title');
      const titleHasFocus = document.activeElement === titleEl;

      // For body/end we want the editor focused, not the title.
      // For title-highlighted we want the title focused.
      const wrong = position === 'title-highlighted' ? !titleHasFocus : titleHasFocus;
      if (wrong) {
        this.log('retryCursor fixing focus', { position, retriesLeft, titleHasFocus });
        this.setCursorPosition(fresh, position);
      }

      // Always keep watching for the full window — Obsidian can steal focus multiple
      // Times during init, and stopping early when it looks correct loses to a later steal.
      this.retryCursor(file, position, retriesLeft - 1);
    }, RETRY_DELAY_MS);
  }

  public setCursorPosition(editorInfo: MarkdownFileInfo, position: CursorPosition): void {
    const ed = editorInfo.editor;
    if (!ed) {
      return;
    }

    if (position === 'title' || position === 'title-highlighted') {
      const view = editorInfo instanceof MarkdownView
        ? editorInfo
        : this.app.workspace.getActiveViewOfType(MarkdownView);

      if (view) {
        view.leaf.setEphemeralState({ rename: position === 'title-highlighted' ? 'all' : 'end' });
        const titleEl = view.containerEl.querySelector<HTMLElement>('.inline-title');
        if (!titleEl) {
          ed.focus();
          ed.setCursor(this.getBodyStart(editorInfo));
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
      }
      return;
    }

    if (position === 'body') {
      ed.focus();
      ed.setCursor(this.getBodyStart(editorInfo));
      return;
    }

    // Position === 'end'
    const lastLine = ed.lineCount() - 1;
    ed.focus();
    ed.setCursor({ ch: ed.getLine(lastLine).length, line: lastLine });
  }

  public templaterWillProcess(file: TFile): boolean {
    type AppWithPlugins = { plugins?: ObsidianPluginsRecord } & typeof this.app;
    const obsidianApp = this.app as AppWithPlugins;
    const plugin = obsidianApp.plugins?.plugins?.['templater-obsidian'];
    if (!plugin) {
      return false;
    }
    return (plugin.templater?.files_with_pending_templates?.has(file.path) ?? false)
      || (plugin.settings?.trigger_on_file_creation ?? false);
  }

  // Apply immediately, then watch for the full init window and reapply whenever
  // Obsidian steals focus back to the inline title.
  public watchAndRedirect(file: TFile, position: CursorPosition): void {
    if (position === 'title') {
      // Obsidian's default for new notes is already cursor-at-title-end.
      return;
    }

    const editor = this.app.workspace.activeEditor;
    this.log('watchAndRedirect', { editorFile: editor?.file?.path ?? null, editorReady: !!editor?.editor, position });
    if (editor?.editor && editor.file?.path === file.path) {
      this.setCursorPosition(editor, position);
    }

    const maxRetries = Platform.isMobileApp ? MAX_RETRIES_MOBILE : MAX_RETRIES_DESKTOP;
    this.retryCursor(file, position, maxRetries);
  }

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
}
