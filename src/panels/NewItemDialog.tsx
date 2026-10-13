import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button, FloatingWindow, Icon, SearchField, TextField, useT, type DirEntry } from "substrate-platform-ui";
import { newBlockFile, newBlockWithItemFile, newItemFile, titleOf } from "../content/model";
import { validateEntryName } from "../paths";
import { pascalName } from "../designer/components";
import "./NewItemDialog.css";

/** One entry of Add > New Item — what file(s) it makes and what goes in them. */
export interface ItemTemplate {
  id: string;
  /** The category in the full dialog's left pane. */
  category: "Yog" | "Rust" | "Data" | "General";
  name: string;
  description: string;
  /** With the dot: `".rs"`. */
  extension: string;
  /** The default name's stem — numbered, Visual Studio style: `screen1.yui`. */
  baseName: string;
  /** The files it makes for `stem` — file name → contents. Default: one empty `stem + extension`. */
  files?: (stem: string, ctx: TemplateContext) => [string, string][];
  /** Suggest `baseName` itself before numbering (`Strings.yres`, then `Strings1.yres`). */
  unnumbered?: boolean;
  /** Added on the project root, the files go into this folder of it (made if missing) — `resources` for `.yres`. */
  rootFolder?: string;
}

export interface TemplateContext {
  /** The mod's id from `yog.toml` (`[mod] id`), or a stand-in. */
  modId: string;
  /** The target folder relative to the project's `src/` (`""` = `src/` itself, `/`-separated). */
  srcDir?: string;
}

const CATEGORIES: ItemTemplate["category"][] = ["Yog", "Rust", "Data", "General"];

const uiId = (stem: string) => stem.toLowerCase().replace(/[^a-z0-9_]+/g, "_");

