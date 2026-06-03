import type { App, TAbstractFile, TFile, WorkspaceLeaf } from 'obsidian';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginTypes } from './PluginTypes.ts';

import { Plugin } from './Plugin.ts';
import { PluginSettings } from './PluginSettings.ts';

// ---------------------------------------------------------------------------
// Minimal Obsidian mocks
// ---------------------------------------------------------------------------

function makeEditor(lines: string[]) {
  return {
    focus: vi.fn(),
    getLine: vi.fn((n: number) => lines[n] ?? ''),
    lineCount: vi.fn(() => lines.length),
    setCursor: vi.fn(),
  };
}

function makeLeaf() {
  return { setEphemeralState: vi.fn() } as unknown as WorkspaceLeaf;
}

function makeView(lines: string[], setting: PluginSettings['cursorPosition'] = 'body') {
  const leaf = makeLeaf();
  const editor = makeEditor(lines);
  const titleEl = { focus: vi.fn() } as unknown as HTMLElement;
  const containerEl = {
    querySelector: vi.fn().mockReturnValue(titleEl),
  } as unknown as HTMLElement;

  return {
    containerEl,
    editor,
    file: { path: 'test.md' } as TFile,
    leaf,
    // expose titleEl for assertions
    _titleEl: titleEl,
  };
}

function makePlugin(cursorPosition: PluginSettings['cursorPosition'] = 'body') {
  const settings = new PluginSettings();
  settings.cursorPosition = cursorPosition;

  const getActiveViewOfType = vi.fn();

  const plugin = {
    app: {
      vault: {
        on: vi.fn().mockReturnValue({ id: 1 }),
      },
      workspace: {
        getActiveViewOfType,
        on: vi.fn().mockReturnValue({ id: 2 }),
      },
    } as unknown as App,
    handleCreate: Plugin.prototype.handleCreate,
    handleFileOpen: Plugin.prototype.handleFileOpen,
    applyPosition: Plugin.prototype.applyPosition,
    getBodyStart: Plugin.prototype.getBodyStart,
    recentlyCreated: new Map<string, number>(),
    settings,
  } as unknown as Plugin & {
    app: { workspace: { getActiveViewOfType: ReturnType<typeof vi.fn> } };
    recentlyCreated: Map<string, number>;
    settings: PluginSettings;
  };

  return plugin;
}

// ---------------------------------------------------------------------------
// handleCreate
// ---------------------------------------------------------------------------

