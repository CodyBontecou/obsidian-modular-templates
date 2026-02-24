import {
	App,
	Editor,
	FuzzySuggestModal,
	MarkdownView,
	Modal,
	moment,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TFolder,
	parseYaml,
	stringifyYaml,
} from "obsidian";

/* ================================================================
   Types & Settings
   ================================================================ */

type MergeStrategy = "last-wins" | "first-wins" | "append";

interface ModularTemplatesSettings {
	templatesFolder: string;
	mergeStrategy: MergeStrategy;
	dateFormat: string;
	timeFormat: string;
	debugMode: boolean;
}

const DEFAULT_SETTINGS: ModularTemplatesSettings = {
	templatesFolder: "Templates",
	mergeStrategy: "last-wins",
	dateFormat: "YYYY-MM-DD",
	timeFormat: "HH:mm",
	debugMode: false,
};

/* ================================================================
   Utility
   ================================================================ */

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/* ================================================================
   Frontmatter / Body Parsing
   ================================================================ */

// More flexible regex: handles various line endings and optional trailing newline
const FM_RE = /^---[ \t]*[\r\n]+([\s\S]*?)[\r\n]+---[ \t]*(?:[\r\n]+|$)/;

function splitFrontmatterAndBody(content: string): {
	frontmatter: Record<string, unknown>;
	body: string;
	rawFmBlock: string;
} {
	// Normalize line endings for consistent parsing
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const m = normalized.match(FM_RE);
	if (!m) return { frontmatter: {}, body: content.trim(), rawFmBlock: "" };
	let fm: Record<string, unknown> = {};
	try {
		const parsed = parseYaml(m[1]);
		fm = (typeof parsed === "object" && parsed !== null) 
			? (parsed as Record<string, unknown>) 
			: {};
	} catch (e) {
		console.warn("Modular Templates: Failed to parse frontmatter YAML:", e);
		fm = {};
	}
	return {
		frontmatter: fm,
		body: normalized.slice(m[0].length).trim(),
		rawFmBlock: m[0],
	};
}

/* ================================================================
   Includes Parsing
   ================================================================ */

function parseIncludes(value: unknown): string[] {
	if (value === undefined || value === null) return [];
	
	if (Array.isArray(value)) {
		return value
			.map(String)
			.map(cleanInclude)
			.filter(Boolean);
	}
	
	if (typeof value === "string") {
		const t = value.trim();
		if (!t) return [];
		
		// Handle "[a, b]" stored as string by some YAML parsers
		if (t.startsWith("[") && t.endsWith("]")) {
			return t
				.slice(1, -1)
				.split(",")
				.map((s) => cleanInclude(s.trim()))
				.filter(Boolean);
		}
		// Comma-separated: "base, book"
		if (t.includes(",")) {
			return t
				.split(",")
				.map((s) => cleanInclude(s.trim()))
				.filter(Boolean);
		}
		return [cleanInclude(t)];
	}
	
	// Handle numbers or other types that got parsed oddly
	return [];
}

