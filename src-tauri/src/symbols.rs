//! Code Search (Ctrl+T) — Visual Studio's all-in-one search, backend half:
//! fuzzy matching over the project's files and over a symbol index of its
//! Rust sources (types: structs, enums, traits, type aliases, unions;
//! members: functions, methods, fields, variants, consts, statics, macros,
//! modules), plus the text mode, which is Find in Files capped to a few hits.
//!
//! Symbols come from `syn`; a file it can't parse (mid-edit, or using syntax
//! newer than it knows) falls back to a line-based regex extractor. The
//! index lives per project root and is refreshed lazily — every file's mtime
//! is checked again when the popup opens (`refresh`), so a saved file is
//! re-read the next time it's searched.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::SystemTime;

use regex::Regex;
use serde::{Deserialize, Serialize};
use syn::visit::{self, Visit};
use tauri::State;

use crate::AppState;
use crate::search::{self, FileMask, OpenDocument, Scope, SearchQuery};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SymbolKind {
    Struct,
    Enum,
    Trait,
    TypeAlias,
    Union,
    Function,
    Method,
    Field,
    Variant,
    Const,
    Static,
    Macro,
    Module,
    AssociatedType,
}

impl SymbolKind {
    /// As serialized (`camelCase`) — Code Search's `kind`.
    pub fn name(self) -> &'static str {
        match self {
            Self::Struct => "struct",
            Self::Enum => "enum",
            Self::Trait => "trait",
            Self::TypeAlias => "typeAlias",
            Self::Union => "union",
            Self::Function => "function",
            Self::Method => "method",
            Self::Field => "field",
            Self::Variant => "variant",
            Self::Const => "const",
            Self::Static => "static",
            Self::Macro => "macro",
            Self::Module => "module",
            Self::AssociatedType => "associatedType",
        }
    }

    /// Types (`t:`) — everything else is a member (`m:`).
    pub fn is_type(self) -> bool {
        matches!(
            self,
            Self::Struct | Self::Enum | Self::Trait | Self::TypeAlias | Self::Union
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Symbol {
    pub name: String,
    pub kind: SymbolKind,
    /// The enclosing type/trait (`Foo`, `Display for Foo`) or module path — `None` at a file's top level.
    pub container: Option<String>,
    /// 1-based.
    pub line: u32,
    /// 1-based, UTF-16 units.
    pub column: u32,
}

/// Every symbol `source` defines, in source order.
pub fn extract_symbols(source: &str) -> Vec<Symbol> {
    let lines: Vec<&str> = source.lines().collect();
    let parsed = syn::parse_file(source).ok().map(|file| {
        let mut collector = Collector {
            lines: &lines,
            containers: Vec::new(),
            symbols: Vec::new(),
        };
        collector.visit_file(&file);
        collector.symbols
    });
    // Spans of a parse are kept in a thread-local source map until dropped
    // this way — the file and every span are gone by now.
    proc_macro2::extra::invalidate_current_thread_spans();
    parsed.unwrap_or_else(|| extract_with_regex(source))
}

struct Collector<'a> {
    lines: &'a [&'a str],
    /// Enclosing modules and types, outermost first.
    containers: Vec<Container>,
    symbols: Vec<Symbol>,
}

enum Container {
    Module(String),
    Type(String),
}

impl Collector<'_> {
    fn container(&self) -> Option<String> {
        if let Some(Container::Type(name)) = self
            .containers
            .iter()
            .rev()
            .find(|c| matches!(c, Container::Type(_)))
        {
            return Some(name.clone());
        }
        let modules: Vec<&str> = self
            .containers
            .iter()
            .filter_map(|c| match c {
                Container::Module(name) => Some(name.as_str()),
                Container::Type(_) => None,
            })
            .collect();
        (!modules.is_empty()).then(|| modules.join("::"))
    }

    fn push(&mut self, ident: &syn::Ident, kind: SymbolKind) {
        let start = ident.span().start();
        let line_text = self
            .lines
            .get(start.line.saturating_sub(1))
            .copied()
            .unwrap_or("");
        let column = line_text
            .chars()
            .take(start.column)
            .map(char::len_utf16)
            .sum::<usize>()
            + 1;
        let name = ident.to_string();
        self.symbols.push(Symbol {
            name: name.strip_prefix("r#").map(str::to_string).unwrap_or(name),
            kind,
            container: self.container(),
            line: start.line as u32,
            column: column as u32,
        });
    }

    fn within(&mut self, container: Container, f: impl FnOnce(&mut Self)) {
        self.containers.push(container);
        f(self);
        self.containers.pop();
    }
}

