import type { App, MarkdownFileInfo, TFile } from 'obsidian';
import { MarkdownView, Platform } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CursorPosition, CursorPositionOrNone } from './PluginSettings.ts';

import { Plugin } from './Plugin.ts';
import { PluginSettings } from './PluginSettings.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFile(path = 'test.md', ctime = Date.now()): TFile {
  return { path, stat: { ctime, mtime: ctime, size: 0 } } as unknown as TFile;
}

function makeEditor(lines: string[]) {
  return {
    focus: vi.fn(),
    getLine: vi.fn((n: number) => lines[n] ?? ''),
    lineCount: vi.fn(() => lines.length),
    setCursor: vi.fn(),
  };
}

function makeEditorInfo(lines: string[], path = 'test.md'): MarkdownFileInfo & { _titleEl: HTMLElement } {
  const leaf = { setEphemeralState: vi.fn() };
  const editor = makeEditor(lines);
  const titleEl = document.createElement('div');
  titleEl.contentEditable = 'true';
  vi.spyOn(titleEl, 'focus');
  const containerEl = { querySelector: vi.fn().mockReturnValue(titleEl) };

  // Create a MarkdownView-like object (instanceof check passes)
  const view = Object.assign(Object.create(MarkdownView.prototype), {
    containerEl, editor, file: { path } as TFile, leaf,
  });

  // Attach a ._titleEl for test assertions
  (view as any)._titleEl = titleEl;
  return view;
}

function makePlugin(
  onCreate: CursorPosition = 'body',
  onOpen: CursorPositionOrNone = 'none',
  excludedFolders: string[] = [],
) {
  const settings = new PluginSettings();
  settings.onCreate = onCreate;
  settings.onOpen = onOpen;
  settings.excludedFolders = excludedFolders;

  const activeEditor = { value: null as MarkdownFileInfo | null };

  return {
    app: {
      vault: { on: vi.fn().mockReturnValue({ id: 1 }) },
      workspace: {
        get activeEditor() { return activeEditor.value; },
        getActiveViewOfType: vi.fn().mockReturnValue(null),
        on: vi.fn().mockReturnValue({ id: 2 }),
      },
      _activeEditorRef: activeEditor,
    } as unknown as App,
    handleFileOpen: Plugin.prototype.handleFileOpen,
    getFrontmatterOverride: Plugin.prototype.getFrontmatterOverride,
    resolvePositionForNew: Plugin.prototype.resolvePositionForNew,
    resolvePositionForOpen: Plugin.prototype.resolvePositionForOpen,
    readFrontmatterKey: Plugin.prototype.readFrontmatterKey,
    getBodyStart: Plugin.prototype.getBodyStart,
    setCursorPosition: Plugin.prototype.setCursorPosition,
    interceptAndRedirect: Plugin.prototype.interceptAndRedirect,
    isNewlyCreated: Plugin.prototype.isNewlyCreated,
    isExcluded: Plugin.prototype.isExcluded,
    templaterWillProcess: vi.fn().mockReturnValue(false),
    settings,
  } as any;
}

function setActiveEditor(plugin: any, editor: MarkdownFileInfo | null) {
  plugin.app._activeEditorRef.value = editor;
  plugin.app.workspace.getActiveViewOfType.mockReturnValue(
    editor instanceof MarkdownView ? editor : null
  );
}

// ---------------------------------------------------------------------------
// isNewlyCreated
// ---------------------------------------------------------------------------

