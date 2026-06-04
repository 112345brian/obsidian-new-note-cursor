# Cursor Control

An [Obsidian](https://obsidian.md) plugin that controls where the cursor lands when you create or open a note.

> **Note:** This plugin was built with [Claude](https://claude.ai) (Anthropic).

## Settings

Open **Settings → Cursor Control** to configure.

### On note creation / On note open

| Option | Behavior |
|---|---|
| **At the title** *(default)* | Cursor at the end of the inline title |
| **Title highlighted** | Entire title selected — start typing to overwrite, or use the separator key to append |
| **Beginning of the body** | Cursor placed after frontmatter (skipping the blank separator line) |
| **End of the note** | Cursor at the last line — useful for appending to template content |
| **None** *(on open only)* | Don't move the cursor |

### Title separator

Only applies to **Title highlighted** mode. Set a string (e.g. a space, ` - `, `_`) whose first character, when pressed while the title is fully selected, appends the full string instead of replacing the title.

Useful with timestamp-based note names: with separator set to ` - `, pressing Space turns `20260604` into `20260604 - ` with the cursor ready for your label.

### Excluded folders

Notes inside listed folders will never have their cursor moved.

### Debug mode

Enables `[CursorControl]` trace logs in the developer console (Cmd+Opt+I) for troubleshooting.

## Per-note overrides

Add a `cursor-position` key to a note's frontmatter to override the global setting for that note. Most useful in templates.

```yaml
---
cursor-position: body
---
```

Use `cursor-position-create:` or `cursor-position-open:` to target only one event. The specific key takes priority over the generic one.

Valid values: `title` · `title-highlighted` · `body` · `end` · `none`

## Templater compatibility

If Templater's **Trigger on new file creation** is enabled, Cursor Control defers 350 ms to let Templater write its content first. Frontmatter overrides set by the template are respected; otherwise the global `onCreate` setting applies.

## Installation

The plugin is not yet listed in the official Community Plugins directory.

### Via BRAT (recommended)

1. Install [BRAT](https://obsidian.md/plugins?id=obsidian42-brat) and enable it.
2. In BRAT settings, click **Add Beta Plugin** and enter:
   ```
   https://github.com/112345brian/cursor-control
   ```
3. Enable **Cursor Control** in **Settings → Community plugins**.

### Manual

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/112345brian/cursor-control/releases/latest).
2. Copy them into `<your vault>/.obsidian/plugins/cursor-control/`.
3. Enable **Cursor Control** in **Settings → Community plugins**.

## How it works

The plugin listens on `workspace.on('file-open')`. New files are detected by comparing `TFile.stat.ctime` to the current time (within a 5-second window) — this sidesteps the race condition where `vault.on('create')` fires after `file-open` and the newly-created set would always be empty.

For new notes, Obsidian asynchronously focuses the inline title one or more times during its init sequence. The plugin uses an apply → verify → retry loop (inspired by [obsidian-last-position](https://github.com/Saktawdi/obsidian-last-position)) that watches for focus being stolen back to the title and reapplies the target position until the init window closes.

Title modes use `setEphemeralState({ rename: ... })` and DOM manipulation on the `.inline-title` contenteditable. Body/end modes use the stable `Editor.setCursor()` API.

## Development

```bash
git clone https://github.com/112345brian/cursor-control
cd cursor-control
npm install
npm run dev    # watch mode — outputs to dist/build/
npm run build  # production build
npm test       # vitest unit tests
```

Copy `dist/build/` into your vault's `.obsidian/plugins/cursor-control/` directory and reload Obsidian to test.

## License

GPL-3.0 © [Brian Powers](https://github.com/112345brian)