/// `Foo` for `Foo<T>`, `&mut Foo`, `crate::a::Foo` — the name an impl block is listed under.
fn type_name(ty: &syn::Type) -> String {
    match ty {
        syn::Type::Path(path) => path
            .path
            .segments
            .last()
            .map_or_else(|| "?".to_string(), |s| s.ident.to_string()),
        syn::Type::Reference(reference) => type_name(&reference.elem),
        syn::Type::Paren(paren) => type_name(&paren.elem),
        syn::Type::Group(group) => type_name(&group.elem),
        syn::Type::Slice(slice) => format!("[{}]", type_name(&slice.elem)),
        syn::Type::Array(array) => format!("[{}]", type_name(&array.elem)),
        syn::Type::Ptr(ptr) => type_name(&ptr.elem),
        syn::Type::Tuple(_) => "()".to_string(),
        _ => "impl".to_string(),
    }
}

impl<'ast> Visit<'ast> for Collector<'_> {
    fn visit_item_mod(&mut self, node: &'ast syn::ItemMod) {
        self.push(&node.ident, SymbolKind::Module);
        self.within(Container::Module(node.ident.to_string()), |v| {
            visit::visit_item_mod(v, node)
        });
    }

    fn visit_item_struct(&mut self, node: &'ast syn::ItemStruct) {
        self.push(&node.ident, SymbolKind::Struct);
        self.within(Container::Type(node.ident.to_string()), |v| {
            visit::visit_item_struct(v, node)
        });
    }

    fn visit_item_union(&mut self, node: &'ast syn::ItemUnion) {
        self.push(&node.ident, SymbolKind::Union);
        self.within(Container::Type(node.ident.to_string()), |v| {
            visit::visit_item_union(v, node)
        });
    }

    fn visit_item_enum(&mut self, node: &'ast syn::ItemEnum) {
        self.push(&node.ident, SymbolKind::Enum);
        self.within(Container::Type(node.ident.to_string()), |v| {
            visit::visit_item_enum(v, node)
        });
    }

    fn visit_variant(&mut self, node: &'ast syn::Variant) {
        self.push(&node.ident, SymbolKind::Variant);
        let outer = self.container().unwrap_or_default();
        self.within(Container::Type(format!("{outer}::{}", node.ident)), |v| {
            visit::visit_variant(v, node)
        });
    }

    fn visit_field(&mut self, node: &'ast syn::Field) {
        if let Some(ident) = &node.ident {
            self.push(ident, SymbolKind::Field);
        }
        visit::visit_field(self, node);
    }

    fn visit_item_trait(&mut self, node: &'ast syn::ItemTrait) {
        self.push(&node.ident, SymbolKind::Trait);
        self.within(Container::Type(node.ident.to_string()), |v| {
            visit::visit_item_trait(v, node)
        });
    }

    fn visit_item_type(&mut self, node: &'ast syn::ItemType) {
        self.push(&node.ident, SymbolKind::TypeAlias);
        visit::visit_item_type(self, node);
    }

    fn visit_item_fn(&mut self, node: &'ast syn::ItemFn) {
        self.push(&node.sig.ident, SymbolKind::Function);
        visit::visit_item_fn(self, node);
    }

    fn visit_item_const(&mut self, node: &'ast syn::ItemConst) {
        self.push(&node.ident, SymbolKind::Const);
        visit::visit_item_const(self, node);
    }

    fn visit_item_static(&mut self, node: &'ast syn::ItemStatic) {
        self.push(&node.ident, SymbolKind::Static);
        visit::visit_item_static(self, node);
    }

    fn visit_item_macro(&mut self, node: &'ast syn::ItemMacro) {
        if let Some(ident) = &node.ident {
            self.push(ident, SymbolKind::Macro);
        }
        visit::visit_item_macro(self, node);
    }

    fn visit_item_impl(&mut self, node: &'ast syn::ItemImpl) {
        let self_ty = type_name(&node.self_ty);
        let name = match &node.trait_ {
            Some((path, _)) => match path.segments.last() {
                Some(segment) => format!("{} for {self_ty}", segment.ident),
                None => self_ty,
            },
            None => self_ty,
        };
        self.within(Container::Type(name), |v| visit::visit_item_impl(v, node));
    }

    fn visit_impl_item_fn(&mut self, node: &'ast syn::ImplItemFn) {
        self.push(&node.sig.ident, SymbolKind::Method);
        visit::visit_impl_item_fn(self, node);
    }

    fn visit_impl_item_const(&mut self, node: &'ast syn::ImplItemConst) {
        self.push(&node.ident, SymbolKind::Const);
        visit::visit_impl_item_const(self, node);
    }

    fn visit_impl_item_type(&mut self, node: &'ast syn::ImplItemType) {
        self.push(&node.ident, SymbolKind::AssociatedType);
        visit::visit_impl_item_type(self, node);
    }

    fn visit_trait_item_fn(&mut self, node: &'ast syn::TraitItemFn) {
        self.push(&node.sig.ident, SymbolKind::Method);
        visit::visit_trait_item_fn(self, node);
    }

    fn visit_trait_item_const(&mut self, node: &'ast syn::TraitItemConst) {
        self.push(&node.ident, SymbolKind::Const);
        visit::visit_trait_item_const(self, node);
    }

    fn visit_trait_item_type(&mut self, node: &'ast syn::TraitItemType) {
        self.push(&node.ident, SymbolKind::AssociatedType);
        visit::visit_trait_item_type(self, node);
    }
}

