//! The project's files as a search walks them: .gitignore-aware, build output and binaries skipped; generated code; text read safely.

use super::*;

/// The walk over a project's own files: .gitignore'd entries (whether or
/// not the folder is a git repository) and `SKIP_DIRS` are left out, in path
/// order.
pub(super) fn project_walk(root: &Path) -> ignore::Walk {
    let mut builder = ignore::WalkBuilder::new(root);
    builder
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .parents(true)
        .sort_by_file_name(|a, b| a.cmp(b))
        .filter_entry(|entry| {
            !(entry.file_type().is_some_and(|t| t.is_dir())
                && entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| SKIP_DIRS.contains(&name)))
        });
    builder.build()
}

/// Every searchable file under `root`, in path order: what `project_walk`
/// gives, files outside `mask` left out. Binary/oversized files are filtered
/// later, when read.
pub fn project_files(root: &Path, mask: &FileMask) -> Vec<PathBuf> {
    project_walk(root)
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_some_and(|t| t.is_file()))
        .map(ignore::DirEntry::into_path)
        .filter(|path| mask.matches(&relative(root, path)))
        .collect()
}

/// A file or folder of the project, as `dir_list` gives one.
#[derive(Clone, Serialize, Debug, PartialEq)]
pub struct ProjectEntry {
    pub name: String,
    pub path: String,
    pub kind: &'static str,
}

/// Every file and folder under `root` (not `root` itself) that `project_walk` keeps.
pub fn project_entries(root: &Path) -> Vec<ProjectEntry> {
    project_walk(root)
        .filter_map(Result::ok)
        .filter(|entry| entry.depth() > 0)
        .filter_map(|entry| {
            let kind = match entry.file_type() {
                Some(t) if t.is_dir() => "dir",
                Some(t) if t.is_file() => "file",
                _ => return None,
            };
            Some(ProjectEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: entry.path().to_string_lossy().into_owned(),
                kind,
            })
        })
        .collect()
}

/// The project files whose text matches `query`, at most `limit` of them.
pub fn files_containing(root: &Path, query: &SearchQuery, limit: usize) -> Result<Vec<String>, String> {
    let matcher = Matcher::new(query)?;
    let mask = FileMask::parse(&query.file_mask)?;
    Ok(project_files(root, &mask)
        .into_iter()
        .filter(|path| read_text(path, false).is_some_and(|text| !matcher.find_all(&text, 1).is_empty()))
        .take(limit)
        .map(|path| path.to_string_lossy().into_owned())
        .collect())
}

/// Where `yog` generates screen code (`.yui` → `.g.rs`), under the build
/// folder of a project root.
pub(super) const GENERATED_DIR: &str = "generated";

/// The generated code files under `root` (`.yog-build/generated/**/*.rs`)
/// that pass `mask`, in path order — not project files (all of `.yog-build`
/// is skipped and git-ignored), but worth searching like VS's `*.g.cs`.
pub fn generated_files(root: &Path, mask: &FileMask) -> Vec<PathBuf> {
    let dir = root.join(crate::manifest::BUILD_DIR).join(GENERATED_DIR);
    if !dir.is_dir() {
        return Vec::new();
    }
    let mut builder = ignore::WalkBuilder::new(&dir);
    builder
        .standard_filters(false)
        .sort_by_file_name(|a, b| a.cmp(b));
    builder
        .build()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_some_and(|t| t.is_file()))
        .map(ignore::DirEntry::into_path)
        .filter(|path| path.extension().is_some_and(|e| e == "rs"))
        .filter(|path| mask.matches(&relative(root, path)))
        .collect()
}

/// `path` relative to `root`, with `/` separators — or the whole path when it isn't under it.
pub fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// A file's text, or `None` for one that's too large, binary, unreadable —
/// or, when `strict`, not valid UTF-8 (a replace mustn't mangle it).
pub fn read_text(path: &Path, strict: bool) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > MAX_FILE_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if bytes[..bytes.len().min(BINARY_SNIFF_BYTES)].contains(&0) {
        return None;
    }
    match String::from_utf8(bytes) {
        Ok(text) => Some(text),
        Err(err) if !strict => Some(String::from_utf8_lossy(err.as_bytes()).into_owned()),
        Err(_) => None,
    }
}