export const ITEM_TEMPLATES: ItemTemplate[] = [
  {
    id: "yui",
    category: "Yog",
    name: "Yog UI Screen",
    description: "A screen for the designer (.yui) and its code-behind module (.rs); the code between them is generated into .yog-build on save.",
    extension: ".yui",
    baseName: "screen",
    files: (stem, { modId, srcDir }) => [
      [
        `${stem}.yui`,
        `<?xml version="1.0" encoding="utf-8"?>\n<Screen id="${modId}:${uiId(stem)}" width="176" height="166" anchor="center" bg="#C0101010" padding="8">\n  <Label id="title" x="8" y="6" text="${stem}" color="#FFFFFF" no_wrap="true"/>\n</Screen>\n`,
      ],
      [
        `${stem}.rs`,
        `// Code-behind of ${stem}.yui; its generated half (ID, ids, events, build, render, click, open, close, ...)\n// is pulled in from .yog-build/generated/ by ui_include!.\nyog_api::ui_include!("${srcDir ? `${srcDir}/` : ""}${stem}");\n\npub fn register(registry: &mut yog_api::Registry) {\n    registry.on_ui_render(ID, |gfx| render(gfx));\n    registry.register_ui(ID, |_ui_id, event| {\n        let _ = click(event);\n    });\n}\n`,
      ],
    ],
  },
  {
    id: "yui-component",
    category: "Yog",
    name: "Component (.yui)",
    description:
      "A reusable UI component: a .yui with a <Component> root declaring its properties and events, its body bound to them with {x:Bind name}. It appears in the designer's toolbox; yog build generates its Rust type. Add a code-behind <name>.rs (ui_include!) only if its bindings call code.",
    extension: ".yui",
    baseName: "component",
    files: (stem) => [
      [
        `${stem}.yui`,
        `<?xml version="1.0" encoding="utf-8"?>\n<Component name="${pascalName(stem) || "Component"}" doc="" width="80" height="20">\n  <Property name="text" type="text" default="${stem}" doc="The caption."/>\n  <Property name="color" type="color" default="#FF3A6EA5" doc="The background."/>\n  <Panel bg="{x:Bind color}" padding="4">\n    <Label text="{x:Bind text}" color="#FFFFFF" no_wrap="true"/>\n  </Panel>\n</Component>\n`,
      ],
    ],
  },
  {
    id: "yog-module",
    category: "Yog",
    name: "Yog Module",
    description: "A Rust module with a register function to call from the mod's Mod::register.",
    extension: ".rs",
    baseName: "feature",
    files: (stem) => [[`${stem}.rs`, `pub fn register(registry: &mut yog_api::Registry) {\n    let _ = registry;\n}\n`]],
  },
  {
    id: "yog-resources",
    category: "Yog",
    name: "Resources File",
    description:
      "A .yres resource set — texts (translated per language), images, sounds, colors and numbers, opened in the resource editor; yog build compiles it and generates typed accessors (Strings::example()). Goes into resources/.",
    extension: ".yres",
    baseName: "Strings",
    unnumbered: true,
    rootFolder: "resources",
    files: (stem, { modId }) => [
      [
        `${stem}.yres`,
        `{\n  "example": { "value": "Example", "comment": "Translation key ${modId}.example; ${stem}::example() in code, @${stem}.example in .yui" }\n}\n`,
      ],
    ],
  },
  {
    id: "yog-block",
    category: "Yog",
    name: "Block",
    description:
      "A block (.yblock): its properties, 3D model, block states and item form in one file, opened in the 3D model editor; yog build turns it into Minecraft's models, blockstates, loot table and tags, and registers it. Goes into content/.",
    extension: ".yblock",
    baseName: "block",
    rootFolder: "content",
    files: (stem) => [[`${stem}.yblock`, newBlockFile(titleOf(stem))]],
  },
  {
    id: "yog-item",
    category: "Yog",
    name: "Item",
    description: "An item (.yitem): its properties and model (a sprite or 3D), opened in the 3D model editor; yog build registers it. Goes into content/.",
    extension: ".yitem",
    baseName: "item",
    rootFolder: "content",
    files: (stem) => [[`${stem}.yitem`, newItemFile(titleOf(stem))]],
  },
  {
    id: "yog-block-item",
    category: "Yog",
    name: "Block with Item",
    description: "A block (.yblock) whose item has its own sprite (item_model) instead of the block's 3D model in hand. Goes into content/.",
    extension: ".yblock",
    baseName: "block",
    rootFolder: "content",
    files: (stem) => [[`${stem}.yblock`, newBlockWithItemFile(titleOf(stem))]],
  },
  {
    id: "yog-lang",
    category: "Yog",
    name: "Language File",
    description:
      "The texts of a resource set in another language: <Set>.<locale>.yres next to <Set>.yres (e.g. Strings.ru_ru.yres). The resource editor's All Languages view shows them side by side.",
    extension: ".yres",
    baseName: "Strings.ru_ru",
    unnumbered: true,
    rootFolder: "resources",
    files: (stem) => [[`${stem}.yres`, "{\n}\n"]],
  },
  { id: "rust", category: "Rust", name: "Rust Source File", description: "An empty Rust module.", extension: ".rs", baseName: "module" },
  {
    id: "rust-tests",
    category: "Rust",
    name: "Rust Module with Tests",
    description: "A Rust module with a #[cfg(test)] tests submodule.",
    extension: ".rs",
    baseName: "module",
    files: (stem) => [[`${stem}.rs`, `#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn it_works() {}\n}\n`]],
  },
  { id: "json", category: "Data", name: "JSON File", description: "An empty JSON object.", extension: ".json", baseName: "data", files: (stem) => [[`${stem}.json`, "{\n}\n"]] },
  { id: "toml", category: "Data", name: "TOML File", description: "An empty TOML file.", extension: ".toml", baseName: "config" },
  {
    id: "xml",
    category: "Data",
    name: "XML File",
    description: "An XML document with its declaration.",
    extension: ".xml",
    baseName: "data",
    files: (stem) => [[`${stem}.xml`, `<?xml version="1.0" encoding="utf-8"?>\n`]],
  },
  { id: "markdown", category: "General", name: "Markdown File", description: "A Markdown document.", extension: ".md", baseName: "notes", files: (stem) => [[`${stem}.md`, `# ${stem}\n`]] },
  { id: "text", category: "General", name: "Text File", description: "An empty text file.", extension: ".txt", baseName: "text" },
];