static ITEM_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"^\s*(?:pub(?:\s*\([^)]*\))?\s+)?(?:(?:default|const|async|unsafe|safe)\s+|extern\s+(?:"[^"]*"\s+)?)*(fn|struct|enum|trait|type|union|mod|const|static(?:\s+mut)?|macro_rules!)\s*([A-Za-z_][A-Za-z0-9_]*)"#,
    )
    .unwrap()
});
static IMPL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*(?:unsafe\s+)?impl\b(?:\s*<[^{]*?>)?\s+(?:([A-Za-z_][\w:]*)(?:<[^{]*>)?\s+for\s+)?&?(?:mut\s+)?(?:[\w]+::)*([A-Za-z_]\w*)").unwrap()
});

/// Best-effort extraction for a file `syn` can't parse: items declared at
/// the start of a line, with `impl` blocks tracked by indentation so methods
/// get their type as container.
pub fn extract_with_regex(source: &str) -> Vec<Symbol> {
    let mut symbols = Vec::new();
    let mut impl_block: Option<(usize, String)> = None;
    for (index, line) in source.lines().enumerate() {
        let indent = line.len() - line.trim_start().len();
        if let Some((impl_indent, _)) = &impl_block
            && indent <= *impl_indent
            && !line.trim().is_empty()
            && !line.trim_start().starts_with('}')
        {
            impl_block = None;
        }
        if let Some(caps) = IMPL_RE.captures(line) {
            let ty = caps[2].to_string();
            let name = match caps.get(1) {
                Some(tr) => format!(
                    "{} for {ty}",
                    tr.as_str().rsplit("::").next().unwrap_or(tr.as_str())
                ),
                None => ty,
            };
            impl_block = Some((indent, name));
            continue;
        }
        let Some(caps) = ITEM_RE.captures(line) else {
            continue;
        };
        let keyword = &caps[1];
        let ident = caps.get(2).unwrap();
        let in_impl = impl_block
            .as_ref()
            .filter(|(i, _)| indent > *i)
            .map(|(_, name)| name.clone());
        let kind = match keyword {
            "fn" if in_impl.is_some() => SymbolKind::Method,
            "fn" => SymbolKind::Function,
            "struct" => SymbolKind::Struct,
            "enum" => SymbolKind::Enum,
            "trait" => SymbolKind::Trait,
            "type" if in_impl.is_some() => SymbolKind::AssociatedType,
            "type" => SymbolKind::TypeAlias,
            "union" => SymbolKind::Union,
            "mod" => SymbolKind::Module,
            "const" => SymbolKind::Const,
            "macro_rules!" => SymbolKind::Macro,
            _ => SymbolKind::Static,
        };
        symbols.push(Symbol {
            name: ident.as_str().to_string(),
            kind,
            container: in_impl,
            line: index as u32 + 1,
            column: line[..ident.start()].encode_utf16().count() as u32 + 1,
        });
    }
    symbols
}