/** Strip wikilink brackets, quotes, and .md extension from include names. */
function cleanInclude(name: string): string {
	if (!name) return "";
	return name
		.trim()
		// Remove surrounding quotes (single or double)
		.replace(/^["']|["']$/g, "")
		// Remove wikilink brackets [[...]]
		.replace(/^\[\[/, "")
		.replace(/\]\]$/, "")
		// Remove embed syntax ![[...]]
		.replace(/^!\[\[/, "")
		// Remove .md extension
		.replace(/\.md$/i, "")
		.trim();
}

/* ================================================================
   Template Variables  {{date}}, {{time}}, {{title}}, {{date:FMT}}
   ================================================================ */

function processVars(
	text: string,
	title: string,
	dateFmt: string,
	timeFmt: string,
): string {
	if (!text) return text;
	
	try {
		const now = moment();
		return text
			.replace(
				/\{\{\s*date\s*:\s*([^}]+)\s*\}\}/gi,
				(_, f: string) => now.format(f.trim()),
			)
			.replace(
				/\{\{\s*time\s*:\s*([^}]+)\s*\}\}/gi,
				(_, f: string) => now.format(f.trim()),
			)
			.replace(/\{\{\s*date\s*\}\}/gi, now.format(dateFmt))
			.replace(/\{\{\s*time\s*\}\}/gi, now.format(timeFmt))
			.replace(/\{\{\s*title\s*\}\}/gi, title);
	} catch (e) {
		console.error("Modular Templates: Error processing template variables:", e);
		return text;
	}
}

function processVarsFm(
	fm: Record<string, unknown>,
	title: string,
	dateFmt: string,
	timeFmt: string,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(fm)) {
		if (typeof v === "string") {
			out[k] = processVars(v, title, dateFmt, timeFmt);
		} else if (Array.isArray(v)) {
			out[k] = v.map((x) =>
				typeof x === "string"
					? processVars(x, title, dateFmt, timeFmt)
					: x,
			);
		} else {
			out[k] = v;
		}
	}
	return out;
}

/* ================================================================
   Frontmatter Merging
   ================================================================ */

function concatDedup(a: unknown[], b: unknown[]): unknown[] {
	const seen = new Set(a.map(String));
	const out = [...a];
	for (const x of b) {
		if (!seen.has(String(x))) {
			seen.add(String(x));
			out.push(x);
		}
	}
	return out;
}

/**
 * Return a new merged frontmatter object. Does NOT include
 * `includes` / `include` keys in the output.
 */
function mergeFrontmatter(
	base: Record<string, unknown>,
	overlay: Record<string, unknown>,
	strategy: MergeStrategy,
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...base };
	for (const [key, oVal] of Object.entries(overlay)) {
		if (key === "includes" || key === "include") continue;
		const bVal = base[key];

		if (bVal === undefined || bVal === null) {
			merged[key] = oVal;
			continue;
		}

		// Both arrays → concat & dedup
		if (Array.isArray(bVal) && Array.isArray(oVal)) {
			merged[key] = concatDedup(bVal, oVal);
			continue;
		}
		// base array, overlay scalar → push if new
		if (Array.isArray(bVal) && !Array.isArray(oVal) && oVal !== undefined) {
			if (!bVal.map(String).includes(String(oVal))) {
				merged[key] = [...bVal, oVal];
			}
			continue;
		}
		// base scalar, overlay array → combine
		if (!Array.isArray(bVal) && Array.isArray(oVal)) {
			merged[key] = concatDedup([bVal], oVal);
			continue;
		}

		// Both scalars
		switch (strategy) {
			case "first-wins":
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
		}
	}
	delete merged["includes"];
	delete merged["include"];
	return merged;
}

/**
 * Mutate `target` in-place — used inside processFrontMatter callback
 * so Obsidian's property-type system is preserved.
 */
function applyFmMergeInPlace(
	target: Record<string, unknown>,
	source: Record<string, unknown>,
	strategy: MergeStrategy,
): void {
	for (const [key, sVal] of Object.entries(source)) {
		if (key === "includes" || key === "include") continue;
		const tVal = target[key];

		if (tVal === undefined || tVal === null) {
			target[key] = sVal;
			continue;
		}

		if (Array.isArray(tVal) && Array.isArray(sVal)) {
			const seen = new Set(tVal.map(String));
			for (const x of sVal) {
				if (!seen.has(String(x))) {
					tVal.push(x);
					seen.add(String(x));
				}
			}
			continue;
		}
		if (Array.isArray(tVal) && !Array.isArray(sVal) && sVal !== undefined) {
			if (!tVal.map(String).includes(String(sVal))) tVal.push(sVal);
			continue;
		}
		if (!Array.isArray(tVal) && Array.isArray(sVal)) {
			target[key] = concatDedup([tVal], sVal);
			continue;
		}

		switch (strategy) {
			case "first-wins":
				break;
			case "append":
				target[key] =
					typeof tVal === "string" && typeof sVal === "string"
						? `${tVal}\n${sVal}`
						: sVal;
				break;
			case "last-wins":
			default:
				target[key] = sVal;
		}
	}
}

