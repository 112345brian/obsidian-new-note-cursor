import type { App, TAbstractFile, TFile, WorkspaceLeaf } from 'obsidian';
import { MarkdownView } from 'obsidian';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CursorPosition, CursorPositionOrNone } from './PluginSettings.ts';

import { Plugin } from './Plugin.ts';
import { PluginSettings } from './PluginSettings.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FileRecord { createdAt: number; templaterWillProcess: boolean; }

function rec(opts: Partial<FileRecord> = {}): FileRecord {
  return { createdAt: Date.now(), templaterWillProcess: false, ...opts };
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
  // Use a real DOM element so Range/Selection APIs work in JSDOM
  const titleEl = document.createElement('div');
  titleEl.contentEditable = 'true';
  vi.spyOn(titleEl, 'focus');
  const containerEl = { querySelector: vi.fn().mockReturnValue(titleEl) } as unknown as HTMLElement;
  // Use MarkdownView.prototype so instanceof checks pass in Plugin code
  const view = Object.assign(Object.create(MarkdownView.prototype), {
    containerEl, editor, file: { path } as TFile, leaf, _titleEl: titleEl,
  });
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

  const activeLeaf = { view: null as any };

  return {
    app: {
      vault: { on: vi.fn().mockReturnValue({ id: 1 }) },
      workspace: { activeLeaf, on: vi.fn().mockReturnValue({ id: 2 }) },
    } as unknown as App,
    handleCreate: Plugin.prototype.handleCreate,
    handleFileOpen: Plugin.prototype.handleFileOpen,
    consumeRecord: Plugin.prototype.consumeRecord,
    resolvePosition: Plugin.prototype.resolvePosition,
    getFrontmatterOverride: Plugin.prototype.getFrontmatterOverride,
    readFrontmatterKey: (Plugin.prototype as any).readFrontmatterKey,
    getBodyStart: Plugin.prototype.getBodyStart,
    setCursorPosition: Plugin.prototype.setCursorPosition,
    isExcluded: Plugin.prototype.isExcluded,
    findActiveMarkdownView: Plugin.prototype.findActiveMarkdownView,
    recentlyCreated: new Map<string, FileRecord>(),
    settings,
    templaterWillProcess: vi.fn().mockReturnValue(false),
  } as any;
}

// ---------------------------------------------------------------------------
// handleCreate
// ---------------------------------------------------------------------------