// -- Fuzzy matching ------------------------------------------------------------

/// How well `query` fuzzy-matches `candidate` (higher is better), and which
/// of `candidate`'s chars matched — a subsequence match, case-insensitive,
/// rewarding consecutive runs and matches at word starts (`_`, `/`, `::`,
/// camelCase humps), so `fif` finds `find_in_files` and `OFC` `OpenFilesContext`.
pub fn fuzzy_match(query: &str, candidate: &str) -> Option<(i32, Vec<usize>)> {
    let q: Vec<char> = query.chars().filter(|c| !c.is_whitespace()).collect();
    let c: Vec<char> = candidate.chars().collect();
    if q.is_empty() {
        return Some((0, Vec::new()));
    }
    if q.len() > c.len() {
        return None;
    }
    let lower = |ch: char| ch.to_lowercase().next().unwrap_or(ch);
    let ql: Vec<char> = q.iter().copied().map(lower).collect();
    let cl: Vec<char> = c.iter().copied().map(lower).collect();

    // Quick reject: not a subsequence at all.
    let mut k = 0;
    for &ch in &cl {
        if k < ql.len() && ch == ql[k] {
            k += 1;
        }
    }
    if k < ql.len() {
        return None;
    }

    const MATCH: i32 = 16;
    const BOUNDARY: i32 = 24;
    const FIRST_CHAR: i32 = 32;
    const CONSECUTIVE: i32 = 20;
    const GAP: i32 = 2;
    const CASE: i32 = 2;
    const NONE: i32 = i32::MIN / 2;

    let bonus: Vec<i32> = (0..c.len())
        .map(|j| {
            if j == 0 {
                return FIRST_CHAR;
            }
            let prev = c[j - 1];
            let cur = c[j];
            if !prev.is_alphanumeric()
                || (prev.is_lowercase() && cur.is_uppercase())
                || (!prev.is_ascii_digit() && cur.is_ascii_digit())
            {
                BOUNDARY
            } else {
                0
            }
        })
        .collect();

    let (n, m) = (q.len(), c.len());
    // score[i][j]: best score with q[..=i] matched and q[i] at c[j]; from[i][j]: where q[i-1] was.
    let mut score = vec![vec![NONE; m]; n];
    let mut from = vec![vec![usize::MAX; m]; n];
    for i in 0..n {
        // Best of row i-1 over k < j - 1, decayed by the gap to j.
        let mut run = NONE;
        let mut run_at = usize::MAX;
        for j in i..m {
            if i > 0 && j >= 2 {
                let candidate = score[i - 1][j - 2];
                if candidate > NONE && candidate - GAP >= run {
                    run = candidate - GAP;
                    run_at = j - 2;
                } else if run > NONE {
                    run -= GAP;
                }
            }
            if cl[j] != ql[i] {
                continue;
            }
            let here = MATCH + bonus[j] + if c[j] == q[i] { CASE } else { 0 };
            if i == 0 {
                // Matches further in are penalised a little.
                score[0][j] = here - (j as i32).min(20);
                continue;
            }
            let adjacent = if j >= 1 && score[i - 1][j - 1] > NONE {
                score[i - 1][j - 1] + CONSECUTIVE
            } else {
                NONE
            };
            if adjacent >= run && adjacent > NONE {
                score[i][j] = adjacent + here;
                from[i][j] = j - 1;
            } else if run > NONE {
                score[i][j] = run - GAP + here;
                from[i][j] = run_at;
            }
        }
    }
    let (mut j, best) = score[n - 1]
        .iter()
        .enumerate()
        .filter(|(_, s)| **s > NONE)
        .max_by_key(|(j, s)| (**s, std::cmp::Reverse(*j)))
        .map(|(j, s)| (j, *s))?;
    let mut positions = vec![0; n];
    for i in (0..n).rev() {
        positions[i] = j;
        j = from[i][j];
    }
    // Shorter candidates rank first among equal matches.
    let total = best - (m as i32 - n as i32).min(40) / 2 + if m == n { 40 } else { 0 };
    Some((total, positions))
}

