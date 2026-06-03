import type { App, TAbstractFile, TFile, WorkspaceLeaf } from 'obsidian';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CursorPosition, CursorPositionOrNone } from './PluginSettings.ts';

import { Plugin } from './Plugin.ts';
import { PluginSettings } from './PluginSettings.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FileRecord { createdAt: number; templaterWillProcess: boolean; }

function record(opts: Partial<FileRecord> = {}): FileRecord {
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

function makeView(lines: string[]) {
  const leaf = { setEphemeralState: vi.fn() } as unknown as WorkspaceLeaf;
  const editor = makeEditor(lines);
  const titleEl = { focus: vi.fn() } as unknown as HTMLElement;
  const containerEl = { querySelector: vi.fn().mockReturnValue(titleEl) } as unknown as HTMLElement;
  return { containerEl, editor, file: { path: 'test.md' } as TFile, leaf, _titleEl: titleEl };
}

function makePlugin(onCreate: CursorPosition = 'body', onOpen: CursorPositionOrNone = 'none') {
  const settings = new PluginSettings();
  settings.onCreate = onCreate;
  settings.onOpen = onOpen;

  return {
    app: {
      vault: { on: vi.fn().mockReturnValue({ id: 1 }) },
      workspace: {
        getActiveViewOfType: vi.fn(),
        on: vi.fn().mockReturnValue({ id: 2 }),
      },
    } as unknown as App,
    handleCreate: Plugin.prototype.handleCreate,
    handleFileOpen: Plugin.prototype.handleFileOpen,
    consumeRecord: Plugin.prototype.consumeRecord,
    resolvePosition: Plugin.prototype.resolvePosition,
    getFrontmatterOverride: Plugin.prototype.getFrontmatterOverride,
    getBodyStart: Plugin.prototype.getBodyStart,
    setCursorPosition: Plugin.prototype.setCursorPosition,
    recentlyCreated: new Map<string, FileRecord>(),
    settings,
    // Stub — tests override per-case
    templaterWillProcess: vi.fn().mockReturnValue(false),
  } as any;
}

// ---------------------------------------------------------------------------
// handleCreate
// ---------------------------------------------------------------------------

describe('handleCreate', () => {
  it('records a markdown file with a fresh timestamp', () => {
    const plugin = makePlugin();
    const before = Date.now();
    plugin.handleCreate({ path: 'notes/foo.md' } as TAbstractFile);
    const rec: FileRecord = plugin.recentlyCreated.get('notes/foo.md')!;
    expect(rec.createdAt).toBeGreaterThanOrEqual(before);
    expect(rec.createdAt).toBeLessThanOrEqual(Date.now());
  });

  it('snapshots templaterWillProcess at create time', () => {
    const plugin = makePlugin();
    plugin.templaterWillProcess.mockReturnValue(true);
    plugin.handleCreate({ path: 'templ.md' } as TAbstractFile);
    expect(plugin.recentlyCreated.get('templ.md').templaterWillProcess).toBe(true);
  });

  it('ignores non-markdown files', () => {
    const plugin = makePlugin();
    plugin.handleCreate({ path: 'image.png' } as TAbstractFile);
    plugin.handleCreate({ path: 'data.json' } as TAbstractFile);
    expect(plugin.recentlyCreated.size).toBe(0);
  });

  it('records multiple markdown files independently', () => {
    const plugin = makePlugin();
    plugin.handleCreate({ path: 'a.md' } as TAbstractFile);
    plugin.handleCreate({ path: 'b.md' } as TAbstractFile);
    expect(plugin.recentlyCreated.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// consumeRecord
// ---------------------------------------------------------------------------

describe('consumeRecord', () => {
  it('returns the record and removes the entry for a recent file', () => {
    const plugin = makePlugin();
    plugin.recentlyCreated.set('test.md', record());
    const result = plugin.consumeRecord({ path: 'test.md' } as TFile);
    expect(result).not.toBeNull();
    expect(plugin.recentlyCreated.has('test.md')).toBe(false);
  });

  it('returns null for an untracked file', () => {
    expect(makePlugin().consumeRecord({ path: 'x.md' } as TFile)).toBeNull();
  });

  it('returns null and removes stale entries (> 5 s)', () => {
    const plugin = makePlugin();
    plugin.recentlyCreated.set('old.md', record({ createdAt: Date.now() - 6_000 }));
    expect(plugin.consumeRecord({ path: 'old.md' } as TFile)).toBeNull();
    expect(plugin.recentlyCreated.has('old.md')).toBe(false);
  });

  it('returns the record for an entry just inside the 5 s window', () => {
    const plugin = makePlugin();
    plugin.recentlyCreated.set('test.md', record({ createdAt: Date.now() - 4_999 }));
    expect(plugin.consumeRecord({ path: 'test.md' } as TFile)).not.toBeNull();
  });

  it('preserves templaterWillProcess from the record', () => {
    const plugin = makePlugin();
    plugin.recentlyCreated.set('test.md', record({ templaterWillProcess: true }));
    const result = plugin.consumeRecord({ path: 'test.md' } as TFile);
    expect(result?.templaterWillProcess).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleFileOpen — routing
// ---------------------------------------------------------------------------

describe('handleFileOpen', () => {
  it('does nothing when file is null', () => {
    const plugin = makePlugin();
    const spy = vi.spyOn(plugin, 'setCursorPosition');
    plugin.handleFileOpen(null);
    expect(spy).not.toHaveBeenCalled();
  });

  it('does nothing when there is no active MarkdownView', () => {
    const plugin = makePlugin();
    plugin.recentlyCreated.set('test.md', record());
    plugin.app.workspace.getActiveViewOfType.mockReturnValue(null);
    const spy = vi.spyOn(plugin, 'setCursorPosition');
    plugin.handleFileOpen({ path: 'test.md' } as TFile);
    expect(spy).not.toHaveBeenCalled();
  });

  it('does nothing when active view is for a different file', () => {
    const plugin = makePlugin();
    plugin.recentlyCreated.set('test.md', record());
    const wrongView = { ...makeView([]), file: { path: 'other.md' } as TFile };
    plugin.app.workspace.getActiveViewOfType.mockReturnValue(wrongView);
    const spy = vi.spyOn(plugin, 'setCursorPosition');
    plugin.handleFileOpen({ path: 'test.md' } as TFile);
    expect(spy).not.toHaveBeenCalled();
  });

  it('applies onCreate position for a new file', () => {
    const plugin = makePlugin('end', 'none');
    plugin.recentlyCreated.set('test.md', record());
    const view = makeView(['content']);
    plugin.app.workspace.getActiveViewOfType.mockReturnValue(view);
    const spy = vi.spyOn(plugin, 'setCursorPosition');
    plugin.handleFileOpen({ path: 'test.md' } as TFile);
    expect(spy).toHaveBeenCalledWith(view, 'end');
  });

  it('applies onOpen position for an existing file', () => {
    const plugin = makePlugin('title', 'body');
    const view = makeView(['content']);
    plugin.app.workspace.getActiveViewOfType.mockReturnValue(view);
    const spy = vi.spyOn(plugin, 'setCursorPosition');
    plugin.handleFileOpen({ path: 'test.md' } as TFile);
    expect(spy).toHaveBeenCalledWith(view, 'body');
  });

  it('skips onOpen when set to none', () => {
    const plugin = makePlugin('title', 'none');
    const view = makeView(['content']);
    plugin.app.workspace.getActiveViewOfType.mockReturnValue(view);
    const spy = vi.spyOn(plugin, 'setCursorPosition');
    plugin.handleFileOpen({ path: 'test.md' } as TFile);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Templater compatibility
// ---------------------------------------------------------------------------

describe('Templater compatibility', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('defers and skips when Templater will process and no frontmatter override', () => {
    const plugin = makePlugin('body');
    plugin.recentlyCreated.set('test.md', record({ templaterWillProcess: true }));
    const view = makeView(['']); // empty — Templater hasn't written yet
    plugin.app.workspace.getActiveViewOfType.mockReturnValue(view);
    const spy = vi.spyOn(plugin, 'setCursorPosition');

    plugin.handleFileOpen({ path: 'test.md' } as TFile);
    expect(spy).not.toHaveBeenCalled();

    // After defer, empty file still has no override → Templater wins
    vi.advanceTimersByTime(350);
    expect(spy).not.toHaveBeenCalled();
  });

  it('defers and applies frontmatter override after Templater writes the template', () => {
    const plugin = makePlugin('body');
    plugin.recentlyCreated.set('test.md', record({ templaterWillProcess: true }));

    const emptyView = makeView(['']);
    const templateView = makeView(['---', 'cursor-position: end', '---', '', 'Template content']);
    plugin.app.workspace.getActiveViewOfType
      .mockReturnValueOnce(emptyView)
      .mockReturnValue(templateView);

    const spy = vi.spyOn(plugin, 'setCursorPosition');
    plugin.handleFileOpen({ path: 'test.md' } as TFile);
    expect(spy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(350);
    expect(spy).toHaveBeenCalledWith(templateView, 'end');
  });

  it('does not defer for non-Templater files', () => {
    const plugin = makePlugin('body');
    plugin.recentlyCreated.set('test.md', record({ templaterWillProcess: false }));
    const view = makeView(['content']);
    plugin.app.workspace.getActiveViewOfType.mockReturnValue(view);
    const spy = vi.spyOn(plugin, 'setCursorPosition');

    plugin.handleFileOpen({ path: 'test.md' } as TFile);
    expect(spy).toHaveBeenCalledWith(view, 'body');
  });

  it('defers when Templater folder-trigger is on (snapshotted at create time)', () => {
    const plugin = makePlugin('body');
    // Simulates a file where trigger_on_file_creation=true was detected at create time
    plugin.recentlyCreated.set('test.md', record({ templaterWillProcess: true }));
    const view = makeView(['no frontmatter content']);
    plugin.app.workspace.getActiveViewOfType.mockReturnValue(view);
    const spy = vi.spyOn(plugin, 'setCursorPosition');

    plugin.handleFileOpen({ path: 'test.md' } as TFile);
    // Deferred because Templater might write a template
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// templaterWillProcess
// ---------------------------------------------------------------------------

describe('templaterWillProcess', () => {
  function makePluginWithApp(pluginsObj: Record<string, unknown>) {
    const plugin = makePlugin();
    // Replace the stubbed method with the real one
    plugin.templaterWillProcess = Plugin.prototype.templaterWillProcess;
    (plugin.app as any).plugins = { plugins: pluginsObj };
    return plugin;
  }

  it('returns false when Templater is not installed', () => {
    const plugin = makePluginWithApp({});
    expect(plugin.templaterWillProcess({ path: 'test.md' } as TFile)).toBe(false);
  });

  it('returns true when file is in files_with_pending_templates', () => {
    const plugin = makePluginWithApp({
      'templater-obsidian': {
        templater: { files_with_pending_templates: new Set(['test.md']) },
        settings: { trigger_on_file_creation: false },
      },
    });
    expect(plugin.templaterWillProcess({ path: 'test.md' } as TFile)).toBe(true);
  });

  it('returns false when file is not in files_with_pending_templates and trigger is off', () => {
    const plugin = makePluginWithApp({
      'templater-obsidian': {
        templater: { files_with_pending_templates: new Set() },
        settings: { trigger_on_file_creation: false },
      },
    });
    expect(plugin.templaterWillProcess({ path: 'test.md' } as TFile)).toBe(false);
  });

  it('returns true when trigger_on_file_creation is enabled', () => {
    const plugin = makePluginWithApp({
      'templater-obsidian': {
        templater: { files_with_pending_templates: new Set() },
        settings: { trigger_on_file_creation: true },
      },
    });
    expect(plugin.templaterWillProcess({ path: 'test.md' } as TFile)).toBe(true);
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

  it('frontmatter override takes precedence over onCreate', () => {
    const plugin = makePlugin('title', 'none');
    const view = makeView(['---', 'cursor-position: body', '---']);
    expect(plugin.resolvePosition(view, true)).toBe('body');
  });

  it('frontmatter override takes precedence over onOpen', () => {
    const plugin = makePlugin('title', 'body');
    const view = makeView(['---', 'cursor-position: end', '---']);
    expect(plugin.resolvePosition(view, false)).toBe('end');
  });
});

// ---------------------------------------------------------------------------
// getFrontmatterOverride
// ---------------------------------------------------------------------------

describe('getFrontmatterOverride', () => {
  function override(lines: string[]) {
    return makePlugin().getFrontmatterOverride(makeView(lines));
  }

  it('returns null for a note with no frontmatter', () => {
    expect(override(['# Title', '', 'content'])).toBeNull();
  });

  it('returns null for an empty note', () => {
    expect(override([''])).toBeNull();
  });

  it('returns null when frontmatter has no cursor-position key', () => {
    expect(override(['---', 'title: My Note', '---', 'content'])).toBeNull();
  });

  it.each([
    ['body'],
    ['end'],
    ['title'],
    ['title-highlighted'],
  ] as [CursorPosition][][])('returns %s when set in frontmatter', (value) => {
    expect(override(['---', `cursor-position: ${value}`, '---'])).toBe(value);
  });

  it('accepts double-quoted values', () => {
    expect(override(['---', 'cursor-position: "body"', '---'])).toBe('body');
  });

  it('accepts single-quoted values', () => {
    expect(override(['---', "cursor-position: 'end'", '---'])).toBe('end');
  });

  it('returns null for an unrecognised value', () => {
    expect(override(['---', 'cursor-position: nowhere', '---'])).toBeNull();
  });

  it('finds the key among other frontmatter fields', () => {
    const lines = ['---', 'title: Note', 'tags: [a]', 'cursor-position: end', 'date: 2024-01-01', '---'];
    expect(override(lines)).toBe('end');
  });

  it('ignores cursor-position that appears after the closing ---', () => {
    expect(override(['---', 'title: Note', '---', 'cursor-position: body'])).toBeNull();
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

  it('returns {line:0} when there is no frontmatter', () => {
    expect(bodyStart(['# Heading', '', 'Content'])).toEqual({ ch: 0, line: 0 });
  });

  it('skips empty line after --- and lands on first content line', () => {
    expect(bodyStart(['---', 'title: Note', '---', '', '# Body'])).toEqual({ ch: 0, line: 4 });
  });

  it('lands directly after --- when no empty line follows', () => {
    expect(bodyStart(['---', 'title: Note', '---', '# Body'])).toEqual({ ch: 0, line: 3 });
  });

  it('clamps to last line when frontmatter has no body', () => {
    expect(bodyStart(['---', 'title: Note', '---'])).toEqual({ ch: 0, line: 2 });
  });

  it('clamps when frontmatter ends with empty line but no content', () => {
    expect(bodyStart(['---', 'title: Note', '---', ''])).toEqual({ ch: 0, line: 3 });
  });

  it('returns {line:0} for unclosed frontmatter', () => {
    expect(bodyStart(['---', 'title: Note', 'no closing delimiter'])).toEqual({ ch: 0, line: 0 });
  });

  it('handles whitespace on the closing delimiter', () => {
    expect(bodyStart(['---', 'title: Note', '--- ', 'Body'])).toEqual({ ch: 0, line: 3 });
  });

  it('does not treat --- in body as frontmatter', () => {
    expect(bodyStart(['# Title', '---', 'Paragraph'])).toEqual({ ch: 0, line: 0 });
  });
});

// ---------------------------------------------------------------------------
// setCursorPosition
// ---------------------------------------------------------------------------

describe('setCursorPosition', () => {
  describe('title', () => {
    it('calls setEphemeralState({ rename: "end" })', () => {
      const plugin = makePlugin();
      const view = makeView([]);
      plugin.setCursorPosition(view, 'title');
      expect(view.leaf.setEphemeralState).toHaveBeenCalledWith({ rename: 'end' });
    });

    it('focuses the inline-title element for mobile keyboard', () => {
      const plugin = makePlugin();
      const view = makeView([]);
      plugin.setCursorPosition(view, 'title');
      expect(view._titleEl.focus).toHaveBeenCalled();
    });

    it('does not move the editor cursor', () => {
      const plugin = makePlugin();
      const view = makeView(['content']);
      plugin.setCursorPosition(view, 'title');
      expect(view.editor.setCursor).not.toHaveBeenCalled();
    });
  });

  describe('title-highlighted', () => {
    it('calls setEphemeralState({ rename: "all" })', () => {
      const plugin = makePlugin();
      const view = makeView([]);
      plugin.setCursorPosition(view, 'title-highlighted');
      expect(view.leaf.setEphemeralState).toHaveBeenCalledWith({ rename: 'all' });
    });

    it('focuses the inline-title element for mobile keyboard', () => {
      const plugin = makePlugin();
      const view = makeView([]);
      plugin.setCursorPosition(view, 'title-highlighted');
      expect(view._titleEl.focus).toHaveBeenCalled();
    });

    it('does not move the editor cursor', () => {
      const plugin = makePlugin();
      const view = makeView(['content']);
      plugin.setCursorPosition(view, 'title-highlighted');
      expect(view.editor.setCursor).not.toHaveBeenCalled();
    });
  });

  describe('body', () => {
    it('focuses the editor', () => {
      const plugin = makePlugin();
      const view = makeView(['line 0']);
      plugin.setCursorPosition(view, 'body');
      expect(view.editor.focus).toHaveBeenCalled();
    });

    it('places cursor at line 0 for a plain note', () => {
      const plugin = makePlugin();
      const view = makeView(['Hello world']);
      plugin.setCursorPosition(view, 'body');
      expect(view.editor.setCursor).toHaveBeenCalledWith({ ch: 0, line: 0 });
    });

    it('skips frontmatter and blank line', () => {
      const plugin = makePlugin();
      const view = makeView(['---', 'title: Test', '---', '', 'Body here']);
      plugin.setCursorPosition(view, 'body');
      expect(view.editor.setCursor).toHaveBeenCalledWith({ ch: 0, line: 4 });
    });

    it('does not call setEphemeralState', () => {
      const plugin = makePlugin();
      const view = makeView(['content']);
      plugin.setCursorPosition(view, 'body');
      expect(view.leaf.setEphemeralState).not.toHaveBeenCalled();
    });
  });

  describe('end', () => {
    it('focuses the editor', () => {
      const plugin = makePlugin();
      const view = makeView(['line 0', 'line 1']);
      plugin.setCursorPosition(view, 'end');
      expect(view.editor.focus).toHaveBeenCalled();
    });

    it('places cursor at end of last line', () => {
      const plugin = makePlugin();
      const view = makeView(['first', 'second line', 'final']);
      plugin.setCursorPosition(view, 'end');
      expect(view.editor.setCursor).toHaveBeenCalledWith({ ch: 5, line: 2 });
    });

    it('handles empty last line (ch: 0)', () => {
      const plugin = makePlugin();
      const view = makeView(['some content', '']);
      plugin.setCursorPosition(view, 'end');
      expect(view.editor.setCursor).toHaveBeenCalledWith({ ch: 0, line: 1 });
    });

    it('does not call setEphemeralState', () => {
      const plugin = makePlugin();
      const view = makeView(['content']);
      plugin.setCursorPosition(view, 'end');
      expect(view.leaf.setEphemeralState).not.toHaveBeenCalled();
    });
  });
});
