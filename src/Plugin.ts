import type { TAbstractFile, TFile } from 'obsidian';

import { MarkdownView } from 'obsidian';
import { PluginBase } from 'obsidian-dev-utils/obsidian/plugin/plugin-base';

import type { CursorPosition, CursorPositionOrNone } from './PluginSettings.ts';
import type { PluginTypes } from './PluginTypes.ts';

import { PluginSettingsManager } from './PluginSettingsManager.ts';
import { PluginSettingsTab } from './PluginSettingsTab.ts';

const NEW_FILE_TTL_MS = 5_000;
const TEMPLATER_DEFER_MS = 350;

// All values accepted in frontmatter (includes 'none' to explicitly opt out)
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

    // (#5) Folder exclusions — skip entirely for excluded paths
    if (this.isExcluded(file)) {
      return;
    }

    // (#6) Hover editor / popout window support: use activeLeaf rather than
    // getActiveViewOfType so we cover every workspace root
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
        // Only apply if the template explicitly declares cursor-position
        const override = this.getFrontmatterOverride(fresh, true);
        if (override && override !== 'none') {
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

  // (#2, #3) Read cursor position from frontmatter.
  // Checks the event-specific key first (cursor-position-create / cursor-position-open),
  // then falls back to the generic cursor-position key.
  // Returns null when no key is present (use global setting).
  // Returns 'none' when the note explicitly opts out.
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
        // Inline title disabled — fall back to body start
        view.editor.focus();
        view.editor.setCursor(this.getBodyStart(view));
        return;
      }

      // Defer one frame so setEphemeralState has time to render the title
      // element into its rename state before we manipulate the selection.
      // This is what makes mobile work: setEphemeralState handles Obsidian's
      // internal state (desktop), and the explicit Range selection below
      // handles the actual DOM highlight (required on mobile WebView).
      window.setTimeout(() => {
        titleEl.focus();
        const sel = window.getSelection();
        if (!sel) {
          return;
        }
        const range = document.createRange();
        range.selectNodeContents(titleEl);
        if (position === 'title') {
          range.collapse(false); // cursor at end, nothing selected
        }
        sel.removeAllRanges();
        sel.addRange(range);
      }, 0);
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

  // (#5) Returns true when the file's path falls under an excluded folder.
  public isExcluded(file: TFile): boolean {
    return this.settings.excludedFolders.some((folder) => {
      const normalized = folder.replace(/\/+$/, '');
      if (!normalized) {
        return false;
      }
      return file.path === normalized || file.path.startsWith(normalized + '/');
    });
  }

  // (#6) Find the active MarkdownView for a file across all workspace roots
  // (main window, popout windows, hover editors).
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

  // Scans frontmatter lines for a specific key and returns its value if valid.
  private readFrontmatterKey(view: MarkdownView, key: string): CursorPositionOrNone | null {
    const editor = view.editor;
    if (editor.lineCount() < 2 || editor.getLine(0).trim() !== '---') {
      return null;
    }
    // Escape hyphens in key for use in regex
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
