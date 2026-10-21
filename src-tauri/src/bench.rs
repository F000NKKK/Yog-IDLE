//! The backend's hot paths for `benches/backend.rs` — not an API; built
//! only with the `bench` feature.

/// The root the benches' documents are under.
const BENCH_ROOT: &str = "/bench";

use std::path::{Path, PathBuf};

pub use crate::symbols::{extract_symbols, fuzzy_match};
pub use substrate_platform::search::OpenDocument;

/// A call of the CLI service, as the front end makes it.
pub fn cli(
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    crate::cli::call(method, params)
}

/// What Yog needs here and has (`tools_status`).
pub fn tools_status() -> serde_json::Value {
    serde_json::to_value(crate::tools::tools_status()).unwrap_or_default()
}

/// A Code Search index over in-memory `(absolute, relative, source)` files.
pub struct CodeIndex(crate::symbols::RootIndex);

impl CodeIndex {
    pub fn new(files: &[(PathBuf, String, String)]) -> Self {
        CodeIndex(crate::symbols::RootIndex::from_sources(files))
    }

    /// Code Search's answer for `query` (all kinds), as sent to the frontend.
    pub fn search(&self, query: &str, limit: usize) -> String {
        let items = self
            .0
            .search(query, crate::symbols::CodeSearchMode::All, limit);
        serde_json::to_string(&items).unwrap_or_default()
    }
}

/// Find in Files over open documents, every batch as sent to the frontend.
pub fn find_in_documents(documents: &[OpenDocument], pattern: &str) -> String {
    let query = substrate_platform::search::SearchQuery {
        pattern: pattern.to_string(),
        match_case: false,
        whole_word: false,
        regex: false,
        file_mask: String::new(),
        include_generated: false,
    };
    let search = substrate_platform::search::Search {
        root: Some(BENCH_ROOT),
        scope: substrate_platform::search::Scope::Documents,
        query: &query,
        documents,
        max_lines: substrate_platform::search::DEFAULT_MAX_LINES,
        layout: &crate::manifest::SEARCH_LAYOUT,
    };
    let mut files = Vec::new();
    let _ = substrate_platform::search::run_search(&search, &|| true, &mut |file| files.push(file));
    serde_json::to_string(&files).unwrap_or_default()
}

/// `git status` output parsed into Git Changes' model, as sent to the frontend.
pub fn git_status(top: &Path, raw: &str) -> String {
    let mut status = substrate_platform::git::status::parse_status(raw);
    substrate_platform::git::status::set_abs_paths(&mut status, top);
    serde_json::to_string(&status).unwrap_or_default()
}
