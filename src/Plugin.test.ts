import type { App, TFile, WorkspaceLeaf } from 'obsidian';
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

function makeView(lines: string[], path = 'test.md') {
  const leaf = { setEphemeralState: vi.fn() } as unknown as WorkspaceLeaf;
  const editor = makeEditor(lines);
  const titleEl = document.createElement('div');
  titleEl.contentEditable = 'true';
  vi.spyOn(titleEl, 'focus');
  const containerEl = { querySelector: vi.fn().mockReturnValue(titleEl) } as unknown as HTMLElement;
  return Object.assign(Object.create(MarkdownView.prototype), {
    containerEl, editor, file: { path } as TFile, leaf, _titleEl: titleEl,
  });
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

  const getActiveViewOfType = vi.fn().mockReturnValue(null);
  const activeLeaf = { view: null as any };

  return {
    app: {
      vault: { on: vi.fn().mockReturnValue({ id: 1 }) },
      workspace: { activeLeaf, getActiveViewOfType, on: vi.fn().mockReturnValue({ id: 2 }) },
    } as unknown as App,
    handleFileOpen: Plugin.prototype.handleFileOpen,
    applyPosition: Plugin.prototype.applyPosition,
    resolvePosition: Plugin.prototype.resolvePosition,
    getFrontmatterOverride: Plugin.prototype.getFrontmatterOverride,
    readFrontmatterKey: (Plugin.prototype as any).readFrontmatterKey,
    getBodyStart: Plugin.prototype.getBodyStart,
    setCursorPosition: Plugin.prototype.setCursorPosition,
    scheduleMobilePosition: Plugin.prototype.scheduleMobilePosition,
    isNewlyCreated: Plugin.prototype.isNewlyCreated,
    isExcluded: Plugin.prototype.isExcluded,
    findActiveMarkdownView: Plugin.prototype.findActiveMarkdownView,
    templaterWillProcess: vi.fn().mockReturnValue(false),
    settings,
  } as any;
}

// ---------------------------------------------------------------------------
// isNewlyCreated
// ---------------------------------------------------------------------------