/* ================================================================
   Body (Section-Aware) Merging
   ================================================================ */

interface Section {
	heading: string;
	text: string;
}

function splitSections(body: string): Section[] {
	if (!body.trim()) return [];
	const lines = body.split("\n");
	const secs: Section[] = [];
	let h = "";
	let buf: string[] = [];

	for (const line of lines) {
		if (/^#{1,6}\s+/.test(line)) {
			if (buf.length || h)
				secs.push({ heading: h, text: buf.join("\n").trim() });
			h = line.trim();
			buf = [];
		} else {
			buf.push(line);
		}
	}
	if (buf.length || h)
		secs.push({ heading: h, text: buf.join("\n").trim() });
	return secs;
}

function mergeBodies(
	base: string,
	overlay: string,
	strategy: MergeStrategy,
): string {
	if (!base.trim()) return overlay;
	if (!overlay.trim()) return base;

	const bSec = splitSections(base);
	const oSec = splitSections(overlay);
	const idx = new Map<string, number>();
	bSec.forEach((s, i) => idx.set(s.heading, i));

	for (const s of oSec) {
		const i = idx.get(s.heading);
		if (i !== undefined) {
			switch (strategy) {
				case "last-wins":
					bSec[i] = s;
					break;
				case "append":
					bSec[i] = {
						heading: s.heading,
						text: [bSec[i].text, s.text]
							.filter(Boolean)
							.join("\n\n"),
					};
					break;
				case "first-wins":
					break;
			}
		} else {
			bSec.push(s);
			idx.set(s.heading, bSec.length - 1);
		}
	}

	return bSec
		.map((s) =>
			s.heading && s.text
				? `${s.heading}\n\n${s.text}`
				: s.heading || s.text,
		)
		.filter(Boolean)
		.join("\n\n");
}

/* ================================================================
   Template Resolver (recursive, with cycle detection + caching)
   ================================================================ */

interface Resolved {
	frontmatter: Record<string, unknown>;
	body: string;
}

async function resolveTemplate(
	app: App,
	path: string,
	folder: string,
	strategy: MergeStrategy,
	ancestors: Set<string>,
	cache: Map<string, Resolved>,
	debug = false,
): Promise<Resolved> {
	if (debug) console.log(`Modular Templates: Resolving ${path}`);
	
	// True cycle detection: only ancestors on the current stack
	if (ancestors.has(path)) {
		new Notice(`⚠️ Cycle detected: ${path}`);
		console.warn(`Modular Templates: Cycle detected at ${path}`);
		return { frontmatter: {}, body: "" };
	}
	// Diamond-dependency caching
	if (cache.has(path)) {
		if (debug) console.log(`Modular Templates: Using cached result for ${path}`);
		return cache.get(path)!;
	}

	ancestors.add(path);

	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) {
		// Try alternative path constructions
		const altPaths = [
			path,
			`${folder}/${path}`,
			path.replace(/\.md$/, "") + ".md",
			`${folder}/${path.replace(/\.md$/, "")}.md`,
		];
		
		let foundFile: TFile | null = null;
		for (const altPath of altPaths) {
			const f = app.vault.getAbstractFileByPath(altPath);
			if (f instanceof TFile) {
				foundFile = f;
				if (debug) console.log(`Modular Templates: Found at alternative path ${altPath}`);
				break;
			}
		}
		
		if (!foundFile) {
			new Notice(`Template not found: ${path}`);
			console.warn(`Modular Templates: Template not found: ${path}. Tried: ${altPaths.join(", ")}`);
			ancestors.delete(path);
			return { frontmatter: {}, body: "" };
		}
	}

	const actualFile = (file instanceof TFile) 
		? file 
		: app.vault.getAbstractFileByPath(path) as TFile;
	
	if (!(actualFile instanceof TFile)) {
		ancestors.delete(path);
		return { frontmatter: {}, body: "" };
	}

	const raw = await app.vault.cachedRead(actualFile);
	if (debug) console.log(`Modular Templates: Raw content length: ${raw.length}`);
	
	const { frontmatter, body } = splitFrontmatterAndBody(raw);
	if (debug) {
		console.log(`Modular Templates: Parsed frontmatter keys: ${Object.keys(frontmatter).join(", ")}`);
		console.log(`Modular Templates: Body length: ${body.length}`);
	}

	// Resolve includes (support both "includes" and "include")
	const rawIncludes = frontmatter["includes"] ?? frontmatter["include"];
	const includes = parseIncludes(rawIncludes);
	
	if (debug && includes.length > 0) {
		console.log(`Modular Templates: Includes to resolve: ${includes.join(", ")}`);
	}

	let mFm: Record<string, unknown> = {};
	let mBody = "";

	for (const inc of includes) {
		let p = inc;
		if (!p.endsWith(".md")) p += ".md";
		if (!p.includes("/")) p = `${folder}/${p}`;

		if (debug) console.log(`Modular Templates: Resolving include: ${p}`);
		
		const parent = await resolveTemplate(
			app,
			p,
			folder,
			strategy,
			ancestors,
			cache,
			debug,
		);
		mFm = mergeFrontmatter(mFm, parent.frontmatter, strategy);
		mBody = mergeBodies(mBody, parent.body, strategy);
	}

	// Overlay current template on top of resolved parents
	mFm = mergeFrontmatter(mFm, frontmatter, strategy);
	mBody = mergeBodies(mBody, body, strategy);

	ancestors.delete(path);
	const result: Resolved = { frontmatter: mFm, body: mBody };
	cache.set(path, result);
	
	if (debug) {
		console.log(`Modular Templates: Final resolved frontmatter keys: ${Object.keys(mFm).join(", ")}`);
	}
	
	return result;
}