/** The files `template` makes for `name` (its extension included). */
export function templateFiles(template: ItemTemplate, name: string, ctx: TemplateContext): [string, string][] {
  const stem = name.slice(0, name.length - template.extension.length) || name;
  return template.files ? template.files(stem, ctx) : [[name, ""]];
}

/** `base1.ext`, `base2.ext`, ... — the first whose files are all free. */
function freeName(template: ItemTemplate, taken: Set<string>): string {
  for (let n = template.unnumbered ? 0 : 1; ; n++) {
    const name = `${template.baseName}${n || ""}${template.extension}`;
    const files = templateFiles(template, name, { modId: "" }).map(([file]) => file.toLowerCase());
    if (files.every((file) => !taken.has(file))) return name;
  }
}

/** The folder's entries, lowercased — what a new name mustn't clash with. */
function useTakenNames(folder: string): Set<string> | null {
  const [taken, setTaken] = useState<Set<string> | null>(null);
  useEffect(() => {
    invoke<DirEntry[]>("dir_list", { path: folder })
      .then((entries) => setTaken(new Set(entries.map((e) => e.name.toLowerCase()))))
      .catch(() => setTaken(new Set()));
  }, [folder]);
  return taken;
}

export interface NewItemDialogProps {
  folder: string;
  /** Start in the full Add New Item dialog rather than Quick Add. */
  full?: boolean;
  /** Create the template's files (`name` has its extension). */
  onAdd: (template: ItemTemplate, name: string) => Promise<void>;
  /** Quick Add: a plain file (by whatever extension was typed), or a folder for a name ending in `/`. */
  onAddPlain: (name: string, folder: boolean) => Promise<void>;
  onClose: () => void;
}

/**
 * Add > New Item (Ctrl+Shift+A), as in Visual Studio 2026: Quick Add first —
 * just a name, the extension picking the kind of file (`foo/` a folder) —
 * and "Show All Templates" for the full dialog: categories, templates,
 * search, a description, then a name.
 */
export function NewItemDialog(props: NewItemDialogProps) {
  const [full, setFull] = useState(!!props.full);
  return full ? <AllTemplates {...props} /> : <QuickAdd {...props} onShowAll={() => setFull(true)} />;
}

