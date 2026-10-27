//! Code Search: files, symbols and text matching a query, ranked.

use super::*;
use substrate_platform::sync::Locked;

/// Per project root, built on first use.
#[derive(Default)]
pub struct SymbolIndexState {
    pub(super) roots: Arc<Mutex<HashMap<PathBuf, RootIndex>>>,
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
    pub(super) score: i32,
}

pub(super) fn file_item(path: &Path, rel: &str, query: &str) -> Option<CodeSearchItem> {
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

pub(super) fn symbol_item(
    path: &Path,
    rel: &str,
    symbol: &Symbol,
    query: &str,
) -> Option<CodeSearchItem> {
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
pub(super) fn search_index(
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

pub(super) fn text_items(
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
    let search = Search {
        root: Some(root),
        scope: Scope::Project,
        query: &q,
        documents,
        max_lines: limit,
        layout: &crate::project::manifest::SEARCH_LAYOUT,
    };
    search::find(&search, &|| true, &mut |file| {
        for hit in file.hits {
            items.push(CodeSearchItem {
                kind: "text",
                highlights: hit.ranges.iter().flat_map(|&(s, e)| s..e).collect(),
                name: hit.text,
                container: None,
                path: file.path.clone(),
                rel_path: file.relative_path.clone(),
                line: Some(hit.line),
                column: Some(hit.column),
                score: 0,
            });
        }
    })
    .map_err(|m| m.to_string())?;
    Ok(items)
}

/// Code Search: ranked files/symbols (or text hits) for `query`.
#[tauri::command]
pub async fn code_search(
    state: State<'_, Workspace>,
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
        let mut roots = roots.locked();
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