function buildOutput(fm: Record<string, unknown>, body: string): string {
	const hasFm = Object.keys(fm).length > 0;
	const fmStr = hasFm
		? `---\n${stringifyYaml(fm).trim()}\n---`
		: "";
	if (fmStr && body) return `${fmStr}\n\n${body}\n`;
	if (fmStr) return fmStr + "\n";
	return body ? body + "\n" : "";
}

/* ================================================================
   Apply Resolved Template to the Active Note
   ================================================================ */

async function applyToNote(
	plugin: ModularTemplatesPlugin,
	rawFm: Record<string, unknown>,
	rawBody: string,
	mode: "insert" | "merge",
): Promise<void> {
	const { app, settings } = plugin;
	const strategy = settings.mergeStrategy;
	const debug = settings.debugMode;
	const view = app.workspace.getActiveViewOfType(MarkdownView);
	
	if (!view?.file) {
		new Notice("No active markdown note");
		return;
	}
	const file = view.file;
	const editor = view.editor;
	const title = file.basename;

	if (debug) {
		console.log(`Modular Templates: Applying to note "${title}" in ${mode} mode`);
		console.log(`Modular Templates: Raw frontmatter keys: ${Object.keys(rawFm).join(", ")}`);
		console.log(`Modular Templates: Raw body length: ${rawBody.length}`);
	}

	// Process template variables
	const fm = processVarsFm(
		rawFm,
		title,
		settings.dateFormat,
		settings.timeFormat,
	);
	const body = processVars(
		rawBody,
		title,
		settings.dateFormat,
		settings.timeFormat,
	);

	if (debug) {
		console.log(`Modular Templates: Processed frontmatter:`, fm);
		console.log(`Modular Templates: Processed body preview: ${body.slice(0, 100)}...`);
	}

	if (mode === "insert") {
		/*  INSERT mode  –  like core Templates:
		 *  • frontmatter → merged into note properties via processFrontMatter
		 *  • body        → inserted at cursor via replaceSelection
		 */

		// 1) Insert body at cursor FIRST (before frontmatter changes shift lines)
		if (body.trim()) {
			editor.replaceSelection(body + "\n");
			if (debug) console.log("Modular Templates: Body inserted at cursor");
		}

		// 2) Merge frontmatter via Obsidian's processFrontMatter
		//    (preserves property types: dates, links, lists, etc.)
		if (Object.keys(fm).length > 0) {
			try {
				await app.fileManager.processFrontMatter(
					file,
					(existing: Record<string, unknown>) => {
						if (debug) {
							console.log("Modular Templates: Existing frontmatter:", existing);
						}
						applyFmMergeInPlace(existing, fm, strategy);
						if (debug) {
							console.log("Modular Templates: Merged frontmatter:", existing);
						}
					},
				);
				if (debug) console.log("Modular Templates: Frontmatter processed successfully");
			} catch (e) {
				console.error("Modular Templates: Error processing frontmatter:", e);
				new Notice("⚠️ Error merging frontmatter - see console for details");
			}
		}
	} else {
		/*  MERGE mode  –  section-aware:
		 *  • frontmatter → merged
		 *  • body        → sections merged by heading (dedup)
		 */
		const content = await app.vault.read(file);
		const existing = splitFrontmatterAndBody(content);
		const mergedFm = mergeFrontmatter(
			existing.frontmatter,
			fm,
			strategy,
		);
		const mergedBody = mergeBodies(existing.body, body, strategy);
		
		if (debug) {
			console.log("Modular Templates: Merged frontmatter:", mergedFm);
			console.log("Modular Templates: Merged body length:", mergedBody.length);
		}
		
		await app.vault.modify(file, buildOutput(mergedFm, mergedBody));
	}

	new Notice("✅ Template applied");
}