/// `positions` (char indices into `text`) as UTF-16 offsets.
fn utf16_positions(text: &str, positions: &[usize]) -> Vec<u32> {
    if text.is_ascii() {
        return positions.iter().map(|&p| p as u32).collect();
    }
    let offsets: Vec<u32> = text
        .chars()
        .scan(0u32, |acc, ch| {
            let at = *acc;
            *acc += ch.len_utf16() as u32;
            Some(at)
        })
        .collect();
    positions
        .iter()
        .filter_map(|&p| offsets.get(p).copied())
        .collect()
}

// -- Index ---------------------------------------------------------------------

struct IndexedFile {
    modified: Option<SystemTime>,
    symbols: Arc<Vec<Symbol>>,
}

#[derive(Default)]
pub(crate) struct RootIndex {
    /// Every searchable file, as `(absolute, relative)` paths.
    files: Vec<(PathBuf, String)>,
    symbols: HashMap<PathBuf, IndexedFile>,
}

impl RootIndex {
    fn refresh(&mut self, root: &Path) {
        let all = FileMask::parse("").expect("empty mask");
        // Generated screen code (`.g.rs`) too, so its `ids`/`events`/`render`
        // show up in Code Search as in VS (`MainWindow.g.cs`).
        let mut files = search::project_files(root, &all);
        files.extend(search::generated_files(root, &all));
        self.files = files
            .into_iter()
            .map(|path| {
                let rel = search::relative(root, &path);
                (path, rel)
            })
            .collect();
        let mut fresh = HashMap::new();
        for (path, _) in self
            .files
            .iter()
            .filter(|(p, _)| p.extension().is_some_and(|e| e == "rs"))
        {
            let modified = std::fs::metadata(path).and_then(|m| m.modified()).ok();
            let entry = match self.symbols.remove(path) {
                Some(entry) if entry.modified == modified && modified.is_some() => entry,
                _ => IndexedFile {
                    modified,
                    symbols: Arc::new(
                        search::read_text(path, false)
                            .map(|text| extract_symbols(&text))
                            .unwrap_or_default(),
                    ),
                },
            };
            fresh.insert(path.clone(), entry);
        }
        self.symbols = fresh;
    }
}

impl RootIndex {
    /// An index over in-memory files (`(absolute, relative, source)`), for `crate::bench`.
    pub(crate) fn from_sources(files: &[(PathBuf, String, String)]) -> Self {
        RootIndex {
            files: files
                .iter()
                .map(|(p, r, _)| (p.clone(), r.clone()))
                .collect(),
            symbols: files
                .iter()
                .filter(|(p, _, _)| p.extension().is_some_and(|e| e == "rs"))
                .map(|(p, _, text)| {
                    let symbols = Arc::new(extract_symbols(text));
                    let file = IndexedFile {
                        modified: None,
                        symbols,
                    };
                    (p.clone(), file)
                })
                .collect(),
        }
    }

    pub(crate) fn search(
        &self,
        query: &str,
        mode: CodeSearchMode,
        limit: usize,
    ) -> Vec<CodeSearchItem> {
        search_index(self, query, mode, limit)
    }
}

