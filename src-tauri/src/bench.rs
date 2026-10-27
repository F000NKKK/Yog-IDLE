//! The backend's hot paths for `benches/backend.rs` — not an API; built
//! only with the `bench` feature.

/// The root the benches' documents are under.
const BENCH_ROOT: &str = "/bench";

use std::path::{Path, PathBuf};

pub use crate::symbols::{extract_symbols, fuzzy_match};
pub use substrate_search_domain::project::OpenDocument;

/// A call of the CLI service, as the front end makes it: a request's
/// binary form in, the answer's out.
pub fn cli(request: &[u8]) -> Result<Vec<u8>, String> {
    crate::toolchain::cli::exchange(request)
}

/// What Yog needs here and has (`tools_status`).
pub fn tools_status() -> serde_json::Value {
    serde_json::to_value(crate::toolchain::tools::tools_status()).unwrap_or_default()
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
    let query = substrate_search_domain::query::SearchQuery {
        pattern: pattern.to_string(),
        ..substrate_search_domain::query::SearchQuery::default()
    };
    let search = substrate_search_app::Search {
        root: Some(BENCH_ROOT),
        scope: substrate_search_domain::project::Scope::Documents,
        query: &query,
        documents,
        max_lines: substrate_search_app::DEFAULT_MAX_LINES,
        layout: &crate::project::manifest::SEARCH_LAYOUT,
    };
    let mut files = Vec::new();
    let adapters = (
        &substrate_search_ignore::IgnoreWalker,
        &substrate_search_ignore::DiskDocuments::default(),
    );
    let _ = substrate_search_app::find(&search, adapters, &|| true, &mut |file| files.push(file));
    format!("{files:?}")
}

/// `git status` output parsed into Git Changes' model, as sent to the frontend.
pub fn git_status(top: &Path, raw: &str) -> String {
    let mut status = substrate_git_gitcli::porcelain::parse_status(raw);
    status.set_absolute_paths(top);
    format!("{status:?}")
}
