import {
	App,
	Editor,
	FuzzySuggestModal,
	MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TFolder,
	parseYaml,
	stringifyYaml,
} from "obsidian";

// ---------------------------------------------------------------------------
// Types & defaults
// ---------------------------------------------------------------------------

type MergeStrategy = "last-wins" | "first-wins" | "append";

interface ModularTemplatesSettings {
	templatesFolder: string;
	mergeStrategy: MergeStrategy;
}

const DEFAULT_SETTINGS: ModularTemplatesSettings = {
	templatesFolder: "Templates",
	mergeStrategy: "last-wins",
};

// ---------------------------------------------------------------------------
// Helpers – frontmatter parsing
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

function splitFrontmatterAndBody(content: string): {
	frontmatter: Record<string, unknown>;
	body: string;
} {
	const match = content.match(FRONTMATTER_RE);
	if (!match) {
		return { frontmatter: {}, body: content.trim() };
	}
	let fm: Record<string, unknown> = {};
	try {
		fm = (parseYaml(match[1]) as Record<string, unknown>) ?? {};
	} catch {
		fm = {};
	}
	const body = content.slice(match[0].length).trim();
	return { frontmatter: fm, body };
}

// ---------------------------------------------------------------------------
// Helpers – merging
// ---------------------------------------------------------------------------

/** Deduplicated array concat preserving order. */
function concatDedup(a: unknown[], b: unknown[]): unknown[] {
	const set = new Set(a.map(String));
	const result = [...a];
	for (const item of b) {
		if (!set.has(String(item))) {
			set.add(String(item));
			result.push(item);
		}
	}
	return result;
}

/**
 * Merge two frontmatter objects according to the chosen strategy.
 * – Arrays are always concatenated & deduplicated.
 * – `includes` key is stripped from the output.
 */
function mergeFrontmatter(
	base: Record<string, unknown>,
	overlay: Record<string, unknown>,
	strategy: MergeStrategy
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...base };

	for (const key of Object.keys(overlay)) {
		if (key === "includes") continue;

		const bVal = base[key];
		const oVal = overlay[key];

		if (Array.isArray(bVal) && Array.isArray(oVal)) {
			merged[key] = concatDedup(bVal, oVal);
		} else if (bVal !== undefined && oVal !== undefined) {
			switch (strategy) {
				case "first-wins":
					// base wins – keep existing
					break;
				case "append":
					merged[key] =
						typeof bVal === "string" && typeof oVal === "string"
							? `${bVal}\n${oVal}`
							: oVal;
					break;
				case "last-wins":
				default:
					merged[key] = oVal;
					break;
			}
		} else {
			// new key – always add
			merged[key] = oVal;
		}
	}

	// Remove includes from base too
	delete merged["includes"];
	return merged;
}

/** Split body by headings, returning an array of { heading, text } sections. */
interface Section {
	heading: string; // empty string for pre-heading content
	text: string;
}