/// Per project root, built on first use.
#[derive(Default)]
pub struct SymbolIndexState {
    roots: Arc<Mutex<HashMap<PathBuf, RootIndex>>>,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum CodeSearchMode {
    All,
    Files,
    Types,
    Members,
    Text,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeSearchRequest {
    pub root: String,
    pub query: String,
    pub mode: CodeSearchMode,
    /// Re-check every file's mtime (and pick up new/deleted files) first — the popup asks for this when it opens.
    #[serde(default)]
    pub refresh: bool,
    pub limit: Option<usize>,
    /// Open buffers, searched instead of their files in text mode.
    #[serde(default)]
    pub documents: Vec<OpenDocument>,
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CodeSearchItem {
    /// `"file"`, `"text"`, or a `SymbolKind`.
    pub kind: &'static str,
    /// What the row shows: a symbol's or file's name, a text hit's line.
    pub name: String,
    /// Dimmed after the name: a symbol's container, a file's folder.
    pub container: Option<String>,
    pub path: String,
    pub rel_path: String,
    pub line: Option<u32>,
    pub column: Option<u32>,
    /// UTF-16 offsets into `name` to highlight.
    pub highlights: Vec<u32>,
    #[serde(skip)]
    score: i32,
}

fn file_item(path: &Path, rel: &str, query: &str) -> Option<CodeSearchItem> {
    let (folder, name) = match rel.rfind('/') {
        Some(at) => (Some(&rel[..at]), &rel[at + 1..]),
        None => (None, rel),
    };
    // A match within the file name beats one spread over the path.
    let (score, highlights) = match fuzzy_match(query, name) {
        Some((score, positions)) => (score + 30, utf16_positions(name, &positions)),
        None => {
            let (score, positions) = fuzzy_match(query, rel)?;
            let offset = rel.chars().count() - name.chars().count();
            let in_name: Vec<usize> = positions
                .iter()
                .filter(|&&p| p >= offset)
                .map(|&p| p - offset)
                .collect();
            (score, utf16_positions(name, &in_name))
        }
    };
    Some(CodeSearchItem {
        kind: "file",
        name: name.to_string(),
        container: folder.map(str::to_string),
        path: path.to_string_lossy().into_owned(),
        rel_path: rel.to_string(),
        line: None,
        column: None,
        highlights,
        score,
    })
}

fn symbol_item(path: &Path, rel: &str, symbol: &Symbol, query: &str) -> Option<CodeSearchItem> {
    let (score, positions) = fuzzy_match(query, &symbol.name)?;
    Some(CodeSearchItem {
        kind: symbol.kind.name(),
        name: symbol.name.clone(),
        container: symbol.container.clone(),
        path: path.to_string_lossy().into_owned(),
        rel_path: rel.to_string(),
        line: Some(symbol.line),
        column: Some(symbol.column),
        highlights: utf16_positions(&symbol.name, &positions),
        // Types slightly ahead of members, as VS lists them.
        score: score + if symbol.kind.is_type() { 4 } else { 0 },
    })
}

/// Ranked matches for a query over an already-refreshed index.
fn search_index(
    index: &RootIndex,
    query: &str,
    mode: CodeSearchMode,
    limit: usize,
) -> Vec<CodeSearchItem> {
    if query.trim().is_empty() {
        return Vec::new();
    }
    let mut items = Vec::new();
    if matches!(mode, CodeSearchMode::All | CodeSearchMode::Files) {
        items.extend(
            index
                .files
                .iter()
                .filter_map(|(path, rel)| file_item(path, rel, query)),
        );
    }
    if matches!(
        mode,
        CodeSearchMode::All | CodeSearchMode::Types | CodeSearchMode::Members
    ) {
        for (path, rel) in &index.files {
            let Some(entry) = index.symbols.get(path) else {
                continue;
            };
            for symbol in entry.symbols.iter() {
                let wanted = match mode {
                    CodeSearchMode::Types => symbol.kind.is_type(),
                    CodeSearchMode::Members => !symbol.kind.is_type(),
                    _ => true,
                };
                if wanted && let Some(item) = symbol_item(path, rel, symbol, query) {
                    items.push(item);
                }
            }
        }
    }
    items.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.name.len().cmp(&b.name.len()))
            .then_with(|| a.rel_path.cmp(&b.rel_path))
            .then_with(|| a.line.cmp(&b.line))
    });
    items.truncate(limit);
    items
}

fn text_items(
    root: &str,
    query: &str,
    documents: &[OpenDocument],
    limit: usize,
) -> Result<Vec<CodeSearchItem>, String> {
    let q = SearchQuery {
        pattern: query.to_string(),
        match_case: false,
        whole_word: false,
        regex: false,
        file_mask: String::new(),
        include_generated: false,
    };
    let mut items = Vec::new();
    search::run_search(
        Some(root),
        Scope::Project,
        &q,
        documents,
        limit,
        &|| true,
        &mut |file| {
            for hit in file.hits {
                items.push(CodeSearchItem {
                    kind: "text",
                    highlights: hit.ranges.iter().flat_map(|&(s, e)| s..e).collect(),
                    name: hit.text,
                    container: None,
                    path: file.path.clone(),
                    rel_path: file.rel_path.clone(),
                    line: Some(hit.line),
                    column: Some(hit.column),
                    score: 0,
                });
            }
        },
    )?;
    Ok(items)
}