describe('handleCreate', () => {
  it('records a markdown file with timestamp and Templater snapshot', () => {
    const plugin = makePlugin();
    plugin.templaterWillProcess.mockReturnValue(true);
    const before = Date.now();
    plugin.handleCreate({ path: 'foo.md' } as TAbstractFile);
    const stored: FileRecord = plugin.recentlyCreated.get('foo.md')!;
    expect(stored.createdAt).toBeGreaterThanOrEqual(before);
    expect(stored.templaterWillProcess).toBe(true);
  });

  it('ignores non-markdown files', () => {
    const plugin = makePlugin();
    plugin.handleCreate({ path: 'image.png' } as TAbstractFile);
    expect(plugin.recentlyCreated.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// consumeRecord
// ---------------------------------------------------------------------------

describe('consumeRecord', () => {
  it('returns record and clears entry for a fresh file', () => {
    const plugin = makePlugin();
    plugin.recentlyCreated.set('test.md', rec());
    const result = plugin.consumeRecord({ path: 'test.md' } as TFile);
    expect(result).not.toBeNull();
    expect(plugin.recentlyCreated.has('test.md')).toBe(false);
  });

  it('returns null for an untracked file', () => {
    expect(makePlugin().consumeRecord({ path: 'x.md' } as TFile)).toBeNull();
  });

  it('returns null and clears stale entries', () => {
    const plugin = makePlugin();
    plugin.recentlyCreated.set('old.md', rec({ createdAt: Date.now() - 6_000 }));
    expect(plugin.consumeRecord({ path: 'old.md' } as TFile)).toBeNull();
    expect(plugin.recentlyCreated.has('old.md')).toBe(false);
  });

  it('returns record just inside the 5 s window', () => {
    const plugin = makePlugin();
    plugin.recentlyCreated.set('test.md', rec({ createdAt: Date.now() - 4_999 }));
    expect(plugin.consumeRecord({ path: 'test.md' } as TFile)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isExcluded (#5)
// ---------------------------------------------------------------------------

describe('isExcluded', () => {
  it('returns false when no folders are excluded', () => {
    const plugin = makePlugin('body', 'none', []);
    expect(plugin.isExcluded({ path: 'Notes/foo.md' } as TFile)).toBe(false);
  });

  it('excludes a file directly inside an excluded folder', () => {
    const plugin = makePlugin('body', 'none', ['Templates']);
    expect(plugin.isExcluded({ path: 'Templates/daily.md' } as TFile)).toBe(true);
  });

  it('excludes a file in a nested subfolder', () => {
    const plugin = makePlugin('body', 'none', ['Templates']);
    expect(plugin.isExcluded({ path: 'Templates/Sub/note.md' } as TFile)).toBe(true);
  });

  it('does not exclude a file in a folder with a similar name prefix', () => {
    const plugin = makePlugin('body', 'none', ['Templates']);
    expect(plugin.isExcluded({ path: 'TemplatesBackup/note.md' } as TFile)).toBe(false);
  });

  it('handles trailing slashes in excluded folder paths', () => {
    const plugin = makePlugin('body', 'none', ['Templates/']);
    expect(plugin.isExcluded({ path: 'Templates/note.md' } as TFile)).toBe(true);
  });

  it('ignores empty strings in excluded folders list', () => {
    const plugin = makePlugin('body', 'none', ['']);
    expect(plugin.isExcluded({ path: 'Notes/foo.md' } as TFile)).toBe(false);
  });

  it('checks multiple excluded folders', () => {
    const plugin = makePlugin('body', 'none', ['Archives', 'Templates']);
    expect(plugin.isExcluded({ path: 'Archives/old.md' } as TFile)).toBe(true);
    expect(plugin.isExcluded({ path: 'Templates/daily.md' } as TFile)).toBe(true);
    expect(plugin.isExcluded({ path: 'Notes/active.md' } as TFile)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findActiveMarkdownView (#6)
// ---------------------------------------------------------------------------

describe('findActiveMarkdownView', () => {
  it('returns the view when activeLeaf holds a MarkdownView for the right file', () => {
    const plugin = makePlugin();
    const view = makeView([]);
    plugin.app.workspace.activeLeaf = { view } as any;
    expect(plugin.findActiveMarkdownView({ path: 'test.md' } as TFile)).toBe(view);
  });

  it('returns null when no activeLeaf', () => {
    const plugin = makePlugin();
    plugin.app.workspace.activeLeaf = null;
    expect(plugin.findActiveMarkdownView({ path: 'test.md' } as TFile)).toBeNull();
  });

  it('returns null when activeLeaf holds a different file', () => {
    const plugin = makePlugin();
    const view = makeView([], 'other.md');
    plugin.app.workspace.activeLeaf = { view } as any;
    expect(plugin.findActiveMarkdownView({ path: 'test.md' } as TFile)).toBeNull();
  });

  it('returns null when activeLeaf view is not a MarkdownView', () => {
    const plugin = makePlugin();
    plugin.app.workspace.activeLeaf = { view: { type: 'graph' } } as any;
    expect(plugin.findActiveMarkdownView({ path: 'test.md' } as TFile)).toBeNull();
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
    plugin.recentlyCreated.set('Templates/note.md', rec());
    const view = makeView([], 'Templates/note.md');
    plugin.app.workspace.activeLeaf = { view } as any;
    const spy = vi.spyOn(plugin, 'setCursorPosition');
    plugin.handleFileOpen({ path: 'Templates/note.md' } as TFile);
    expect(spy).not.toHaveBeenCalled();
  });

  it('applies onCreate for a new non-excluded file', () => {
    const plugin = makePlugin('end', 'none');
    plugin.recentlyCreated.set('test.md', rec());
    const view = makeView(['content']);
    plugin.app.workspace.activeLeaf = { view } as any;
    const spy = vi.spyOn(plugin, 'setCursorPosition');
    plugin.handleFileOpen({ path: 'test.md' } as TFile);
    expect(spy).toHaveBeenCalledWith(view, 'end');
  });

  it('applies onOpen for an existing file', () => {
    const plugin = makePlugin('title', 'body');
    const view = makeView(['content']);
    plugin.app.workspace.activeLeaf = { view } as any;
    const spy = vi.spyOn(plugin, 'setCursorPosition');
    plugin.handleFileOpen({ path: 'test.md' } as TFile);
    expect(spy).toHaveBeenCalledWith(view, 'body');
  });

  it('skips when position resolves to none', () => {
    const plugin = makePlugin('title', 'none');
    const view = makeView(['content']);
    plugin.app.workspace.activeLeaf = { view } as any;
    const spy = vi.spyOn(plugin, 'setCursorPosition');
    plugin.handleFileOpen({ path: 'test.md' } as TFile);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Templater compatibility
// ---------------------------------------------------------------------------

describe('Templater compatibility', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('defers and skips when Templater will process with no frontmatter override', () => {
    const plugin = makePlugin('body');
    plugin.recentlyCreated.set('test.md', rec({ templaterWillProcess: true }));
    const view = makeView(['']);
    plugin.app.workspace.activeLeaf = { view } as any;
    const spy = vi.spyOn(plugin, 'setCursorPosition');
    plugin.handleFileOpen({ path: 'test.md' } as TFile);
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(350);
    expect(spy).not.toHaveBeenCalled();
  });

  it('defers and applies frontmatter cursor-position-create after Templater writes', () => {
    const plugin = makePlugin('body');
    plugin.recentlyCreated.set('test.md', rec({ templaterWillProcess: true }));
    const templateView = makeView(['---', 'cursor-position-create: end', '---', '', 'content']);
    plugin.app.workspace.activeLeaf = { view: makeView(['']) } as any;
    const spy = vi.spyOn(plugin, 'setCursorPosition');
    plugin.handleFileOpen({ path: 'test.md' } as TFile);
    plugin.app.workspace.activeLeaf = { view: templateView } as any;
    vi.advanceTimersByTime(350);
    expect(spy).toHaveBeenCalledWith(templateView, 'end');
  });

  it('does not apply when Templater deferred frontmatter override is none', () => {
    const plugin = makePlugin('body');
    plugin.recentlyCreated.set('test.md', rec({ templaterWillProcess: true }));
    const view = makeView(['---', 'cursor-position: none', '---']);
    plugin.app.workspace.activeLeaf = { view: makeView(['']) } as any;
    const spy = vi.spyOn(plugin, 'setCursorPosition');
    plugin.handleFileOpen({ path: 'test.md' } as TFile);
    plugin.app.workspace.activeLeaf = { view } as any;
    vi.advanceTimersByTime(350);
    expect(spy).not.toHaveBeenCalled();
  });

  it('fires immediately for non-Templater files', () => {
    const plugin = makePlugin('body');
    plugin.recentlyCreated.set('test.md', rec({ templaterWillProcess: false }));
    const view = makeView(['content']);
    plugin.app.workspace.activeLeaf = { view } as any;
    const spy = vi.spyOn(plugin, 'setCursorPosition');
    plugin.handleFileOpen({ path: 'test.md' } as TFile);
    expect(spy).toHaveBeenCalledWith(view, 'body');
  });
});

// ---------------------------------------------------------------------------
// getFrontmatterOverride — event-specific keys + none (#2, #3)
// ---------------------------------------------------------------------------

describe('getFrontmatterOverride', () => {
  function override(lines: string[], isNew = true) {
    return makePlugin().getFrontmatterOverride(makeView(lines), isNew);
  }

  it('returns null when no frontmatter', () => {
    expect(override(['# Title', 'content'])).toBeNull();
  });

  it('returns null when no cursor-position key', () => {
    expect(override(['---', 'title: Note', '---'])).toBeNull();
  });

  it('returns value from cursor-position for a create event', () => {
    expect(override(['---', 'cursor-position: body', '---'], true)).toBe('body');
  });

  it('returns value from cursor-position for an open event', () => {
    expect(override(['---', 'cursor-position: end', '---'], false)).toBe('end');
  });

  it('cursor-position-create takes precedence over cursor-position on create', () => {
    const lines = ['---', 'cursor-position: title', 'cursor-position-create: body', '---'];
    expect(override(lines, true)).toBe('body');
  });

  it('cursor-position-open takes precedence over cursor-position on open', () => {
    const lines = ['---', 'cursor-position: title', 'cursor-position-open: end', '---'];
    expect(override(lines, false)).toBe('end');
  });

  it('cursor-position-create does not affect open events', () => {
    const lines = ['---', 'cursor-position-create: body', '---'];
    expect(override(lines, false)).toBeNull();
  });

  it('cursor-position-open does not affect create events', () => {
    const lines = ['---', 'cursor-position-open: end', '---'];
    expect(override(lines, true)).toBeNull();
  });

  it('returns none when cursor-position is set to none', () => {
    expect(override(['---', 'cursor-position: none', '---'])).toBe('none');
  });

  it('returns none from cursor-position-create: none', () => {
    expect(override(['---', 'cursor-position-create: none', '---'], true)).toBe('none');
  });

  it('returns null for an unrecognised value', () => {
    expect(override(['---', 'cursor-position: somewhere-else', '---'])).toBeNull();
  });

  it('accepts quoted values', () => {
    expect(override(['---', 'cursor-position: "end"', '---'])).toBe('end');
    expect(override(['---', "cursor-position: 'body'", '---'])).toBe('body');
  });

  it('ignores key that appears after the closing ---', () => {
    expect(override(['---', '---', 'cursor-position: body'])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolvePosition
// ---------------------------------------------------------------------------

describe('resolvePosition', () => {
  it('returns onCreate for a new file with no override', () => {
    const plugin = makePlugin('end', 'body');
    expect(plugin.resolvePosition(makeView(['no frontmatter']), true)).toBe('end');
  });

  it('returns onOpen for an existing file with no override', () => {
    const plugin = makePlugin('end', 'body');
    expect(plugin.resolvePosition(makeView(['no frontmatter']), false)).toBe('body');
  });

  it('frontmatter override takes precedence', () => {
    const plugin = makePlugin('title', 'body');
    const view = makeView(['---', 'cursor-position: end', '---']);
    expect(plugin.resolvePosition(view, true)).toBe('end');
    expect(plugin.resolvePosition(view, false)).toBe('end');
  });

  it('frontmatter none resolves to none (explicit opt-out)', () => {
    const plugin = makePlugin('title', 'body');
    const view = makeView(['---', 'cursor-position: none', '---']);
    expect(plugin.resolvePosition(view, true)).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// getBodyStart
// ---------------------------------------------------------------------------

describe('getBodyStart', () => {
  function bodyStart(lines: string[]) {
    return makePlugin().getBodyStart(makeView(lines));
  }

  it('returns {line:0} for an empty note', () => {
    expect(bodyStart([''])).toEqual({ ch: 0, line: 0 });
  });

  it('returns {line:0} when no frontmatter', () => {
    expect(bodyStart(['# Heading', '', 'Content'])).toEqual({ ch: 0, line: 0 });
  });

  it('skips empty line after --- and lands on content', () => {
    expect(bodyStart(['---', 'title: Note', '---', '', '# Body'])).toEqual({ ch: 0, line: 4 });
  });

  it('lands directly after --- when no blank line follows', () => {
    expect(bodyStart(['---', 'title: Note', '---', '# Body'])).toEqual({ ch: 0, line: 3 });
  });

  it('clamps when no content after frontmatter', () => {
    expect(bodyStart(['---', 'title: Note', '---'])).toEqual({ ch: 0, line: 2 });
  });

  it('returns {line:0} for unclosed frontmatter', () => {
    expect(bodyStart(['---', 'title: Note'])).toEqual({ ch: 0, line: 0 });
  });
});

// ---------------------------------------------------------------------------
// setCursorPosition — including inline-title fallback (#4)
// ---------------------------------------------------------------------------

describe('setCursorPosition', () => {
  describe('title', () => {
    beforeEach(() => { vi.useFakeTimers(); });

    it('calls setEphemeralState synchronously then focuses and collapses selection after timeout', () => {
      const plugin = makePlugin();
      const view = makeView([]);
      plugin.setCursorPosition(view, 'title');
      // setEphemeralState fires immediately
      expect(view.leaf.setEphemeralState).toHaveBeenCalledWith({ rename: 'end' });
      // focus / selection deferred
      expect(view._titleEl.focus).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(view._titleEl.focus).toHaveBeenCalled();
    });

    it('does not move the editor cursor', () => {
      const plugin = makePlugin();
      const view = makeView(['content']);
      plugin.setCursorPosition(view, 'title');
      vi.runAllTimers();
      expect(view.editor.setCursor).not.toHaveBeenCalled();
    });

    it('falls back to body start synchronously when inline-title is absent', () => {
      const plugin = makePlugin();
      const view = makeView(['content']);
      view.containerEl.querySelector = vi.fn().mockReturnValue(null);
      plugin.setCursorPosition(view, 'title');
      expect(view.editor.focus).toHaveBeenCalled();
      expect(view.editor.setCursor).toHaveBeenCalledWith({ ch: 0, line: 0 });
    });
  });

  describe('title-highlighted', () => {
    beforeEach(() => { vi.useFakeTimers(); });

    it('calls setEphemeralState synchronously then focuses and selects all after timeout', () => {
      const plugin = makePlugin();
      const view = makeView([]);
      plugin.setCursorPosition(view, 'title-highlighted');
      expect(view.leaf.setEphemeralState).toHaveBeenCalledWith({ rename: 'all' });
      expect(view._titleEl.focus).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(view._titleEl.focus).toHaveBeenCalled();
    });

    it('falls back to body start synchronously when inline-title is absent', () => {
      const plugin = makePlugin();
      const view = makeView(['---', 'title: T', '---', '', 'content']);
      view.containerEl.querySelector = vi.fn().mockReturnValue(null);
      plugin.setCursorPosition(view, 'title-highlighted');
      expect(view.editor.setCursor).toHaveBeenCalledWith({ ch: 0, line: 4 });
    });
  });

  describe('body', () => {
    it('places cursor after frontmatter', () => {
      const plugin = makePlugin();
      const view = makeView(['---', 'title: T', '---', '', 'Body']);
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

  it('returns false when Templater is not installed', () => {
    const p = pluginWithTemplater({});
    expect(p.templaterWillProcess({ path: 'test.md' } as TFile)).toBe(false);
  });

  it('returns true when file is in files_with_pending_templates', () => {
    const p = pluginWithTemplater({
      'templater-obsidian': {
        templater: { files_with_pending_templates: new Set(['test.md']) },
        settings: { trigger_on_file_creation: false },
      },
    });
    expect(p.templaterWillProcess({ path: 'test.md' } as TFile)).toBe(true);
  });

  it('returns true when trigger_on_file_creation is enabled', () => {
    const p = pluginWithTemplater({
      'templater-obsidian': {
        templater: { files_with_pending_templates: new Set() },
        settings: { trigger_on_file_creation: true },
      },
    });
    expect(p.templaterWillProcess({ path: 'test.md' } as TFile)).toBe(true);
  });

  it('returns false when Templater installed but trigger off and file not pending', () => {
    const p = pluginWithTemplater({
      'templater-obsidian': {
        templater: { files_with_pending_templates: new Set() },
        settings: { trigger_on_file_creation: false },
      },
    });
    expect(p.templaterWillProcess({ path: 'test.md' } as TFile)).toBe(false);
  });
});