describe('handleCreate', () => {
  it('records a markdown file in recentlyCreated', () => {
    const plugin = makePlugin();
    const before = Date.now();
    plugin.handleCreate({ path: 'notes/foo.md' } as TAbstractFile);
    const after = Date.now();

    expect(plugin.recentlyCreated.has('notes/foo.md')).toBe(true);
    const ts = plugin.recentlyCreated.get('notes/foo.md')!;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('ignores non-markdown files', () => {
    const plugin = makePlugin();
    plugin.handleCreate({ path: 'image.png' } as TAbstractFile);
    plugin.handleCreate({ path: 'data.json' } as TAbstractFile);
    plugin.handleCreate({ path: 'note.txt' } as TAbstractFile);
    expect(plugin.recentlyCreated.size).toBe(0);
  });

  it('records multiple markdown files independently', () => {
    const plugin = makePlugin();
    plugin.handleCreate({ path: 'a.md' } as TAbstractFile);
    plugin.handleCreate({ path: 'b.md' } as TAbstractFile);
    expect(plugin.recentlyCreated.size).toBe(2);
    expect(plugin.recentlyCreated.has('a.md')).toBe(true);
    expect(plugin.recentlyCreated.has('b.md')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleFileOpen
// ---------------------------------------------------------------------------

describe('handleFileOpen', () => {
  it('does nothing when file is null', () => {
    const plugin = makePlugin();
    const spy = vi.spyOn(plugin, 'applyPosition');
    plugin.handleFileOpen(null);
    expect(spy).not.toHaveBeenCalled();
  });

  it('does nothing for a file that was never created', () => {
    const plugin = makePlugin();
    const spy = vi.spyOn(plugin, 'applyPosition');
    plugin.handleFileOpen({ path: 'untracked.md' } as TFile);
    expect(spy).not.toHaveBeenCalled();
  });

  it('ignores stale entries older than 5 seconds', () => {
    const plugin = makePlugin();
    const spy = vi.spyOn(plugin, 'applyPosition');
    plugin.recentlyCreated.set('old.md', Date.now() - 6_000);
    plugin.handleFileOpen({ path: 'old.md' } as TFile);
    expect(spy).not.toHaveBeenCalled();
    expect(plugin.recentlyCreated.has('old.md')).toBe(false);
  });

  it('removes the entry after processing (no double-fire)', () => {
    const plugin = makePlugin();
    plugin.recentlyCreated.set('test.md', Date.now());
    (plugin.app.workspace as any).getActiveViewOfType.mockReturnValue(null);

    plugin.handleFileOpen({ path: 'test.md' } as TFile);
    expect(plugin.recentlyCreated.has('test.md')).toBe(false);

    // Second open of same file should be ignored
    const spy = vi.spyOn(plugin, 'applyPosition');
    plugin.handleFileOpen({ path: 'test.md' } as TFile);
    expect(spy).not.toHaveBeenCalled();
  });

  it('does nothing when the active view is for a different file', () => {
    const plugin = makePlugin();
    const spy = vi.spyOn(plugin, 'applyPosition');
    plugin.recentlyCreated.set('test.md', Date.now());

    const wrongView = makeView([]);
    wrongView.file = { path: 'other.md' } as TFile;
    (plugin.app.workspace as any).getActiveViewOfType.mockReturnValue(wrongView);

    plugin.handleFileOpen({ path: 'test.md' } as TFile);
    expect(spy).not.toHaveBeenCalled();
  });

  it('does nothing when there is no active MarkdownView', () => {
    const plugin = makePlugin();
    const spy = vi.spyOn(plugin, 'applyPosition');
    plugin.recentlyCreated.set('test.md', Date.now());
    (plugin.app.workspace as any).getActiveViewOfType.mockReturnValue(null);

    plugin.handleFileOpen({ path: 'test.md' } as TFile);
    expect(spy).not.toHaveBeenCalled();
  });

  it('calls applyPosition when everything lines up', () => {
    const plugin = makePlugin();
    const spy = vi.spyOn(plugin, 'applyPosition').mockImplementation(() => undefined);
    plugin.recentlyCreated.set('test.md', Date.now());
    const view = makeView([]);
    (plugin.app.workspace as any).getActiveViewOfType.mockReturnValue(view);

    plugin.handleFileOpen({ path: 'test.md' } as TFile);
    expect(spy).toHaveBeenCalledWith(view);
  });

  it('accepts entries created up to 5 seconds ago', () => {
    const plugin = makePlugin();
    const spy = vi.spyOn(plugin, 'applyPosition').mockImplementation(() => undefined);
    plugin.recentlyCreated.set('test.md', Date.now() - 4_999);
    const view = makeView([]);
    (plugin.app.workspace as any).getActiveViewOfType.mockReturnValue(view);

    plugin.handleFileOpen({ path: 'test.md' } as TFile);
    expect(spy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getBodyStart
// ---------------------------------------------------------------------------

describe('getBodyStart', () => {
  function bodyStart(lines: string[]) {
    const plugin = makePlugin();
    const view = makeView(lines) as any;
    return plugin.getBodyStart(view);
  }

  it('returns {line:0, ch:0} for an empty note', () => {
    expect(bodyStart([''])).toEqual({ ch: 0, line: 0 });
  });

  it('returns {line:0, ch:0} when there is no frontmatter', () => {
    expect(bodyStart(['# Heading', '', 'Content'])).toEqual({ ch: 0, line: 0 });
  });

  it('returns first line after closing --- for a standard frontmatter block', () => {
    const lines = ['---', 'title: My Note', 'tags: [test]', '---', '', '# Body'];
    expect(bodyStart(lines)).toEqual({ ch: 0, line: 4 });
  });

  it('lands on the closing --- line itself when there is no body after it', () => {
    const lines = ['---', 'title: My Note', '---'];
    // bodyLine would be 3 but lineCount is 3 → clamped to 2
    expect(bodyStart(lines)).toEqual({ ch: 0, line: 2 });
  });

  it('skips a single-line frontmatter block', () => {
    const lines = ['---', '---', 'Content here'];
    expect(bodyStart(lines)).toEqual({ ch: 0, line: 2 });
  });

  it('returns {line:0, ch:0} for unclosed frontmatter (no second ---)', () => {
    const lines = ['---', 'title: My Note', 'no closing delimiter'];
    expect(bodyStart(lines)).toEqual({ ch: 0, line: 0 });
  });

  it('handles frontmatter with inline whitespace on the delimiter', () => {
    // Obsidian trims the line, so '--- ' should still match
    const lines = ['---', 'title: My Note', '--- ', 'Body starts here'];
    expect(bodyStart(lines)).toEqual({ ch: 0, line: 3 });
  });

  it('does not treat --- in body content as frontmatter', () => {
    // First line is not ---, so no frontmatter detection
    const lines = ['# Title', '---', 'Paragraph'];
    expect(bodyStart(lines)).toEqual({ ch: 0, line: 0 });
  });

  it('places cursor on the empty line between frontmatter and content', () => {
    const lines = ['---', 'title: Note', '---', '', '# Heading', 'text'];
    expect(bodyStart(lines)).toEqual({ ch: 0, line: 3 });
  });
});

// ---------------------------------------------------------------------------
// applyPosition
// ---------------------------------------------------------------------------

describe('applyPosition', () => {
  describe('title mode', () => {
    it('calls setEphemeralState({ rename: "end" }) on the leaf', () => {
      const plugin = makePlugin('title');
      const view = makeView([]) as any;
      plugin.applyPosition(view);
      expect(view.leaf.setEphemeralState).toHaveBeenCalledWith({ rename: 'end' });
    });

    it('does not move the editor cursor', () => {
      const plugin = makePlugin('title');
      const view = makeView(['content']) as any;
      plugin.applyPosition(view);
      expect(view.editor.setCursor).not.toHaveBeenCalled();
    });
  });

  describe('title-highlighted mode', () => {
    it('calls setEphemeralState({ rename: "all" }) on the leaf', () => {
      const plugin = makePlugin('title-highlighted');
      const view = makeView([]) as any;
      plugin.applyPosition(view);
      expect(view.leaf.setEphemeralState).toHaveBeenCalledWith({ rename: 'all' });
    });

    it('does not move the editor cursor', () => {
      const plugin = makePlugin('title-highlighted');
      const view = makeView(['content']) as any;
      plugin.applyPosition(view);
      expect(view.editor.setCursor).not.toHaveBeenCalled();
    });
  });

  describe('body mode', () => {
    it('focuses the editor', () => {
      const plugin = makePlugin('body');
      const view = makeView(['line 0']) as any;
      plugin.applyPosition(view);
      expect(view.editor.focus).toHaveBeenCalled();
    });

    it('places cursor at line 0 for a plain note', () => {
      const plugin = makePlugin('body');
      const view = makeView(['Hello world']) as any;
      plugin.applyPosition(view);
      expect(view.editor.setCursor).toHaveBeenCalledWith({ ch: 0, line: 0 });
    });

    it('skips frontmatter and places cursor on first body line', () => {
      const plugin = makePlugin('body');
      const view = makeView(['---', 'title: Test', '---', '', 'Body here']) as any;
      plugin.applyPosition(view);
      expect(view.editor.setCursor).toHaveBeenCalledWith({ ch: 0, line: 3 });
    });

    it('does not call setEphemeralState', () => {
      const plugin = makePlugin('body');
      const view = makeView(['content']) as any;
      plugin.applyPosition(view);
      expect(view.leaf.setEphemeralState).not.toHaveBeenCalled();
    });
  });
});
