//! Replace in Files: every match replaced, in open documents' buffers and on disk.

use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceRequest {
    pub root: Option<String>,
    pub scope: Scope,
    pub query: SearchQuery,
    pub replacement: String,
    #[serde(default)]
    pub documents: Vec<OpenDocument>,
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReplacedDocument {
    pub path: String,
    /// The buffer's new text — the frontend puts it into the open editor (undoable, left unsaved).
    pub text: String,
    pub count: usize,
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReplacedFile {
    pub path: String,
    pub count: usize,
}

#[derive(Clone, Default, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceSummary {
    pub documents: Vec<ReplacedDocument>,
    /// Files rewritten on disk (none of them open).
    pub files: Vec<ReplacedFile>,
    pub total: usize,
    pub errors: Vec<String>,
}

/// Replace All over the same set of files a search would cover: open
/// documents' new text comes back for the frontend to apply to their
/// buffers, every other file is rewritten on disk (non-UTF-8 files are left alone).
pub fn run_replace(
    request: &ReplaceRequest,
    may_write: &dyn Fn(&Path) -> Result<(), String>,
) -> Result<ReplaceSummary, String> {
    let matcher = Matcher::new(&request.query)?;
    let mask = FileMask::parse(&request.query.file_mask)?;
    let plan = plan(
        request.root.as_deref(),
        request.scope,
        &request.documents,
        &mask,
        // Generated code is rewritten by the next build — never replaced in.
        false,
    );
    let literal = !request.query.regex;
    let mut summary = ReplaceSummary::default();
    for (path, source) in &plan.items {
        match source {
            Source::Buffer(text) => {
                let (new_text, count) = matcher.replace_all(text, &request.replacement, literal);
                if count > 0 {
                    summary.total += count;
                    summary.documents.push(ReplacedDocument {
                        path: path.to_string_lossy().into_owned(),
                        text: new_text,
                        count,
                    });
                }
            }
            Source::Disk => {
                let Some(text) = read_text(path, true) else {
                    continue;
                };
                let (new_text, count) = matcher.replace_all(&text, &request.replacement, literal);
                if count == 0 {
                    continue;
                }
                let written = may_write(path)
                    .and_then(|()| std::fs::write(path, &new_text).map_err(|err| err.to_string()));
                match written {
                    Ok(()) => {
                        summary.total += count;
                        summary.files.push(ReplacedFile {
                            path: path.to_string_lossy().into_owned(),
                            count,
                        });
                    }
                    Err(err) => summary.errors.push(format!("{}: {err}", path.display())),
                }
            }
        }
    }
    Ok(summary)
}

/// Replace All in files — see `run_replace`.
#[tauri::command]
pub async fn replace_in_files(
    state: State<'_, Workspace>,
    request: ReplaceRequest,
) -> Result<ReplaceSummary, String> {
    check_root(&state, request.root.as_deref(), request.scope)?;
    let roots = state.roots();
    tauri::async_runtime::spawn_blocking(move || {
        run_replace(&request, &|path| roots.check(path).map_err(|m| m.to_string()))
    })
    .await
    .map_err(|err| err.to_string())?
}