describe('isNewlyCreated', () => {
  it('returns true for a file created right now', () => {
    expect(makePlugin().isNewlyCreated(makeFile('t.md', Date.now()))).toBe(true);
  });

  it('returns true within 5 s window', () => {
    expect(makePlugin().isNewlyCreated(makeFile('t.md', Date.now() - 4_000))).toBe(true);
  });

  it('returns false after 5 s', () => {
    expect(makePlugin().isNewlyCreated(makeFile('t.md', Date.now() - 6_000))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isExcluded
// ---------------------------------------------------------------------------

describe('isExcluded', () => {
  it('returns false when no folders excluded', () => {
    expect(makePlugin('body', 'none', []).isExcluded(makeFile('Notes/foo.md'))).toBe(false);
  });

  it('excludes files inside an excluded folder', () => {
    expect(makePlugin('body', 'none', ['Templates']).isExcluded(makeFile('Templates/daily.md'))).toBe(true);
  });

  it('does not exclude a folder with similar name prefix', () => {
    expect(makePlugin('body', 'none', ['Templates']).isExcluded(makeFile('TemplatesBackup/note.md'))).toBe(false);
  });

  it('handles trailing slashes', () => {
    expect(makePlugin('body', 'none', ['Templates/']).isExcluded(makeFile('Templates/note.md'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleFileOpen — routing
// ---------------------------------------------------------------------------

describe('handleFileOpen', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { Platform.isMobile = false; });

  it('does nothing for null', () => {
    const plugin = makePlugin();
    const spy = vi.spyOn(plugin, 'setCursorPosition');
    plugin.handleFileOpen(null);
    vi.runAllTimers();
    expect(spy).not.toHaveBeenCalled();
  });

  it('skips excluded folders', () => {
    const plugin = makePlugin('body', 'none', ['Templates']);
    const editor = makeEditorInfo([], 'Templates/note.md');
    setActiveEditor(plugin, editor);
    const spy = vi.spyOn(plugin, 'setCursorPosition');
    plugin.handleFileOpen(makeFile('Templates/note.md'));
    vi.runAllTimers();
    expect(spy).not.toHaveBeenCalled();
  });

  it('applies onCreate with 300 ms delay for a new file', () => {
    const plugin = makePlugin('end', 'none');
    const editor = makeEditorInfo(['content']);
    setActiveEditor(plugin, editor);
    const spy = vi.spyOn(plugin, 'setCursorPosition');

    plugin.handleFileOpen(makeFile('test.md', Date.now()));
    expect(spy).not.toHaveBeenCalled(); // not immediate

    vi.advanceTimersByTime(300);
    expect(spy).toHaveBeenCalledWith(editor, 'end');
  });

  it('applies onOpen immediately for an existing file (no delay needed)', () => {
    const plugin = makePlugin('title', 'body');
    const editor = makeEditorInfo(['content']);
    setActiveEditor(plugin, editor);
    const spy = vi.spyOn(plugin, 'setCursorPosition');

    plugin.handleFileOpen(makeFile('test.md', Date.now() - 60_000));
    expect(spy).toHaveBeenCalledWith(editor, 'body'); // immediate
  });

  it('skips when resolved position is none', () => {
    const plugin = makePlugin('title', 'none');
    const editor = makeEditorInfo(['content']);
    setActiveEditor(plugin, editor);
    const spy = vi.spyOn(plugin, 'setCursorPosition');

    plugin.handleFileOpen(makeFile('test.md', Date.now() - 60_000));
    expect(spy).not.toHaveBeenCalled();
  });

  it('skips after 300 ms if the file is no longer active', () => {
    const plugin = makePlugin('body');
    const editor = makeEditorInfo(['content']);
    setActiveEditor(plugin, editor);
    const spy = vi.spyOn(plugin, 'setCursorPosition');

    plugin.handleFileOpen(makeFile('test.md', Date.now()));
    // User navigates away before the delay fires
    setActiveEditor(plugin, makeEditorInfo([], 'other.md'));
    vi.advanceTimersByTime(300);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Templater compatibility
// ---------------------------------------------------------------------------

describe('Templater', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('defers and skips for Templater file with no frontmatter override', () => {
    const plugin = makePlugin('body');
    plugin.templaterWillProcess.mockReturnValue(true);
    const editor = makeEditorInfo(['']); // empty before template written
    setActiveEditor(plugin, editor);
    const spy = vi.spyOn(plugin, 'setCursorPosition');

    plugin.handleFileOpen(makeFile('test.md', Date.now()));
    vi.advanceTimersByTime(350);
    expect(spy).not.toHaveBeenCalled();
  });

  it('defers and applies frontmatter override after Templater writes template', () => {
    const plugin = makePlugin('body');
    plugin.templaterWillProcess.mockReturnValue(true);
    const emptyEditor = makeEditorInfo(['']);
    setActiveEditor(plugin, emptyEditor);
    const spy = vi.spyOn(plugin, 'setCursorPosition');

    plugin.handleFileOpen(makeFile('test.md', Date.now()));

    // Simulate Templater writing a template with cursor-position
    const templateEditor = makeEditorInfo(['---', 'cursor-position: end', '---', '', 'content']);
    setActiveEditor(plugin, templateEditor);

    vi.advanceTimersByTime(350);
    expect(spy).toHaveBeenCalledWith(templateEditor, 'end');
  });
});

// ---------------------------------------------------------------------------
// getFrontmatterOverride
// ---------------------------------------------------------------------------

describe('getFrontmatterOverride', () => {
  function override(lines: string[], isNew = true) {
    const view = makeEditorInfo(lines) as unknown as MarkdownView;
    return makePlugin().getFrontmatterOverride(view, isNew);
  }

  it('returns null when no frontmatter', () => {
    expect(override(['content'])).toBeNull();
  });

  it('returns cursor-position value', () => {
    expect(override(['---', 'cursor-position: body', '---'], true)).toBe('body');
  });

  it('cursor-position-create takes precedence on create', () => {
    expect(override(['---', 'cursor-position: title', 'cursor-position-create: end', '---'], true)).toBe('end');
  });

  it('cursor-position-open takes precedence on open', () => {
    expect(override(['---', 'cursor-position: title', 'cursor-position-open: end', '---'], false)).toBe('end');
  });

  it('returns none for cursor-position: none', () => {
    expect(override(['---', 'cursor-position: none', '---'])).toBe('none');
  });

  it('returns null for unrecognised value', () => {
    expect(override(['---', 'cursor-position: nowhere', '---'])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getBodyStart
// ---------------------------------------------------------------------------

describe('getBodyStart', () => {
  function bodyStart(lines: string[]) {
    return makePlugin().getBodyStart(makeEditorInfo(lines));
  }

  it('returns {line:0} for a plain note', () => {
    expect(bodyStart(['content'])).toEqual({ ch: 0, line: 0 });
  });

  it('skips blank line after frontmatter', () => {
    expect(bodyStart(['---', 'title: T', '---', '', '# Body'])).toEqual({ ch: 0, line: 4 });
  });

  it('lands after --- when no blank line follows', () => {
    expect(bodyStart(['---', 'title: T', '---', '# Body'])).toEqual({ ch: 0, line: 3 });
  });

  it('returns {line:0} for unclosed frontmatter', () => {
    expect(bodyStart(['---', 'no close'])).toEqual({ ch: 0, line: 0 });
  });
});

// ---------------------------------------------------------------------------
// setCursorPosition
// ---------------------------------------------------------------------------

describe('setCursorPosition', () => {
  it('title — calls setEphemeralState and focuses inline-title', () => {
    const plugin = makePlugin();
    const editor = makeEditorInfo([]);
    setActiveEditor(plugin, editor);
    plugin.setCursorPosition(editor, 'title');
    expect(editor.leaf.setEphemeralState).toHaveBeenCalledWith({ rename: 'end' });
    expect(editor._titleEl.focus).toHaveBeenCalled();
    expect(editor.editor.setCursor).not.toHaveBeenCalled();
  });

  it('title — falls back to body when inline-title absent', () => {
    const plugin = makePlugin();
    const editor = makeEditorInfo(['content']);
    (editor as any).containerEl.querySelector = vi.fn().mockReturnValue(null);
    setActiveEditor(plugin, editor);
    plugin.setCursorPosition(editor, 'title');
    expect(editor.editor.setCursor).toHaveBeenCalledWith({ ch: 0, line: 0 });
  });

  it('title-highlighted — calls setEphemeralState({ rename: "all" })', () => {
    const plugin = makePlugin();
    const editor = makeEditorInfo([]);
    setActiveEditor(plugin, editor);
    plugin.setCursorPosition(editor, 'title-highlighted');
    expect(editor.leaf.setEphemeralState).toHaveBeenCalledWith({ rename: 'all' });
    expect(editor._titleEl.focus).toHaveBeenCalled();
  });

  it('body — places cursor after frontmatter', () => {
    const plugin = makePlugin();
    const editor = makeEditorInfo(['---', 'title: T', '---', '', 'Content']);
    plugin.setCursorPosition(editor, 'body');
    expect(editor.editor.focus).toHaveBeenCalled();
    expect(editor.editor.setCursor).toHaveBeenCalledWith({ ch: 0, line: 4 });
  });

  it('end — places cursor at end of last line', () => {
    const plugin = makePlugin();
    const editor = makeEditorInfo(['first', 'last line']);
    plugin.setCursorPosition(editor, 'end');
    expect(editor.editor.setCursor).toHaveBeenCalledWith({ ch: 9, line: 1 });
  });
});

// ---------------------------------------------------------------------------
// templaterWillProcess
// ---------------------------------------------------------------------------

describe('templaterWillProcess', () => {
  function withTemplater(config: Record<string, unknown>) {
    const plugin = makePlugin();
    plugin.templaterWillProcess = Plugin.prototype.templaterWillProcess;
    (plugin.app as any).plugins = { plugins: config };
    return plugin;
  }

  it('returns false when Templater not installed', () => {
    expect(withTemplater({}).templaterWillProcess(makeFile())).toBe(false);
  });

  it('returns true when file is pending', () => {
    const p = withTemplater({ 'templater-obsidian': {
      templater: { files_with_pending_templates: new Set(['test.md']) },
      settings: { trigger_on_file_creation: false },
    }});
    expect(p.templaterWillProcess(makeFile('test.md'))).toBe(true);
  });

  it('returns true when trigger_on_file_creation enabled', () => {
    const p = withTemplater({ 'templater-obsidian': {
      templater: { files_with_pending_templates: new Set() },
      settings: { trigger_on_file_creation: true },
    }});
    expect(p.templaterWillProcess(makeFile())).toBe(true);
  });
});
