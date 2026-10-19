//! The backend's hot paths for `benches/backend.rs` — not an API; built
//! only with the `bench` feature.

use std::path::{Path, PathBuf};

pub use crate::search::OpenDocument;
pub use crate::symbols::{extract_symbols, fuzzy_match};

/// A call of the CLI service, as the front end makes it.
pub fn cli(method: &str, params: serde_json::Value) -> Result<serde_json::Value, serde_json::Value> {
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
    let query = crate::search::SearchQuery {
        pattern: pattern.to_string(),
        match_case: false,
        whole_word: false,
        regex: false,
        file_mask: String::new(),
        include_generated: false,
    };
    let mut files = Vec::new();
    let _ = crate::search::run_search(
        Some("/bench"),
        crate::search::Scope::Documents,
        &query,
        documents,
        crate::search::DEFAULT_MAX_LINES,
        &|| true,
        &mut |file| files.push(file),
    );
    serde_json::to_string(&crate::search::FindBatch { files }).unwrap_or_default()
}

/// `git status` output parsed into Git Changes' model, as sent to the frontend.
pub fn git_status(top: &Path, raw: &str) -> String {
    let mut status = substrate_platform::git::status::parse_status(raw);
    substrate_platform::git::status::set_abs_paths(&mut status, top);
    serde_json::to_string(&status).unwrap_or_default()
}