/// Code Search: ranked files/symbols (or text hits) for `query`.
#[tauri::command]
pub async fn code_search(
    state: State<'_, AppState>,
    index: State<'_, SymbolIndexState>,
    request: CodeSearchRequest,
) -> Result<Vec<CodeSearchItem>, String> {
    crate::validate_within_roots(&state, Path::new(&request.root))?;
    let limit = request.limit.unwrap_or(200).min(2000);
    if request.mode == CodeSearchMode::Text {
        if request.query.trim().is_empty() {
            return Ok(Vec::new());
        }
        return tauri::async_runtime::spawn_blocking(move || {
            text_items(&request.root, &request.query, &request.documents, limit)
        })
        .await
        .map_err(|err| err.to_string())?;
    }
    let roots = index.roots.clone();
    // Parsing a large project the first time takes a moment — off the async pool.
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(&request.root);
        let mut roots = roots.lock().unwrap();
        let built = roots.contains_key(&root);
        let entry = roots.entry(root.clone()).or_default();
        if request.refresh || !built {
            entry.refresh(&root);
        }
        search_index(entry, &request.query, request.mode, limit)
    })
    .await
    .map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_names_match_serde() {
        use SymbolKind::*;
        for kind in [
            Struct,
            Enum,
            Trait,
            TypeAlias,
            Union,
            Function,
            Method,
            Field,
            Variant,
            Const,
            Static,
            Macro,
            Module,
            AssociatedType,
        ] {
            assert_eq!(serde_json::to_value(kind).unwrap(), kind.name());
        }
    }

    const SAMPLE: &str = r#"
pub mod net {
    pub struct Client {
        pub url: String,
        r#type: u8,
    }

    impl Client {
        pub const MAX: usize = 4;
        pub fn connect(&self) {}
    }

    impl std::fmt::Display for Client {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { Ok(()) }
    }
}

