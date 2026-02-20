# Modular Templates

An Obsidian plugin for composable, modular templates with inheritance. Define atomic template fragments and compose them into larger templates via `includes`. Avoids redundancy — define information once, reuse everywhere.

## Features

- **Frontmatter `includes`** — Declare parent templates: `includes: [base, book]`. Supports both YAML list syntaxes, comma-separated strings, and `[[wikilink]]` notation.
- **Recursive resolution** — Include chains resolve recursively. Diamond dependencies are cached. Cycles are detected and reported.
- **Smart frontmatter merging** — Uses Obsidian's `processFrontMatter` API to preserve property types (dates, links, lists, etc.). Arrays are concatenated & deduplicated. Scalars follow the merge strategy.
- **Template variables** — `{{date}}`, `{{time}}`, `{{title}}` are resolved, plus custom formats: `{{date:YYYY/MM/DD}}`, `{{time:HH:mm:ss}}`. Inherits date/time format from core Templates on first run.
- **Section-aware body merging** — Body content is merged by heading. Duplicate sections are handled per merge strategy. New sections are appended.
- **Multi-template insertion** — Select and merge multiple templates in one operation.
- **Mobile & desktop** — Works on both platforms (`isDesktopOnly: false`).

## Commands

| Command | What it does |
|---|---|
| **Insert modular template** | Pick one template → merges frontmatter into note properties + inserts body at cursor. Behaves like core Templates but with recursive include resolution. |
| **Merge modular template into note** | Pick one template → merges frontmatter AND body sections (heading-aware dedup). Safe to run multiple times. |
| **Insert multiple modular templates** | Multi-select with checkboxes → resolves each, merges all together, then applies (section-aware). |
| **Create note from modular template** | Pick one template → creates a brand-new note with fully resolved content. |

## Settings

| Setting | Default | Description |
|---|---|---|
| Templates folder | `Templates` | Vault-relative path. Inherited from core Templates on first run. |
| Merge strategy | `last-wins` | `last-wins` (child overrides parent), `first-wins` (parent preserved), or `append` (strings concatenated, sections combined). |
| Date format | `YYYY-MM-DD` | Moment.js format for `{{date}}`. Inherited from core Templates on first run. |
| Time format | `HH:mm` | Moment.js format for `{{time}}`. Inherited from core Templates on first run. |

## Usage

### 1. Create atomic template fragments

```markdown
<!-- Templates/base.md -->
---
created: "{{date}}"
tags:
  - note
---
```

```markdown
<!-- Templates/author.md -->
---
author: ""
---

## Author
```

```markdown
<!-- Templates/summary.md -->
---
---

## Summary
```

### 2. Compose them into larger templates

```markdown
<!-- Templates/book.md -->
---
includes:
  - base
  - author
  - summary
tags:
  - book
  - reading
type: book-note
---

## Key Takeaways

## Quotes
```

### 3. Use in your notes

Run **Insert modular template** → pick "book" → the plugin resolves the full chain and applies:

- `created`, `author`, `type` properties are merged into your note's frontmatter
- `tags` from both `base` and `book` are combined: `[note, book, reading]`
- Body sections `## Author`, `## Summary`, `## Key Takeaways`, `## Quotes` are all added

### Include syntax

All of these work:

```yaml
# YAML list
includes:
  - base
  - book

# Inline array
includes: [base, book]

# Single template
includes: base

# Comma-separated string
includes: base, book

# With wikilinks
includes: ["[[base]]", "[[book]]"]

# The key "include" (singular) also works
include: [base, book]
```

### Diamond dependencies

If template A includes B and C, and both B and C include D, template D's content is included once (cached). No duplication, no errors.

### Merge strategies explained

Given templates `base` (parent) and `book` (child) both defining `status`:

| Strategy | Result |
|---|---|
| **last-wins** | `book.status` wins (child overrides parent) |
| **first-wins** | `base.status` wins (parent preserved) |
| **append** | Strings: `base.status + "\n" + book.status`. Sections: content combined under same heading. |

For **arrays** (like `tags`), values are always concatenated and deduplicated regardless of strategy.

## How it differs from core Templates

| Feature | Core Templates | Modular Templates |
|---|---|---|
| Insert a template | ✅ | ✅ (with recursive resolution) |
| `{{date}}` / `{{time}}` / `{{title}}` | ✅ | ✅ (inherits format from core) |
| `includes` / inheritance | ❌ | ✅ Recursive with cycle detection |
| Insert multiple templates at once | ❌ | ✅ Multi-select command |
| Section-aware body merge | ❌ (append only) | ✅ Headings are deduplicated |
| Merge into existing note safely | ❌ | ✅ "Merge" command |
| Frontmatter property types | ✅ | ✅ (uses `processFrontMatter` API) |

## Installation

### BRAT

1. Install the [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat)
2. Add this repository: `CodyBontecou/obsidian-modular-templates`
3. Enable the plugin

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/CodyBontecou/obsidian-modular-templates/releases)
2. Copy them into `.obsidian/plugins/modular-templates/` in your vault
3. Enable the plugin in **Settings → Community Plugins**

## License

MIT
