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
const FAST_DELAY_MS = 100;
const TEMPLATER_DEFER_MS = 350;
const MOBILE_INTERCEPT_TIMEOUT_MS = 2_000;
// Frontmatter requires at least an opening --- and one closing line.
const FRONTMATTER_MIN_LINES = 2;

const VALID_FRONTMATTER_VALUES: readonly CursorPositionOrNone[] = [
  'body', 'end', 'none', 'title', 'title-highlighted'
];

// Named return type for getBodyStart.
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
      return;
    }

    const isNew = this.isNewlyCreated(file);

    // Templater writes template content after its own 300 ms delay.
    // Defer past that so we read the final frontmatter and only apply
    // If the template explicitly declares a cursor-position key.
    if (isNew && this.templaterWillProcess(file)) {
      window.setTimeout(() => {
        const editor = this.app.workspace.activeEditor;
        if (!editor?.editor || editor.file?.path !== file.path) {
          return;
        }
        const view = editor instanceof MarkdownView ? editor : null;
        const override = view ? this.getFrontmatterOverride(view, true) : null;
        if (override && override !== 'none') {
          this.setCursorPosition(editor, override);
        }
      }, TEMPLATER_DEFER_MS);
      return;
    }

    const position = isNew
      ? this.resolvePositionForNew(file)
      : this.resolvePositionForOpen(file);

    if (position === 'none') {
      return;
    }

    if (isNew) {
      // Fast mode: 100 ms beats Obsidian's ~50 ms title-focus init without
      // Needing the full 350 ms Templater delay.
      window.setTimeout(() => {
        const editor = this.app.workspace.activeEditor;
        if (!editor?.editor || editor.file?.path !== file.path) {
          return;
        }
        if (Platform.isMobile) {
          const leaf = this.app.workspace.getActiveViewOfType(MarkdownView);
          if (leaf && position !== 'title') {
            this.interceptAndRedirect(leaf, editor, file, position);
            return;
          }
        }
        this.setCursorPosition(editor, position);
      }, FAST_DELAY_MS);
    } else {
      const editor = this.app.workspace.activeEditor;
      if (!editor?.editor || editor.file?.path !== file.path) {
        return;
      }
      this.setCursorPosition(editor, position);
    }
  }

  public interceptAndRedirect(
    view: MarkdownView,
    editor: MarkdownFileInfo,
    file: TFile,
    position: CursorPosition
  ): void {
    const titleEl = view.containerEl.querySelector<HTMLElement>('.inline-title');

    if (!titleEl) {
      this.setCursorPosition(editor, position);
      return;
    }

    // eslint-disable-next-line func-style -- arrow needed to capture `this` inside a class method
    const onFocus = (): void => {
      window.setTimeout(() => {
        const fresh = this.app.workspace.activeEditor;
        if (!fresh?.editor || fresh.file?.path !== file.path) {
          return;
        }
        if (position === 'title-highlighted') {
          const freshView = fresh instanceof MarkdownView
            ? fresh
            : this.app.workspace.getActiveViewOfType(MarkdownView);
          const freshTitle = freshView?.containerEl.querySelector<HTMLElement>('.inline-title');
          if (freshTitle) {
            const sel = window.getSelection();
            if (sel) {
              const range = document.createRange();
              range.selectNodeContents(freshTitle);
              sel.removeAllRanges();
              sel.addRange(range);
            }
          }
        } else {
          this.setCursorPosition(fresh, position);
        }
      }, 0);
    };

    titleEl.addEventListener('focus', onFocus, { once: true });
    window.setTimeout(() => {
      titleEl.removeEventListener('focus', onFocus);
    }, MOBILE_INTERCEPT_TIMEOUT_MS);
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