/* ================================================================
   Modals
   ================================================================ */

/** Single-select fuzzy picker. */
class TemplateSuggestModal extends FuzzySuggestModal<TFile> {
	private templates: TFile[];
	private onChoose: (file: TFile) => void;

	constructor(
		app: App,
		templates: TFile[],
		onChoose: (file: TFile) => void,
	) {
		super(app);
		this.templates = templates;
		this.onChoose = onChoose;
		this.setPlaceholder("Choose a template…");
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

/** Preview modal to show resolved template content. */
class PreviewModal extends Modal {
	private templateName: string;
	private content: string;

	constructor(app: App, templateName: string, content: string) {
		super(app);
		this.templateName = templateName;
		this.content = content;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("mt-preview");

		contentEl.createEl("h3", { 
			text: `Preview: ${this.templateName}` 
		});
		
		contentEl.createEl("p", {
			text: "This is what the template resolves to (before variable substitution):",
			cls: "mt-preview-hint",
		});

		const pre = contentEl.createEl("pre", { cls: "mt-preview-content" });
		pre.createEl("code", { text: this.content });

		const footer = contentEl.createDiv({ cls: "mt-footer" });
		const copyBtn = footer.createEl("button", { 
			text: "Copy to clipboard",
			cls: "mod-cta",
		});
		copyBtn.addEventListener("click", () => {
			navigator.clipboard.writeText(this.content);
			new Notice("Copied to clipboard");
		});
		
		const closeBtn = footer.createEl("button", { text: "Close" });
		closeBtn.addEventListener("click", () => this.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** Multi-select modal with checkboxes and search. */
class MultiTemplateSuggestModal extends Modal {
	private plugin: ModularTemplatesPlugin;
	private templates: TFile[];
	private selected: Set<string> = new Set();
	private onSubmit: (files: TFile[]) => void;
	private searchEl!: HTMLInputElement;
	private listEl!: HTMLElement;
	private countEl!: HTMLElement;

	constructor(
		plugin: ModularTemplatesPlugin,
		templates: TFile[],
		onSubmit: (files: TFile[]) => void,
	) {
		super(plugin.app);
		this.plugin = plugin;
		this.templates = templates;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("mt-multi-select");

		contentEl.createEl("h3", { text: "Select templates to merge" });

		this.searchEl = contentEl.createEl("input", {
			type: "text",
			placeholder: "Search templates…",
			cls: "mt-search",
		});
		this.searchEl.addEventListener("input", () => this.renderList());

		this.listEl = contentEl.createDiv({ cls: "mt-list" });
		this.renderList();

		const footer = contentEl.createDiv({ cls: "mt-footer" });
		this.countEl = footer.createSpan({
			cls: "mt-count",
			text: "0 selected",
		});
		const btn = footer.createEl("button", {
			text: "Insert selected",
			cls: "mod-cta",
		});
		btn.addEventListener("click", () => this.submit());

		this.searchEl.focus();
	}

	renderList() {
		const q = this.searchEl.value.toLowerCase();
		this.listEl.empty();
		const filtered = this.templates.filter((f) =>
			f.basename.toLowerCase().includes(q),
		);

		for (const file of filtered) {
			const row = this.listEl.createDiv({ cls: "mt-item" });
			const cb = row.createEl("input", { type: "checkbox" });
			cb.checked = this.selected.has(file.path);
			cb.addEventListener("change", () => {
				if (cb.checked) this.selected.add(file.path);
				else this.selected.delete(file.path);
				this.countEl.setText(`${this.selected.size} selected`);
			});
			row.createSpan({ text: file.basename });
			row.addEventListener("click", (e) => {
				if ((e.target as HTMLElement).tagName !== "INPUT") {
					cb.checked = !cb.checked;
					cb.dispatchEvent(new Event("change"));
				}
			});
		}
	}

	submit() {
		const files = this.templates.filter((f) =>
			this.selected.has(f.path),
		);
		if (!files.length) {
			new Notice("No templates selected");
			return;
		}
		this.close();
		this.onSubmit(files);
	}

	onClose() {
		this.contentEl.empty();
	}
}

/* ================================================================
   Plugin
   ================================================================ */

export default class ModularTemplatesPlugin extends Plugin {
	settings: ModularTemplatesSettings = DEFAULT_SETTINGS;

	async onload() {
		await this.loadSettings();

		// Pick up core Templates settings as defaults on first run
		this.app.workspace.onLayoutReady(() =>
			this.syncCoreTemplateDefaults(),
		);

		// ── Command 1: Insert modular template ──────────────────────
		// Merges frontmatter into note properties, inserts body at cursor.
		// Behaves like core Templates but with recursive include resolution.
		this.addCommand({
			id: "insert-modular-template",
			name: "Insert modular template",
			editorCallback: (_editor: Editor) => {
				const templates = this.getTemplateFiles();
				if (!templates.length) {
					new Notice(
						"No templates in " + this.settings.templatesFolder,
					);
					return;
				}
				new TemplateSuggestModal(
					this.app,
					templates,
					async (file) => {
						if (this.settings.debugMode) {
							console.log(`Modular Templates: Selected template: ${file.path}`);
						}
						const res = await resolveTemplate(
							this.app,
							file.path,
							this.settings.templatesFolder,
							this.settings.mergeStrategy,
							new Set(),
							new Map(),
							this.settings.debugMode,
						);
						await applyToNote(
							this,
							res.frontmatter,
							res.body,
							"insert",
						);
					},
				).open();
			},
		});

		// ── Command 2: Merge modular template into note ─────────────
		// Merges frontmatter AND body sections (heading-aware dedup).
		this.addCommand({
			id: "merge-modular-template",
			name: "Merge modular template into note",
			editorCallback: (_editor: Editor) => {
				const templates = this.getTemplateFiles();
				if (!templates.length) {
					new Notice(
						"No templates in " + this.settings.templatesFolder,
					);
					return;
				}
				new TemplateSuggestModal(
					this.app,
					templates,
					async (file) => {
						if (this.settings.debugMode) {
							console.log(`Modular Templates: Selected template: ${file.path}`);
						}
						const res = await resolveTemplate(
							this.app,
							file.path,
							this.settings.templatesFolder,
							this.settings.mergeStrategy,
							new Set(),
							new Map(),
							this.settings.debugMode,
						);
						await applyToNote(
							this,
							res.frontmatter,
							res.body,
							"merge",
						);
					},
				).open();
			},
		});

		// ── Command 3: Insert multiple modular templates ────────────
		// Multi-select, resolves each, merges all together, then applies.
		this.addCommand({
			id: "insert-multiple-modular-templates",
			name: "Insert multiple modular templates",
			editorCallback: (_editor: Editor) => {
				const templates = this.getTemplateFiles();
				if (!templates.length) {
					new Notice(
						"No templates in " + this.settings.templatesFolder,
					);
					return;
				}
				new MultiTemplateSuggestModal(
					this,
					templates,
					async (files) => {
						if (this.settings.debugMode) {
							console.log(`Modular Templates: Selected ${files.length} templates`);
						}
						const cache = new Map<string, Resolved>();
						let combinedFm: Record<string, unknown> = {};
						let combinedBody = "";
						const strategy = this.settings.mergeStrategy;

						for (const f of files) {
							const res = await resolveTemplate(
								this.app,
								f.path,
								this.settings.templatesFolder,
								strategy,
								new Set(),
								cache,
								this.settings.debugMode,
							);
							combinedFm = mergeFrontmatter(
								combinedFm,
								res.frontmatter,
								strategy,
							);
							combinedBody = mergeBodies(
								combinedBody,
								res.body,
								strategy,
							);
						}

						await applyToNote(
							this,
							combinedFm,
							combinedBody,
							"merge",
						);
					},
				).open();
			},
		});

		// ── Command 4: Create note from modular template ────────────
		this.addCommand({
			id: "create-note-from-modular-template",
			name: "Create note from modular template",
			callback: () => {
				const templates = this.getTemplateFiles();
				if (!templates.length) {
					new Notice(
						"No templates in " + this.settings.templatesFolder,
					);
					return;
				}
				new TemplateSuggestModal(
					this.app,
					templates,
					async (file) => {
						if (this.settings.debugMode) {
							console.log(`Modular Templates: Creating note from template: ${file.path}`);
						}
						const res = await resolveTemplate(
							this.app,
							file.path,
							this.settings.templatesFolder,
							this.settings.mergeStrategy,
							new Set(),
							new Map(),
							this.settings.debugMode,
						);
						const baseName = `Untitled - ${file.basename}`;
						let path = `${baseName}.md`;
						let n = 1;
						while (
							this.app.vault.getAbstractFileByPath(path)
						) {
							path = `${baseName} ${n++}.md`;
						}
						const title = path.replace(/\.md$/, "");
						const fm = processVarsFm(
							res.frontmatter,
							title,
							this.settings.dateFormat,
							this.settings.timeFormat,
						);
						const body = processVars(
							res.body,
							title,
							this.settings.dateFormat,
							this.settings.timeFormat,
						);
						const content = buildOutput(fm, body);
						
						if (this.settings.debugMode) {
							console.log(`Modular Templates: Creating note at ${path}`);
							console.log(`Modular Templates: Content preview: ${content.slice(0, 200)}...`);
						}
						
						const newFile =
							await this.app.vault.create(path, content);
						await this.app.workspace
							.getLeaf(true)
							.openFile(newFile);
						new Notice("✅ Note created from template");
					},
				).open();
			},
		});

		// ── Command 5: Preview resolved template ──────────────────────
		// Shows what a template will resolve to without applying it.
		this.addCommand({
			id: "preview-modular-template",
			name: "Preview resolved template",
			callback: () => {
				const templates = this.getTemplateFiles();
				if (!templates.length) {
					new Notice(
						"No templates in " + this.settings.templatesFolder,
					);
					return;
				}
				new TemplateSuggestModal(
					this.app,
					templates,
					async (file) => {
						const res = await resolveTemplate(
							this.app,
							file.path,
							this.settings.templatesFolder,
							this.settings.mergeStrategy,
							new Set(),
							new Map(),
							true, // Always debug for preview
						);
						const title = "{{title}}"; // Keep as placeholder for preview
						const fm = res.frontmatter;
						const body = res.body;
						const content = buildOutput(fm, body);
						
						new PreviewModal(this.app, file.basename, content).open();
					},
				).open();
			},
		});

		this.addSettingTab(
			new ModularTemplatesSettingTab(this.app, this),
		);
	}

	/** Return all markdown files inside the configured templates folder. */
	getTemplateFiles(): TFile[] {
		const folder = this.app.vault.getAbstractFileByPath(
			this.settings.templatesFolder,
		);
		if (!(folder instanceof TFolder)) return [];

		const files: TFile[] = [];
		const walk = (f: TFolder) => {
			for (const child of f.children) {
				if (child instanceof TFile && child.extension === "md")
					files.push(child);
				else if (child instanceof TFolder) walk(child);
			}
		};
		walk(folder);
		return files.sort((a, b) =>
			a.basename.localeCompare(b.basename),
		);
	}

	/**
	 * On first run, try to inherit date/time format and folder from
	 * the core Templates plugin so users don't have to configure twice.
	 */
	syncCoreTemplateDefaults() {
		try {
			const tp = (this.app as any).internalPlugins?.getPluginById?.(
				"templates",
			);
			if (tp?.instance?.options) {
				const opts = tp.instance.options;
				if (
					opts.dateFormat &&
					this.settings.dateFormat ===
						DEFAULT_SETTINGS.dateFormat
				) {
					this.settings.dateFormat = opts.dateFormat;
				}
				if (
					opts.timeFormat &&
					this.settings.timeFormat ===
						DEFAULT_SETTINGS.timeFormat
				) {
					this.settings.timeFormat = opts.timeFormat;
				}
				if (
					opts.folder &&
					this.settings.templatesFolder ===
						DEFAULT_SETTINGS.templatesFolder
				) {
					this.settings.templatesFolder = opts.folder;
				}
			}
		} catch {
			/* core Templates not available – use our defaults */
		}
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

/* ================================================================
   Settings Tab
   ================================================================ */

class ModularTemplatesSettingTab extends PluginSettingTab {
	plugin: ModularTemplatesPlugin;

	constructor(app: App, plugin: ModularTemplatesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Modular Templates" });

		new Setting(containerEl)
			.setName("Templates folder")
			.setDesc(
				"Vault-relative path to the folder containing your templates. " +
					"On first run this inherits from core Templates if available.",
			)
			.addText((t) =>
				t
					.setPlaceholder("Templates")
					.setValue(this.plugin.settings.templatesFolder)
					.onChange(async (v) => {
						this.plugin.settings.templatesFolder =
							v.trim() || "Templates";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Merge strategy")
			.setDesc(
				"How conflicting frontmatter keys and duplicate body sections are resolved.",
			)
			.addDropdown((d) =>
				d
					.addOption(
						"last-wins",
						"Last wins (child overrides parent)",
					)
					.addOption(
						"first-wins",
						"First wins (parent preserved)",
					)
					.addOption(
						"append",
						"Append (strings concatenated, sections combined)",
					)
					.setValue(this.plugin.settings.mergeStrategy)
					.onChange(async (v) => {
						this.plugin.settings.mergeStrategy =
							v as MergeStrategy;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Date format")
			.setDesc(
				"Moment.js format for {{date}}. Inherited from core Templates on first run.",
			)
			.addText((t) =>
				t
					.setPlaceholder("YYYY-MM-DD")
					.setValue(this.plugin.settings.dateFormat)
					.onChange(async (v) => {
						this.plugin.settings.dateFormat =
							v.trim() || "YYYY-MM-DD";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Time format")
			.setDesc("Moment.js format for {{time}}.")
			.addText((t) =>
				t
					.setPlaceholder("HH:mm")
					.setValue(this.plugin.settings.timeFormat)
					.onChange(async (v) => {
						this.plugin.settings.timeFormat =
							v.trim() || "HH:mm";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Debug mode")
			.setDesc(
				"Log detailed information to the developer console. " +
					"Useful for troubleshooting template resolution issues.",
			)
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.debugMode)
					.onChange(async (v) => {
						this.plugin.settings.debugMode = v;
						await this.plugin.saveSettings();
					}),
			);
	}
}
