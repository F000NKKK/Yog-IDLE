//! Find in Files' commands: Find All, the files containing a query, the project's items, cancelling.

use super::*;

/// The id of the search allowed to keep running — a new search replaces it,
/// `find_cancel` clears it.
#[derive(Default)]
pub struct SearchState {
    pub(super) current: Arc<AtomicU64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindRequest {
    pub search_id: u64,
    /// The project root — required for `Project` scope, used for relative paths otherwise.
    pub root: Option<String>,
    pub scope: Scope,
    pub query: SearchQuery,
    #[serde(default)]
    pub documents: Vec<OpenDocument>,
    pub max_lines: Option<usize>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindBatch {
    pub files: Vec<FileResult>,
}

pub(super) fn check_root(state: &State<Workspace>, root: Option<&str>, scope: Scope) -> Result<(), String> {
    match root {
        Some(root) => crate::validate_within_roots(state, Path::new(root)),
        None if scope == Scope::Project => Err("no project is open".to_string()),
        None => Ok(()),
    }
}

/// Find All: streams matching files over `on_batch` (a batch at most every
/// ~100 ms) and resolves with the totals once done or cancelled.
#[tauri::command]
pub async fn find_in_files(
    state: State<'_, Workspace>,
    search: State<'_, SearchState>,
    request: FindRequest,
    on_batch: Channel<FindBatch>,
) -> Result<FindSummary, String> {
    check_root(&state, request.root.as_deref(), request.scope)?;
    let current = search.current.clone();
    current.store(request.search_id, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || {
        let id = request.search_id;
        let keep_going = || current.load(Ordering::SeqCst) == id;
        let mut pending = Vec::new();
        let mut last_flush = Instant::now();
        let summary = run_search(
            request.root.as_deref(),
            request.scope,
            &request.query,
            &request.documents,
            request.max_lines.unwrap_or(DEFAULT_MAX_LINES),
            &keep_going,
            &mut |file| {
                pending.push(file);
                if last_flush.elapsed() > Duration::from_millis(100) {
                    let _ = on_batch.send(FindBatch {
                        files: std::mem::take(&mut pending),
                    });
                    last_flush = Instant::now();
                }
            },
        );
        if !pending.is_empty() {
            let _ = on_batch.send(FindBatch { files: pending });
        }
        summary
    })
    .await
    .map_err(|err| err.to_string())?
}

/// How many files the explorer's content search lists at most.
pub(super) const MAX_CONTAINING_FILES: usize = 5_000;

/// Project Explorer's search and filters: the project's files and folders
/// (`project_entries`), the ones the lazily listed tree hasn't opened too.
#[tauri::command]
pub async fn project_items(state: State<'_, Workspace>, root: String) -> Result<Vec<ProjectEntry>, String> {
    crate::validate_within_roots(&state, Path::new(&root))?;
    tauri::async_runtime::spawn_blocking(move || project_entries(Path::new(&root)))
        .await
        .map_err(|err| err.to_string())
}

/// Project Explorer's "Search within file contents": the project files
/// whose text matches. Separate from `find_in_files`, so typing in the
/// explorer never cancels a Find in Files still running.
#[tauri::command]
pub async fn project_files_containing(
    state: State<'_, Workspace>,
    root: String,
    query: SearchQuery,
) -> Result<Vec<String>, String> {
    crate::validate_within_roots(&state, Path::new(&root))?;
    tauri::async_runtime::spawn_blocking(move || files_containing(Path::new(&root), &query, MAX_CONTAINING_FILES))
        .await
        .map_err(|err| err.to_string())?
}

/// Stops whatever search is running.
#[tauri::command]
pub fn find_cancel(search: State<SearchState>) {
    search.current.store(0, Ordering::SeqCst);
}
