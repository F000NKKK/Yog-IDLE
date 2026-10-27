//! The symbol index of a project root, kept fresh file by file.

use super::*;

pub(super) struct IndexedFile {
    pub(super) modified: Option<SystemTime>,
    pub(super) symbols: Arc<Vec<Symbol>>,
}

#[derive(Default)]
pub(crate) struct RootIndex {
    /// Every searchable file, as `(absolute, relative)` paths.
    pub(super) files: Vec<(PathBuf, String)>,
    pub(super) symbols: HashMap<PathBuf, IndexedFile>,
}

impl RootIndex {
    pub(super) fn refresh(&mut self, root: &Path) {
        let all = FileMask::all();
        // Generated screen code (`.g.rs`) too, so its `ids`/`events`/`render`
        // show up in Code Search as in VS (`MainWindow.g.cs`).
        let mut files = search::project_files(root, &all, &crate::project::manifest::SEARCH_LAYOUT);
        files.extend(search::generated_files(
            root,
            &all,
            &crate::project::manifest::SEARCH_LAYOUT,
        ));
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
                        search::read_text(path, search::Decoding::Lossy)
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

/// The benches' entry points (feature `bench`).
#[cfg(feature = "bench")]
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
