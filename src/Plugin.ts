import type { MarkdownFileInfo, TFile } from 'obsidian';

import { MarkdownView, Platform } from 'obsidian';
import { PluginBase } from 'obsidian-dev-utils/obsidian/plugin/plugin-base';

import type { CursorPosition, CursorPositionOrNone } from './PluginSettings.ts';
import type { PluginTypes } from './PluginTypes.ts';

import { PluginSettingsManager } from './PluginSettingsManager.ts';
import { PluginSettingsTab } from './PluginSettingsTab.ts';

// A file whose ctime is within this window is treated as newly created.
const NEW_FILE_TTL_MS = 5_000;

// Fast path: Obsidian focuses the inline title ~50 ms after file-open.
// A 100 ms delay is enough to run after it when Templater isn't involved.
const FAST_DELAY_MS = 100;

// Templater waits 300 ms before writing templates; we wait a bit longer
// so we see the final content and cursor-position frontmatter.
const TEMPLATER_DEFER_MS = 350;

// Safety-valve for mobile focus interceptor.
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

    const isNew = this.isNewlyCreated(file);

    // Templater writes template content ~300 ms after creation.
    // Defer past that so we read the final frontmatter.
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
      // Obsidian focuses the inline title asynchronously after file-open.
      // Fast mode (auto): when Templater won't touch the file, 100 ms is
      // enough to run after Obsidian's init (~50 ms). When Templater is
      // active we need 350 ms to run after it writes the template.
      const delay = this.templaterWillProcess(file) ? TEMPLATER_DEFER_MS : FAST_DELAY_MS;
      window.setTimeout(() => {
        const editor = this.app.workspace.activeEditor;
        if (!editor?.editor || editor.file?.path !== file.path) {
          return;
        }
        if (Platform.isMobile) {
          // On mobile the title may still steal focus after our delay.
          // Intercept the next focus on the title element and redirect from there.
          const leaf = this.app.workspace.getActiveViewOfType(MarkdownView);
          if (leaf && position !== 'title') {
            this.interceptAndRedirect(leaf, editor, file, position);
            return;
          }
        }
        this.setCursorPosition(editor, position);
      }, delay);
    } else {
      // For existing notes there is no async title initialization — apply directly.
      const editor = this.app.workspace.activeEditor;
      if (!editor?.editor || editor.file?.path !== file.path) {
        return;
      }
      this.setCursorPosition(editor, position);
    }
  }

  // Resolve the position for a new note, checking frontmatter first.
  public resolvePositionForNew(file: TFile): CursorPositionOrNone {
    // Frontmatter can only be read after the view is open — get a fresh reference.
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.file?.path === file.path) {
      const override = this.getFrontmatterOverride(view, true);
      if (override !== null) {
        return override;
      }
    }
    return this.settings.onCreate;
  }

  // Resolve the position for an existing note.
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

  // On mobile, even at 300 ms the OS may refocus the inline title after we
  // set the editor cursor. Hook the next focus event on .inline-title and
  // redirect from inside it — guaranteed to run after any title focus.
  public interceptAndRedirect(
    view: MarkdownView,
    editor: MarkdownFileInfo,
    file: TFile,
    position: CursorPosition,
  ): void {
    const titleEl = view.containerEl.querySelector<HTMLElement>('.inline-title');

    if (!titleEl) {
      this.setCursorPosition(editor, position);
      return;
    }

    const onFocus = (): void => {
      window.setTimeout(() => {
        const fresh = this.app.workspace.activeEditor;
        if (!fresh?.editor || fresh.file?.path !== file.path) {
          return;
        }
        if (position === 'title-highlighted') {
          const freshTitle = (fresh instanceof MarkdownView
            ? fresh
            : this.app.workspace.getActiveViewOfType(MarkdownView)
          )?.containerEl.querySelector<HTMLElement>('.inline-title');
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

  public getFrontmatterOverride(view: MarkdownView, isNew: boolean): CursorPositionOrNone | null {
    const specificKey = isNew ? 'cursor-position-create' : 'cursor-position-open';
    return this.readFrontmatterKey(view, specificKey)
      ?? this.readFrontmatterKey(view, 'cursor-position');
  }

  public getBodyStart(editor: MarkdownFileInfo): { ch: number; line: number } {
    const ed = editor.editor!;
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

  public setCursorPosition(editor: MarkdownFileInfo, position: CursorPosition): void {
    const ed = editor.editor!;

    if (position === 'title' || position === 'title-highlighted') {
      // setEphemeralState is only on MarkdownView (WorkspaceLeaf), not MarkdownFileInfo
      const view = editor instanceof MarkdownView
        ? editor
        : this.app.workspace.getActiveViewOfType(MarkdownView);

      if (view) {
        view.leaf.setEphemeralState({ rename: position === 'title-highlighted' ? 'all' : 'end' });
        const titleEl = view.containerEl.querySelector<HTMLElement>('.inline-title');
        if (!titleEl) {
          ed.focus();
          ed.setCursor(this.getBodyStart(editor));
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
      ed.setCursor(this.getBodyStart(editor));
      return;
    }

    if (position === 'end') {
      const lastLine = ed.lineCount() - 1;
      ed.focus();
      ed.setCursor({ ch: ed.getLine(lastLine).length, line: lastLine });
    }
  }

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

  public readFrontmatterKey(view: MarkdownView, key: string): CursorPositionOrNone | null {
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
