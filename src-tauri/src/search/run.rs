//! One search: what it covers (project or open documents), run file by file and streamed.

use super::*;

/// An open editor's buffer, searched instead of the file on disk.
#[derive(Deserialize)]
pub struct OpenDocument {
    pub path: String,
    pub text: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileResult {
    pub path: String,
    pub rel_path: String,
    pub hits: Vec<LineHit>,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    /// The documents passed in (Current document / All open documents).
    Documents,
    /// Every file under the root, open documents' buffers standing in for their files.
    Project,
}

/// One unit of work: a path and where its text comes from.
pub(super) enum Source<'a> {
    Buffer(&'a str),
    Disk,
}

pub(super) struct Plan<'a> {
    pub(super) root: Option<PathBuf>,
    pub(super) items: Vec<(PathBuf, Source<'a>)>,
}

pub(super) fn plan<'a>(
    root: Option<&str>,
    scope: Scope,
    documents: &'a [OpenDocument],
    mask: &FileMask,
    include_generated: bool,
) -> Plan<'a> {
    let root = root.map(PathBuf::from);
    match scope {
        Scope::Documents => Plan {
            items: documents
                .iter()
                .filter(|doc| {
                    let rel = root
                        .as_deref()
                        .map_or(doc.path.clone(), |r| relative(r, Path::new(&doc.path)));
                    mask.matches(&rel)
                })
                .map(|doc| (PathBuf::from(&doc.path), Source::Buffer(&doc.text)))
                .collect(),
            root,
        },
        Scope::Project => {
            let Some(dir) = root.clone() else {
                return Plan {
                    root,
                    items: Vec::new(),
                };
            };
            let buffers: HashMap<PathBuf, &str> = documents
                .iter()
                .flat_map(|doc| {
                    let raw = PathBuf::from(&doc.path);
                    let canonical = raw.canonicalize().ok();
                    std::iter::once((raw, doc.text.as_str()))
                        .chain(canonical.map(|c| (c, doc.text.as_str())))
                })
                .collect();
            let mut files = project_files(&dir, mask);
            if include_generated {
                files.extend(generated_files(&dir, mask));
            }
            let items = files
                .into_iter()
                .map(|path| {
                    let source = buffers
                        .get(&path)
                        .map_or(Source::Disk, |text| Source::Buffer(text));
                    (path, source)
                })
                .collect();
            Plan { root, items }
        }
    }
}

#[derive(Clone, Default, Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FindSummary {
    pub matching_lines: usize,
    pub matching_files: usize,
    pub files_searched: usize,
    /// Stopped at the result cap.
    pub truncated: bool,
    pub cancelled: bool,
}

/// Runs a search, handing each matching file to `emit` as it's found;
/// `keep_going` is polled between files.
pub fn run_search(
    root: Option<&str>,
    scope: Scope,
    query: &SearchQuery,
    documents: &[OpenDocument],
    max_lines: usize,
    keep_going: &dyn Fn() -> bool,
    emit: &mut dyn FnMut(FileResult),
) -> Result<FindSummary, String> {
    let matcher = Matcher::new(query)?;
    let mask = FileMask::parse(&query.file_mask)?;
    let plan = plan(root, scope, documents, &mask, query.include_generated);
    let mut summary = FindSummary::default();
    for (path, source) in &plan.items {
        if !keep_going() {
            summary.cancelled = true;
            break;
        }
        let owned;
        let text = match source {
            Source::Buffer(text) => *text,
            Source::Disk => match read_text(path, false) {
                Some(text) => {
                    owned = text;
                    &owned
                }
                None => continue,
            },
        };
        summary.files_searched += 1;
        let remaining = max_lines - summary.matching_lines;
        let matches = matcher.find_all(text, remaining.saturating_mul(4).max(64));
        if matches.is_empty() {
            continue;
        }
        let mut hits = line_hits(text, &matches);
        if hits.len() >= remaining {
            hits.truncate(remaining);
            summary.truncated = true;
        }
        summary.matching_lines += hits.len();
        summary.matching_files += 1;
        emit(FileResult {
            path: path.to_string_lossy().into_owned(),
            rel_path: plan.root.as_deref().map_or_else(
                || path.to_string_lossy().into_owned(),
                |r| relative(r, path),
            ),
            hits,
        });
        if summary.truncated {
            break;
        }
    }
    Ok(summary)
}
