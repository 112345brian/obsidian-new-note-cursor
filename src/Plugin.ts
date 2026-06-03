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
// How many times we will re-apply our position in response to Obsidian
// Re-focusing the inline title during its new-note initialization sequence.
const MAX_TITLE_INTERCEPTS = 5;
// Safety valve: stop intercepting after this long regardless.
const INTERCEPT_TIMEOUT_MS = 2_000;
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
      // For new notes, Obsidian asynchronously focuses the inline title one or
      // More times during its initialization sequence. A fixed delay can't beat
      // All of them reliably. Instead, watch the title element and redirect on
      // Every focus event until the initialization window closes.
      this.watchAndRedirect(file, position);
    } else {
      // Existing notes have no async initialization — apply immediately.
      const editor = this.app.workspace.activeEditor;
      if (!editor?.editor || editor.file?.path !== file.path) {
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

  // For new notes: hook every title-focus event Obsidian fires during init
  // And redirect to the desired position each time. Stops after MAX_TITLE_INTERCEPTS
  // Or INTERCEPT_TIMEOUT_MS, whichever comes first.
  public watchAndRedirect(file: TFile, position: CursorPosition): void {
    if (position === 'title') {
      // Obsidian's default for new notes is already cursor-at-title-end.
      return;
    }

    // Give the view one tick to render (file-open fires before the first paint).
    window.setTimeout(() => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view || view.file?.path !== file.path) {
        return;
      }

      const titleEl = view.containerEl.querySelector<HTMLElement>('.inline-title');
      if (!titleEl) {
        // No inline title (disabled in settings) — apply directly.
        const editor = this.app.workspace.activeEditor;
        if (editor?.editor && editor.file?.path === file.path) {
          this.setCursorPosition(editor, position);
        }
        return;
      }

      let redirectCount = 0;

      // eslint-disable-next-line func-style -- arrow needed to capture outer `this`
      const onTitleFocus = (): void => {
        redirectCount += 1;
        if (redirectCount > MAX_TITLE_INTERCEPTS) {
          return;
        }

        // Yield one tick so the browser finishes the focus transition.
        window.setTimeout(() => {
          const editor = this.app.workspace.activeEditor;
          if (!editor?.editor || editor.file?.path !== file.path) {
            return;
          }

          if (position === 'title-highlighted') {
            // Title is already focused — just extend the selection.
            const freshTitle = (editor instanceof MarkdownView ? editor : view)
              .containerEl.querySelector<HTMLElement>('.inline-title');
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
            // Body/end — pull focus away from the title into the editor.
            // Editor.editor is guaranteed non-null by the check above.
            const ed = editor.editor;
            ed.focus();
            if (position === 'end') {
              const lastLine = ed.lineCount() - 1;
              ed.setCursor({ ch: ed.getLine(lastLine).length, line: lastLine });
            } else {
              ed.setCursor(this.getBodyStart(editor));
            }
          }
        }, 0);
      };

      titleEl.addEventListener('focus', onTitleFocus);

      // On mobile, also intercept via Platform-specific check for extra safety.
      if (Platform.isMobile) {
        titleEl.focus();
      }

      window.setTimeout(() => {
        titleEl.removeEventListener('focus', onTitleFocus);
      }, INTERCEPT_TIMEOUT_MS);
    }, 0);
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