describe('isNewlyCreated', () => {
  it('returns true for a file created right now', () => {
    const plugin = makePlugin();
    expect(plugin.isNewlyCreated(makeFile('test.md', Date.now()))).toBe(true);
  });

  it('returns true for a file created 4 seconds ago', () => {
    const plugin = makePlugin();
    expect(plugin.isNewlyCreated(makeFile('test.md', Date.now() - 4_000))).toBe(true);
  });

  it('returns false for a file created 6 seconds ago', () => {
    const plugin = makePlugin();
    expect(plugin.isNewlyCreated(makeFile('test.md', Date.now() - 6_000))).toBe(false);
  });

  it('returns false for an old file', () => {
    const plugin = makePlugin();
    expect(plugin.isNewlyCreated(makeFile('test.md', Date.now() - 60_000))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleFileOpen
// ---------------------------------------------------------------------------

describe('handleFileOpen', () => {
  it('does nothing for null', () => {
    const plugin = makePlugin();
    expect(() => plugin.handleFileOpen(null)).not.toThrow();
  });

  it('skips excluded folders', () => {
    const plugin = makePlugin('body', 'none', ['Templates']);
    const view = makeView([], 'Templates/note.md');
    plugin.app.workspace.getActiveViewOfType.mockReturnValue(view);
    const spy = vi.spyOn(plugin, 'setCursorPosition');
    plugin.handleFileOpen(makeFile('Templates/note.md'));
    expect(spy).not.toHaveBeenCalled();
  });

  it('does nothing when no MarkdownView is active', () => {
    const plugin = makePlugin('body');
    const spy = vi.spyOn(plugin, 'setCursorPosition');
    plugin.handleFileOpen(makeFile());
    expect(spy).not.toHaveBeenCalled();
  });

  it('applies onCreate for a new file', () => {
    const plugin = makePlugin('end', 'none');
    const view = makeView(['content']);
    plugin.app.workspace.getActiveViewOfType.mockReturnValue(view);
    const spy = vi.spyOn(plugin, 'applyPosition');
    plugin.handleFileOpen(makeFile('test.md', Date.now()));
    expect(spy).toHaveBeenCalledWith(view, expect.anything(), 'end', true);
  });

  it('applies onOpen for an old file', () => {
    const plugin = makePlugin('title', 'body');
    const view = makeView(['content']);
    plugin.app.workspace.getActiveViewOfType.mockReturnValue(view);
    const spy = vi.spyOn(plugin, 'applyPosition');
    plugin.handleFileOpen(makeFile('test.md', Date.now() - 60_000));
    expect(spy).toHaveBeenCalledWith(view, expect.anything(), 'body', false);
  });

  it('skips when resolved position is none', () => {
    const plugin = makePlugin('title', 'none');
    const view = makeView(['content']);
    plugin.app.workspace.getActiveViewOfType.mockReturnValue(view);
    const spy = vi.spyOn(plugin, 'setCursorPosition');
    plugin.handleFileOpen(makeFile('test.md', Date.now() - 60_000));
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Templater compatibility
// ---------------------------------------------------------------------------

describe('Templater compatibility', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('defers and skips for Templater files with no frontmatter override', () => {
    const plugin = makePlugin('body');
    plugin.templaterWillProcess.mockReturnValue(true);
    const emptyView = makeView(['']);
    plugin.app.workspace.getActiveViewOfType.mockReturnValue(emptyView);
    const spy = vi.spyOn(plugin, 'applyPosition');
    plugin.handleFileOpen(makeFile('test.md', Date.now()));
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(350);
    expect(spy).not.toHaveBeenCalled(); // empty — no override
  });

  it('defers and applies frontmatter override after Templater writes', () => {
    const plugin = makePlugin('body');
    plugin.templaterWillProcess.mockReturnValue(true);
    const emptyView = makeView(['']);
    const templateView = makeView(['---', 'cursor-position: end', '---', '', 'content']);
    plugin.app.workspace.getActiveViewOfType
      .mockReturnValueOnce(emptyView)
      .mockReturnValue(templateView);
    const spy = vi.spyOn(plugin, 'applyPosition');
    plugin.handleFileOpen(makeFile('test.md', Date.now()));
    vi.advanceTimersByTime(350);
    expect(spy).toHaveBeenCalledWith(templateView, expect.anything(), 'end', true);
  });

  it('fires immediately for non-Templater files', () => {
    const plugin = makePlugin('body');
    plugin.templaterWillProcess.mockReturnValue(false);
    const view = makeView(['content']);
    plugin.app.workspace.getActiveViewOfType.mockReturnValue(view);
    const spy = vi.spyOn(plugin, 'applyPosition');
    plugin.handleFileOpen(makeFile('test.md', Date.now()));
    expect(spy).toHaveBeenCalledWith(view, expect.anything(), 'body', true);
  });
});

// ---------------------------------------------------------------------------
// applyPosition — desktop vs mobile routing
// ---------------------------------------------------------------------------

describe('applyPosition', () => {
  afterEach(() => { Platform.isMobile = false; });

  it('calls setCursorPosition on desktop', () => {
    Platform.isMobile = false;
    const plugin = makePlugin();
    const view = makeView([]);
    const spy = vi.spyOn(plugin, 'setCursorPosition');
    plugin.applyPosition(view, makeFile(), 'body', true);
    expect(spy).toHaveBeenCalledWith(view, 'body');
  });

  it('calls setCursorPosition for open events on mobile (no race condition)', () => {
    Platform.isMobile = true;
    const plugin = makePlugin();
    const view = makeView([]);
    const spy = vi.spyOn(plugin, 'setCursorPosition');
    plugin.applyPosition(view, makeFile(), 'body', false); // isNew=false
    expect(spy).toHaveBeenCalledWith(view, 'body');
  });

  it('calls scheduleMobilePosition for new notes on mobile', () => {
    Platform.isMobile = true;
    const plugin = makePlugin();
    const view = makeView([]);
    const spy = vi.spyOn(plugin, 'scheduleMobilePosition').mockImplementation(() => undefined);
    plugin.applyPosition(view, makeFile(), 'body', true);
    expect(spy).toHaveBeenCalledWith(view, expect.anything(), 'body');
  });
});

// ---------------------------------------------------------------------------
// scheduleMobilePosition
// ---------------------------------------------------------------------------

describe('scheduleMobilePosition', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('applies directly when inline-title is absent', () => {
    const plugin = makePlugin();
    const view = makeView(['content']);
    view.containerEl.querySelector = vi.fn().mockReturnValue(null);
    const spy = vi.spyOn(plugin, 'setCursorPosition');
    plugin.scheduleMobilePosition(view, makeFile(), 'body');
    expect(spy).toHaveBeenCalledWith(view, 'body');
  });

  it('does nothing for title mode (Obsidian default is correct)', () => {
    const plugin = makePlugin();
    const view = makeView([]);
    const spy = vi.spyOn(plugin, 'setCursorPosition');
    plugin.scheduleMobilePosition(view, makeFile(), 'title');
    vi.runAllTimers();
    expect(spy).not.toHaveBeenCalled();
  });

  it('redirects to body after title focus fires', () => {
    const plugin = makePlugin();
    const view = makeView(['# Content']);
    plugin.app.workspace.getActiveViewOfType.mockReturnValue(view);
    plugin.scheduleMobilePosition(view, makeFile(), 'body');
    view._titleEl.dispatchEvent(new Event('focus'));
    vi.runAllTimers();
    expect(view.editor.focus).toHaveBeenCalled();
    expect(view.editor.setCursor).toHaveBeenCalledWith({ ch: 0, line: 0 });
  });

  it('redirects to end after title focus fires', () => {
    const plugin = makePlugin();
    const view = makeView(['first', 'last line']);
    plugin.app.workspace.getActiveViewOfType.mockReturnValue(view);
    plugin.scheduleMobilePosition(view, makeFile(), 'end');
    view._titleEl.dispatchEvent(new Event('focus'));
    vi.runAllTimers();
    expect(view.editor.setCursor).toHaveBeenCalledWith({ ch: 9, line: 1 });
  });

  it('selects all in title for title-highlighted after focus fires', () => {
    const plugin = makePlugin();
    const view = makeView([]);
    plugin.app.workspace.getActiveViewOfType.mockReturnValue(view);
    plugin.scheduleMobilePosition(view, makeFile(), 'title-highlighted');
    view._titleEl.dispatchEvent(new Event('focus'));
    vi.runAllTimers();
    expect(view.editor.focus).not.toHaveBeenCalled();
    expect(view.editor.setCursor).not.toHaveBeenCalled();
  });

  it('does not fire twice (once: true)', () => {
    const plugin = makePlugin();
    const view = makeView(['content']);
    plugin.app.workspace.getActiveViewOfType.mockReturnValue(view);
    plugin.scheduleMobilePosition(view, makeFile(), 'body');
    view._titleEl.dispatchEvent(new Event('focus'));
    view._titleEl.dispatchEvent(new Event('focus'));
    vi.runAllTimers();
    expect(view.editor.setCursor).toHaveBeenCalledTimes(1);
  });

  it('cleans up listener after safety timeout', () => {
    const plugin = makePlugin();
    const view = makeView(['content']);
    const removeSpy = vi.spyOn(view._titleEl, 'removeEventListener');
    plugin.scheduleMobilePosition(view, makeFile(), 'body');
    vi.advanceTimersByTime(2_000);
    expect(removeSpy).toHaveBeenCalled();
    expect(view.editor.setCursor).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// isExcluded
// ---------------------------------------------------------------------------

describe('isExcluded', () => {
  it('returns false when no folders excluded', () => {
    expect(makePlugin('body', 'none', []).isExcluded(makeFile('Notes/foo.md'))).toBe(false);
  });

  it('excludes a file inside an excluded folder', () => {
    expect(makePlugin('body', 'none', ['Templates']).isExcluded(makeFile('Templates/daily.md'))).toBe(true);
  });

  it('does not exclude a folder with a similar name prefix', () => {
    expect(makePlugin('body', 'none', ['Templates']).isExcluded(makeFile('TemplatesBackup/note.md'))).toBe(false);
  });

  it('handles trailing slashes', () => {
    expect(makePlugin('body', 'none', ['Templates/']).isExcluded(makeFile('Templates/note.md'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getFrontmatterOverride
// ---------------------------------------------------------------------------

describe('getFrontmatterOverride', () => {
  function override(lines: string[], isNew = true) {
    return makePlugin().getFrontmatterOverride(makeView(lines), isNew);
  }

  it('returns null when no frontmatter', () => {
    expect(override(['# Title', 'content'])).toBeNull();
  });

  it('returns value from cursor-position', () => {
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
    return makePlugin().getBodyStart(makeView(lines));
  }

  it('returns {line:0} for a plain note', () => {
    expect(bodyStart(['content'])).toEqual({ ch: 0, line: 0 });
  });

  it('skips blank line after frontmatter and lands on content', () => {
    expect(bodyStart(['---', 'title: Note', '---', '', '# Body'])).toEqual({ ch: 0, line: 4 });
  });

  it('lands directly after --- when no blank line', () => {
    expect(bodyStart(['---', 'title: Note', '---', '# Body'])).toEqual({ ch: 0, line: 3 });
  });

  it('returns {line:0} for unclosed frontmatter', () => {
    expect(bodyStart(['---', 'title: Note'])).toEqual({ ch: 0, line: 0 });
  });
});

// ---------------------------------------------------------------------------
// setCursorPosition
// ---------------------------------------------------------------------------

describe('setCursorPosition', () => {
  describe('title', () => {
    it('calls setEphemeralState and focuses title', () => {
      const plugin = makePlugin();
      const view = makeView([]);
      plugin.setCursorPosition(view, 'title');
      expect(view.leaf.setEphemeralState).toHaveBeenCalledWith({ rename: 'end' });
      expect(view._titleEl.focus).toHaveBeenCalled();
    });

    it('falls back to body when inline-title absent', () => {
      const plugin = makePlugin();
      const view = makeView(['content']);
      view.containerEl.querySelector = vi.fn().mockReturnValue(null);
      plugin.setCursorPosition(view, 'title');
      expect(view.editor.setCursor).toHaveBeenCalledWith({ ch: 0, line: 0 });
    });
  });

  describe('title-highlighted', () => {
    it('calls setEphemeralState({ rename: "all" }) and focuses', () => {
      const plugin = makePlugin();
      const view = makeView([]);
      plugin.setCursorPosition(view, 'title-highlighted');
      expect(view.leaf.setEphemeralState).toHaveBeenCalledWith({ rename: 'all' });
      expect(view._titleEl.focus).toHaveBeenCalled();
    });
  });

  describe('body', () => {
    it('places cursor at body start', () => {
      const plugin = makePlugin();
      const view = makeView(['---', 'title: T', '---', '', 'Content']);
      plugin.setCursorPosition(view, 'body');
      expect(view.editor.setCursor).toHaveBeenCalledWith({ ch: 0, line: 4 });
    });
  });

  describe('end', () => {
    it('places cursor at end of last line', () => {
      const plugin = makePlugin();
      const view = makeView(['first', 'last line']);
      plugin.setCursorPosition(view, 'end');
      expect(view.editor.setCursor).toHaveBeenCalledWith({ ch: 9, line: 1 });
    });
  });
});

// ---------------------------------------------------------------------------
// templaterWillProcess
// ---------------------------------------------------------------------------

describe('templaterWillProcess', () => {
  function pluginWithTemplater(config: Record<string, unknown>) {
    const plugin = makePlugin();
    plugin.templaterWillProcess = Plugin.prototype.templaterWillProcess;
    (plugin.app as any).plugins = { plugins: config };
    return plugin;
  }

  it('returns false when Templater not installed', () => {
    expect(pluginWithTemplater({}).templaterWillProcess(makeFile())).toBe(false);
  });

  it('returns true when file is in files_with_pending_templates', () => {
    const p = pluginWithTemplater({
      'templater-obsidian': {
        templater: { files_with_pending_templates: new Set(['test.md']) },
        settings: { trigger_on_file_creation: false },
      },
    });
    expect(p.templaterWillProcess(makeFile('test.md'))).toBe(true);
  });

  it('returns true when trigger_on_file_creation is enabled', () => {
    const p = pluginWithTemplater({
      'templater-obsidian': {
        templater: { files_with_pending_templates: new Set() },
        settings: { trigger_on_file_creation: true },
      },
    });
    expect(p.templaterWillProcess(makeFile())).toBe(true);
  });

  it('returns false when Templater installed but not handling this file', () => {
    const p = pluginWithTemplater({
      'templater-obsidian': {
        templater: { files_with_pending_templates: new Set() },
        settings: { trigger_on_file_creation: false },
      },
    });
    expect(p.templaterWillProcess(makeFile())).toBe(false);
  });
});