enum Shape { Circle { radius: f32 }, Square(f32) }
trait Draw { type Out; fn draw(&self); }
type Alias = u32;
union Bits { i: u32, f: f32 }
static mut COUNT: u32 = 0;
macro_rules! shout { () => {} }
fn main() { let é = 1; fn inner() {} }
"#;

    fn find<'a>(symbols: &'a [Symbol], name: &str) -> &'a Symbol {
        symbols
            .iter()
            .find(|s| s.name == name)
            .unwrap_or_else(|| panic!("{name} not found in {symbols:#?}"))
    }

    #[test]
    fn syn_extracts_types_and_members_with_containers() {
        let symbols = extract_symbols(SAMPLE);
        let check = |name: &str, kind: SymbolKind, container: Option<&str>| {
            let s = find(&symbols, name);
            assert_eq!(
                (s.kind, s.container.as_deref()),
                (kind, container),
                "{name}"
            );
        };
        check("net", SymbolKind::Module, None);
        check("Client", SymbolKind::Struct, Some("net"));
        check("url", SymbolKind::Field, Some("Client"));
        check("type", SymbolKind::Field, Some("Client"));
        check("MAX", SymbolKind::Const, Some("Client"));
        check("connect", SymbolKind::Method, Some("Client"));
        check("fmt", SymbolKind::Method, Some("Display for Client"));
        check("Shape", SymbolKind::Enum, None);
        check("Circle", SymbolKind::Variant, Some("Shape"));
        check("radius", SymbolKind::Field, Some("Shape::Circle"));
        check("Draw", SymbolKind::Trait, None);
        check("Out", SymbolKind::AssociatedType, Some("Draw"));
        check("draw", SymbolKind::Method, Some("Draw"));
        check("Alias", SymbolKind::TypeAlias, None);
        check("Bits", SymbolKind::Union, None);
        check("COUNT", SymbolKind::Static, None);
        check("shout", SymbolKind::Macro, None);
        check("main", SymbolKind::Function, None);
        check("inner", SymbolKind::Function, None);
        let connect = find(&symbols, "connect");
        assert_eq!((connect.line, connect.column), (10, 16));
    }

    #[test]
    fn columns_count_utf16_units() {
        let symbols = extract_symbols("const É: u8 = 0; fn 𝔣() {}\n");
        // `𝔣` (non-ASCII identifier) sits after `É`, a 1-unit char, and is 2 units itself.
        let f = find(&symbols, "𝔣");
        assert_eq!((f.line, f.column), (1, 21));
    }

    #[test]
    fn unparsable_files_fall_back_to_regex() {
        let source = "pub struct Broken {\n    x: u8,\n\nimpl Broken {\n    pub async fn go(&self) {\n}\nimpl Show for Broken {\n    fn show() {}\n}\npub(crate) const fn helper() {}\nmacro_rules! m {}\n";
        assert!(syn::parse_file(source).is_err());
        let symbols = extract_symbols(source);
        assert_eq!(find(&symbols, "Broken").kind, SymbolKind::Struct);
        let go = find(&symbols, "go");
        assert_eq!(
            (go.kind, go.container.as_deref(), go.line, go.column),
            (SymbolKind::Method, Some("Broken"), 5, 18)
        );
        assert_eq!(
            find(&symbols, "show").container.as_deref(),
            Some("Show for Broken")
        );
        let helper = find(&symbols, "helper");
        assert_eq!(
            (helper.kind, helper.container.as_deref()),
            (SymbolKind::Function, None)
        );
        assert_eq!(find(&symbols, "m").kind, SymbolKind::Macro);
    }

    #[test]
    fn fuzzy_prefers_word_starts_and_runs() {
        assert!(fuzzy_match("xyz", "find_in_files").is_none());
        let (_, pos) = fuzzy_match("fif", "find_in_files").unwrap();
        assert_eq!(pos, vec![0, 5, 8]);
        let (_, pos) = fuzzy_match("OFC", "OpenFilesContext").unwrap();
        assert_eq!(pos, vec![0, 4, 9]);
        let exact = fuzzy_match("client", "Client").unwrap().0;
        let prefix = fuzzy_match("client", "ClientBuilder").unwrap().0;
        let scattered = fuzzy_match("client", "CodeLineIterEntNumTotal").unwrap().0;
        assert!(
            exact > prefix && prefix > scattered,
            "{exact} {prefix} {scattered}"
        );
        let (_, pos) = fuzzy_match("conn", "reconnect").unwrap();
        assert_eq!(pos, vec![2, 3, 4, 5]);
    }

    fn names(index: &RootIndex, mode: CodeSearchMode, query: &str) -> Vec<(&'static str, String)> {
        search_index(index, query, mode, 10)
            .into_iter()
            .map(|i| (i.kind, i.name))
            .collect()
    }

    #[test]
    fn index_ranks_files_and_symbols() {
        let dir = std::env::temp_dir().join(format!("yog-idle-symbols-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(
            dir.join("src/client.rs"),
            "pub struct Client;\nimpl Client { pub fn connect(&self) {} }\n",
        )
        .unwrap();
        std::fs::write(dir.join("README.md"), "# readme\n").unwrap();
        let mut index = RootIndex::default();
        index.refresh(&dir);
        assert_eq!(
            names(&index, CodeSearchMode::Types, "cli"),
            [("struct", "Client".to_string())]
        );
        assert_eq!(
            names(&index, CodeSearchMode::Members, "conn"),
            [("method", "connect".to_string())]
        );
        assert_eq!(
            names(&index, CodeSearchMode::Files, "read"),
            [("file", "README.md".to_string())]
        );
        let all = names(&index, CodeSearchMode::All, "client");
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].1, "Client");

        // An edited file is re-read on refresh.
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(dir.join("src/client.rs"), "pub enum Server {}\n").unwrap();
        let later = SystemTime::now() + std::time::Duration::from_secs(5);
        std::fs::File::options()
            .write(true)
            .open(dir.join("src/client.rs"))
            .unwrap()
            .set_modified(later)
            .unwrap();
        index.refresh(&dir);
        assert_eq!(
            names(&index, CodeSearchMode::Types, "srv"),
            [("enum", "Server".to_string())]
        );
        assert!(names(&index, CodeSearchMode::Types, "cli").is_empty());

        let items = text_items(&dir.to_string_lossy(), "fn connect", &[], 10).unwrap();
        assert!(items.is_empty());
        let items = text_items(&dir.to_string_lossy(), "enum", &[], 10).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].line, Some(1));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
