# Modular Templates

An Obsidian plugin for composable, modular templates with frontmatter-based includes, recursive merging, and cycle detection.

## Features

- **Frontmatter `includes`** – Declare parent templates with `includes: [base, book]` in your template's frontmatter.
- **Recursive resolution** – Includes chains are resolved recursively; cycles are detected and reported.
- **Smart merging** – Frontmatter is merged (new props added, existing preserved, arrays concatenated & deduplicated). Body sections are merged by heading.
- **Merge strategies** – Choose between `last-wins`, `first-wins`, or `append`.
- **Insert at cursor** – Use the *Insert modular template* command to pick a template and insert merged content at the cursor.
- **Create note from template** – Use *Create note from modular template* to create a brand-new note with merged template content.

## Settings

| Setting | Default | Description |
|---|---|---|
| Templates folder | `Templates` | Vault-relative path to the folder containing your templates |
| Merge strategy | `last-wins` | How conflicting frontmatter keys are resolved: `last-wins`, `first-wins`, or `append` |

## Usage

1. Create a `Templates` folder (or configure a different path in settings).
2. Add markdown templates with optional `includes` in frontmatter:

```yaml
---
includes: [base]
tags: [book, reading]
type: book-note
---

## Summary

## Key Takeaways
```

3. Use the command palette: **Insert modular template** or **Create note from modular template**.

## Installation

### From Community Plugins

1. Open **Settings → Community Plugins → Browse**
2. Search for "Modular Templates"
3. Click **Install**, then **Enable**

### Manual Installation

1. Copy `main.js`, `manifest.json`, and `styles.css` into your vault's `.obsidian/plugins/obsidian-modular-templates/` directory.
2. Enable the plugin in Obsidian's Community Plugins settings.

## Author

Cody Bontecou

## License

MIT