function QuickAdd({ folder, onAddPlain, onClose, onShowAll }: NewItemDialogProps & { onShowAll: () => void }) {
  const t = useT();
  const taken = useTakenNames(folder);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const isFolder = /[/\\]$/.test(name.trim());
  const plain = name.trim().replace(/[/\\]+$/, "");
  const error = validateEntryName(plain) ?? (taken?.has(plain.toLowerCase()) ? t("\"{name}\" already exists here.", { name: plain }) : null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (error !== null || busy) return;
    setBusy(true);
    try {
      await onAddPlain(plain, isFolder);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <FloatingWindow title={t("Quick Add")} icon={<Icon name="file" size={14} />} onClose={onClose} width={440} className="new-item-dialog">
      <form className="new-item-body" onSubmit={submit}>
        <TextField autoFocus value={name} placeholder={t("Name (end with / for a folder)")} onChange={(e) => setName(e.target.value)} />
        {error && plain !== "" && <p className="new-item-error">{error}</p>}
        <div className="new-item-footer">
          <Button type="button" variant="ghost" className="new-item-show-all" onClick={onShowAll}>
            {t("Show All Templates")}
          </Button>
          <Button type="submit" variant="primary" disabled={error !== null || busy}>
            {t("Add")}
          </Button>
          <Button type="button" onClick={onClose}>
            {t("Cancel")}
          </Button>
        </div>
      </form>
    </FloatingWindow>
  );
}

function AllTemplates({ folder, onAdd, onClose }: NewItemDialogProps) {
  const t = useT();
  const taken = useTakenNames(folder);
  const [category, setCategory] = useState<ItemTemplate["category"] | null>(null);
  const [query, setQuery] = useState("");
  const [template, setTemplate] = useState(ITEM_TEMPLATES[0]);
  const [name, setName] = useState("");
  // Until the user types a name, switching templates switches the suggested one too.
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ITEM_TEMPLATES.filter(
      (item) =>
        (!category || item.category === category) &&
        (!q || [item.name, item.description, item.extension].some((text) => t(text).toLowerCase().includes(q) || text.toLowerCase().includes(q)))
    );
  }, [category, query, t]);

  const suggested = taken ? freeName(template, taken) : "";
  const value = edited ? name : suggested;
  const trimmed = value.trim();
  const fullName = trimmed.toLowerCase().endsWith(template.extension) ? trimmed : `${trimmed}${template.extension}`;
  const clash = templateFiles(template, fullName, { modId: "" }).find(([file]) => taken?.has(file.toLowerCase()));
  const error = validateEntryName(value) ?? (clash ? t("\"{name}\" already exists here.", { name: clash[0] }) : null);

  useEffect(() => {
    // Select the stem, as Visual Studio does, so typing replaces it.
    const input = inputRef.current;
    if (!input || edited) return;
    input.setSelectionRange(0, Math.max(0, input.value.length - template.extension.length));
  }, [template, suggested, edited]);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (error !== null || busy || !taken) return;
    setBusy(true);
    try {
      await onAdd(template, fullName);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <FloatingWindow title={t("Add New Item")} icon={<Icon name="file" size={14} />} onClose={onClose} width={760} className="new-item-dialog">
      <form className="new-item-body" onSubmit={submit}>
        <div className="new-item-top">
          <SearchField value={query} onValueChange={setQuery} placeholder={t("Search templates")} />
        </div>
        <div className="new-item-panes">
          <ul className="new-item-categories" role="listbox" aria-label={t("Categories")}>
            {[null, ...CATEGORIES].map((c) => (
              <li key={c ?? "all"} role="option" aria-selected={c === category} className="new-item-category" onClick={() => setCategory(c)}>
                {c ? t(c) : t("All")}
              </li>
            ))}
          </ul>
          <ul className="new-item-templates" role="listbox" aria-label={t("Templates")}>
            {shown.map((item) => (
              <li
                key={item.id}
                role="option"
                aria-selected={item === template}
                className="new-item-template"
                onClick={() => setTemplate(item)}
                onDoubleClick={() => {
                  setTemplate(item);
                  if (!edited) void submit();
                }}
              >
                <Icon name="file" size={15} />
                <span className="new-item-template-name">{t(item.name)}</span>
                <span className="new-item-template-ext">{t(item.category)}</span>
              </li>
            ))}
            {shown.length === 0 && <li className="new-item-none">{t("No templates match.")}</li>}
          </ul>
          <div className="new-item-info">
            <div className="new-item-info-name">{t(template.name)}</div>
            <div className="new-item-info-type">
              {t("Type:")} {t(template.category)} · {template.extension}
            </div>
            <p className="new-item-description">{t(template.description)}</p>
          </div>
        </div>
        <label className="new-item-name">
          <span>{t("Name:")}</span>
          <TextField
            ref={inputRef}
            autoFocus
            value={value}
            onChange={(e) => {
              setName(e.target.value);
              setEdited(true);
            }}
          />
        </label>
        {error && trimmed !== "" && <p className="new-item-error">{error}</p>}
        <div className="new-item-footer">
          <Button type="submit" variant="primary" disabled={error !== null || busy || !taken}>
            {t("Add")}
          </Button>
          <Button type="button" onClick={onClose}>
            {t("Cancel")}
          </Button>
        </div>
      </form>
    </FloatingWindow>
  );
}
