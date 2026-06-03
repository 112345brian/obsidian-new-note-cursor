# Cursor Control

An [Obsidian](https://obsidian.md) plugin that controls where the cursor lands when you create a new note.

## Per-note overrides

Add `cursor-position` to a note's frontmatter to override the global setting for that note. This is most useful in templates.

```yaml
---
cursor-position: body
---
```

Valid values: `title` · `body` · `end` · `title-highlighted`

## Settings

Open **Settings → Cursor Control** and choose one of three cursor behaviors:

| Option | Behavior |
|---|---|
| **At the title** *(default)* | Focus moves to the inline title field so you can immediately type or edit the note name |
| **Beginning of the body** | Cursor is placed after the frontmatter (skipping the blank separator line) |
| **End of the note** | Cursor is placed at the end of the last line — useful for appending to template content |
| **Title highlighted** | The title is selected end-to-end — start typing and it is instantly overwritten |

## Installation

The plugin is not yet listed in the official Community Plugins directory.

### Via BRAT (recommended for beta)

1. Install [BRAT](https://obsidian.md/plugins?id=obsidian42-brat) and enable it.
2. In BRAT settings, click **Add Beta Plugin** and enter:
   ```
   https://github.com/112345brian/cursor-control
   ```
3. Enable **Cursor Control** in **Settings → Community plugins**.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/112345brian/cursor-control/releases/latest).
2. Copy the three files into `<your vault>/.obsidian/plugins/cursor-control/`.
3. Enable **Cursor Control** in **Settings → Community plugins**.

## How it works

The plugin listens for two events:

1. `vault.on('create')` — records the path of any newly created Markdown file with a timestamp.
2. `workspace.on('file-open')` — when a file opens in the editor, checks if it was in the recently-created set (within a 5-second window). If so, it fires the configured cursor behavior and removes the entry.

This avoids polling and ensures the editor is fully ready before any cursor manipulation is attempted.

The title-focus modes use DOM manipulation on the `.inline-title` contenteditable element because the Obsidian API does not currently expose a dedicated method for accessing the title field. The body mode uses the stable `Editor.setCursor()` API.

## Development

```bash
git clone https://github.com/112345brian/cursor-control
cd cursor-control
npm install
npm run dev    # watch mode — outputs to dist/build/
npm run build  # production build
```

Copy `dist/build/` into your vault's `.obsidian/plugins/cursor-control/` directory and reload Obsidian to test.

## License

MIT © [Brian Powers](https://github.com/112345brian)