const HEADING_RE = /^(#{1,6}\s+.*)$/m;

function splitSections(body: string): Section[] {
	const lines = body.split("\n");
	const sections: Section[] = [];
	let currentHeading = "";
	let currentLines: string[] = [];

	for (const line of lines) {
		if (HEADING_RE.test(line)) {
			if (currentLines.length > 0 || currentHeading) {
				sections.push({
					heading: currentHeading,
					text: currentLines.join("\n").trim(),
				});
			}
			currentHeading = line.trim();
			currentLines = [];
		} else {
			currentLines.push(line);
		}
	}
	// last section
	if (currentLines.length > 0 || currentHeading) {
		sections.push({
			heading: currentHeading,
			text: currentLines.join("\n").trim(),
		});
	}
	return sections;
}

function mergeBodies(base: string, overlay: string): string {
	const baseSections = splitSections(base);
	const overlaySections = splitSections(overlay);
	const existingHeadings = new Set(baseSections.map((s) => s.heading));

	for (const sec of overlaySections) {
		if (!existingHeadings.has(sec.heading)) {
			baseSections.push(sec);
			existingHeadings.add(sec.heading);
		}
	}

	return baseSections
		.map((s) => {
			if (s.heading && s.text) return `${s.heading}\n\n${s.text}`;
			if (s.heading) return s.heading;
			return s.text;
		})
		.join("\n\n");
}

// ---------------------------------------------------------------------------
// Template resolver
// ---------------------------------------------------------------------------

async function resolveTemplate(
	app: App,
	templatePath: string,
	templatesFolder: string,
	strategy: MergeStrategy,
	visited: Set<string>
): Promise<{ frontmatter: Record<string, unknown>; body: string }> {
	if (visited.has(templatePath)) {
		new Notice(`Cycle detected: ${templatePath}`);
		return { frontmatter: {}, body: "" };
	}
	visited.add(templatePath);

	const file = app.vault.getAbstractFileByPath(templatePath);
	if (!(file instanceof TFile)) {
		new Notice(`Template not found: ${templatePath}`);
		return { frontmatter: {}, body: "" };
	}

	const raw = await app.vault.cachedRead(file);
	const { frontmatter, body } = splitFrontmatterAndBody(raw);

	// Resolve includes
	const includes: string[] = Array.isArray(frontmatter["includes"])
		? (frontmatter["includes"] as string[])
		: [];

	let mergedFm: Record<string, unknown> = {};
	let mergedBody = "";

	for (const inc of includes) {
		const incPath = `${templatesFolder}/${inc}.md`;
		const parent = await resolveTemplate(
			app,
			incPath,
			templatesFolder,
			strategy,
			visited
		);
		mergedFm = mergeFrontmatter(mergedFm, parent.frontmatter, strategy);
		mergedBody = mergedBody ? mergeBodies(mergedBody, parent.body) : parent.body;
	}

	// Overlay current template on top of resolved parents
	mergedFm = mergeFrontmatter(mergedFm, frontmatter, strategy);
	mergedBody = mergedBody ? mergeBodies(mergedBody, body) : body;

	return { frontmatter: mergedFm, body: mergedBody };
}

function buildOutput(
	frontmatter: Record<string, unknown>,
	body: string
): string {
	const hasFm = Object.keys(frontmatter).length > 0;
	const fmStr = hasFm ? `---\n${stringifyYaml(frontmatter).trim()}\n---` : "";
	if (fmStr && body) return `${fmStr}\n\n${body}`;
	if (fmStr) return fmStr;
	return body;
}

// ---------------------------------------------------------------------------
// Fuzzy modal
// ---------------------------------------------------------------------------

class TemplateSuggestModal extends FuzzySuggestModal<TFile> {
	private templates: TFile[];
	private onChoose: (file: TFile) => void;

	constructor(app: App, templates: TFile[], onChoose: (file: TFile) => void) {
		super(app);
		this.templates = templates;
		this.onChoose = onChoose;
	}

	getItems(): TFile[] {
		return this.templates;
	}

	getItemText(item: TFile): string {
		return item.basename;
	}

	onChooseItem(item: TFile): void {
		this.onChoose(item);
	}
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default class ModularTemplatesPlugin extends Plugin {
	settings: ModularTemplatesSettings = DEFAULT_SETTINGS;

	async onload() {
		await this.loadSettings();

		// Command: Insert modular template at cursor
		this.addCommand({
			id: "insert-modular-template",
			name: "Insert modular template",
			editorCallback: (editor: Editor) => {
				const templates = this.getTemplateFiles();
				if (templates.length === 0) {
					new Notice("No templates found in " + this.settings.templatesFolder);
					return;
				}
				new TemplateSuggestModal(this.app, templates, async (file) => {
					const { frontmatter, body } = await resolveTemplate(
						this.app,
						file.path,
						this.settings.templatesFolder,
						this.settings.mergeStrategy,
						new Set<string>()
					);
					const output = buildOutput(frontmatter, body);
					editor.replaceSelection(output);
				}).open();
			},
		});

		// Command: Create note from modular template
		this.addCommand({
			id: "create-note-from-modular-template",
			name: "Create note from modular template",
			callback: () => {
				const templates = this.getTemplateFiles();
				if (templates.length === 0) {
					new Notice("No templates found in " + this.settings.templatesFolder);
					return;
				}
				new TemplateSuggestModal(this.app, templates, async (file) => {
					const { frontmatter, body } = await resolveTemplate(
						this.app,
						file.path,
						this.settings.templatesFolder,
						this.settings.mergeStrategy,
						new Set<string>()
					);
					const output = buildOutput(frontmatter, body);
					const newName = `Untitled - ${file.basename}`;
					let newPath = `${newName}.md`;
					let counter = 1;
					while (this.app.vault.getAbstractFileByPath(newPath)) {
						newPath = `${newName} ${counter}.md`;
						counter++;
					}
					const newFile = await this.app.vault.create(newPath, output);
					await this.app.workspace.getLeaf(true).openFile(newFile);
				}).open();
			},
		});

		this.addSettingTab(new ModularTemplatesSettingTab(this.app, this));
	}

	/** Return all markdown files inside the configured templates folder. */
	getTemplateFiles(): TFile[] {
		const folder = this.app.vault.getAbstractFileByPath(
			this.settings.templatesFolder
		);
		if (!(folder instanceof TFolder)) return [];

		const files: TFile[] = [];
		const recurse = (f: TFolder) => {
			for (const child of f.children) {
				if (child instanceof TFile && child.extension === "md") {
					files.push(child);
				} else if (child instanceof TFolder) {
					recurse(child);
				}
			}
		};
		recurse(folder);
		return files;
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

class ModularTemplatesSettingTab extends PluginSettingTab {
	plugin: ModularTemplatesPlugin;

	constructor(app: App, plugin: ModularTemplatesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Templates folder")
			.setDesc("Vault-relative path to the folder containing your templates.")
			.addText((text) =>
				text
					.setPlaceholder("Templates")
					.setValue(this.plugin.settings.templatesFolder)
					.onChange(async (value) => {
						this.plugin.settings.templatesFolder = value.trim() || "Templates";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Merge strategy")
			.setDesc(
				"How conflicting frontmatter keys are resolved when merging parent templates."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("last-wins", "Last wins (child overrides parent)")
					.addOption("first-wins", "First wins (parent preserved)")
					.addOption("append", "Append (string values concatenated)")
					.setValue(this.plugin.settings.mergeStrategy)
					.onChange(async (value) => {
						this.plugin.settings.mergeStrategy = value as MergeStrategy;
						await this.plugin.saveSettings();
					})
			);
	}
}
