//! Find in Files / Replace in Files — Visual Studio's "Find and Replace"
//! window, backend half. A search runs over a project (a .gitignore-aware
//! walk that skips build output, VCS metadata and binaries) or over just the
//! open documents, whose *buffer* text the frontend passes in — so unsaved
//! edits are what's searched, not what's on disk. Results stream back over a
//! channel file by file, and a newer search (or `find_cancel`) stops an
//! older one.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use globset::{Glob, GlobSet, GlobSetBuilder};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::Channel;

use crate::AppState;

/// Directories never searched, ignored or not: build output, dependencies,
/// VCS metadata, Yog's generated crates and Yog-IDLE's own per-project data.
const SKIP_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "target",
    "node_modules",
    ".yog-build",
    ".yog-idle",
];

/// Files larger than this are assumed not to be source and skipped.
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
/// A NUL byte this early in a file marks it as binary.
const BINARY_SNIFF_BYTES: usize = 8000;
/// A result line longer than this is shown as a window around its first match.
const MAX_LINE_CHARS: usize = 400;
/// Default cap on matching lines per search.
const DEFAULT_MAX_LINES: usize = 20_000;

/// What to look for — shared by Find in Files, Replace in Files and Code Search's text mode.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub pattern: String,
    #[serde(default)]
    pub match_case: bool,
    #[serde(default)]
    pub whole_word: bool,
    #[serde(default)]
    pub regex: bool,
    /// File types mask, VS-style: `*.rs;*.toml`, `!*.lock` excludes; empty means all files.
    #[serde(default)]
    pub file_mask: String,
    /// Also search generated code (`.yog-build/generated/**`, a screen's
    /// `.g.rs`) — skipped with the rest of `.yog-build` otherwise.
    #[serde(default)]
    pub include_generated: bool,
}

/// The compiled pattern, with VS's "Match whole word" applied as a check on
/// each match's neighbours (the regex engine has no lookaround) rather than
/// by wrapping the pattern in `\b`, which would fail for patterns that start
/// or end with punctuation.
pub struct Matcher {
    re: Regex,
    whole_word: bool,
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

impl Matcher {
    pub fn new(query: &SearchQuery) -> Result<Self, String> {
        if query.pattern.is_empty() {
            return Err("the search text is empty".to_string());
        }
        let source = if query.regex {
            query.pattern.clone()
        } else {
            regex::escape(&query.pattern)
        };
        let re = RegexBuilder::new(&source)
            .case_insensitive(!query.match_case)
            .multi_line(true)
            .crlf(true)
            .build()
            .map_err(|err| format!("invalid regular expression: {err}"))?;
        Ok(Self {
            re,
            whole_word: query.whole_word,
        })
    }

    fn is_whole_word(text: &str, start: usize, end: usize) -> bool {
        let before = text[..start].chars().next_back();
        let after = text[end..].chars().next();
        let first = text[start..end].chars().next();
        let last = text[start..end].chars().next_back();
        // Only a word character at the match's own edge needs a non-word
        // neighbour — `->` as a whole word still matches inside `a->b`.
        let left_ok = !(first.is_some_and(is_word_char) && before.is_some_and(is_word_char));
        let right_ok = !(last.is_some_and(is_word_char) && after.is_some_and(is_word_char));
        left_ok && right_ok
    }

    /// Byte ranges of every non-empty match in `text`, left to right, non-overlapping.
    pub fn find_all(&self, text: &str, limit: usize) -> Vec<(usize, usize)> {
        let mut out = Vec::new();
        let mut pos = 0;
        while pos <= text.len() && out.len() < limit {
            let Some(m) = self.re.find_at(text, pos) else {
                break;
            };
            let (start, end) = (m.start(), m.end());
            if start == end || (self.whole_word && !Self::is_whole_word(text, start, end)) {
                // Retry one character further on: a shorter or later match
                // may still qualify.
                pos = start + text[start..].chars().next().map_or(1, char::len_utf8);
                continue;
            }
            out.push((start, end));
            pos = end;
        }
        out
    }

    /// `text` with every match replaced — `$1`/`${name}` expand in regex
    /// mode, `replacement` is taken literally otherwise. Returns the new text
    /// and the number of replacements.
    pub fn replace_all(&self, text: &str, replacement: &str, literal: bool) -> (String, usize) {
        let matches = self.find_all(text, usize::MAX);
        if matches.is_empty() {
            return (text.to_string(), 0);
        }
        let mut out = String::with_capacity(text.len());
        let mut last = 0;
        for &(start, end) in &matches {
            out.push_str(&text[last..start]);
            if literal {
                out.push_str(replacement);
            } else if let Some(caps) = self.re.captures_at(text, start) {
                caps.expand(replacement, &mut out);
            }
            last = end;
        }
        out.push_str(&text[last..]);
        (out, matches.len())
    }
}

/// A file types mask (`*.rs;*.toml`, `!*.lock`): globs without a `/` match
/// the file name, ones with a `/` the path relative to the search root.
pub struct FileMask {
    include: Option<GlobSet>,
    exclude: Option<GlobSet>,
}

impl FileMask {
    pub fn parse(mask: &str) -> Result<Self, String> {
        let mut include = GlobSetBuilder::new();
        let mut exclude = GlobSetBuilder::new();
        let (mut any_include, mut any_exclude, mut all) = (false, false, false);
        for part in mask
            .split([';', ','])
            .map(str::trim)
            .filter(|p| !p.is_empty())
        {
            let (negated, glob) = match part.strip_prefix('!') {
                Some(rest) => (true, rest.trim()),
                None => (false, part),
            };
            // `*.*` (VS's "all files") would skip extensionless files.
            if !negated && (glob == "*.*" || glob == "*") {
                all = true;
                continue;
            }
            let glob = Glob::new(&glob.replace('\\', "/"))
                .map_err(|err| format!("invalid file mask '{part}': {err}"))?;
            if negated {
                exclude.add(glob);
                any_exclude = true;
            } else {
                include.add(glob);
                any_include = true;
            }
        }
        let build = |builder: GlobSetBuilder, any: bool| -> Result<Option<GlobSet>, String> {
            if any {
                builder.build().map(Some).map_err(|err| err.to_string())
            } else {
                Ok(None)
            }
        };
        Ok(Self {
            include: build(include, any_include && !all)?,
            exclude: build(exclude, any_exclude)?,
        })
    }

    pub fn matches(&self, rel_path: &str) -> bool {
        let name = rel_path.rsplit(['/', '\\']).next().unwrap_or(rel_path);
        let rel = rel_path.replace('\\', "/");
        let hit = |set: &GlobSet| set.is_match(name) || set.is_match(&rel);
        self.include.as_ref().is_none_or(hit) && !self.exclude.as_ref().is_some_and(hit)
    }
}

/// Every searchable file under `root`, in path order: .gitignore'd files
/// (whether or not the folder is a git repository), `SKIP_DIRS` and files
/// outside `mask` are left out. Binary/oversized files are filtered later,
/// when read.
pub fn project_files(root: &Path, mask: &FileMask) -> Vec<PathBuf> {
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
    builder
        .build()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_some_and(|t| t.is_file()))
        .map(ignore::DirEntry::into_path)
        .filter(|path| mask.matches(&relative(root, path)))
        .collect()
}

/// Where `yog` generates screen code (`.yui` → `.g.rs`), under a project root.
pub const GENERATED_DIR: &str = ".yog-build/generated";

/// The generated code files under `root` (`.yog-build/generated/**/*.rs`)
/// that pass `mask`, in path order — not project files (all of `.yog-build`
/// is skipped and git-ignored), but worth searching like VS's `*.g.cs`.
pub fn generated_files(root: &Path, mask: &FileMask) -> Vec<PathBuf> {
    let dir = root.join(GENERATED_DIR);
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

fn utf16_len(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

/// One matching line, as the Find Results window shows it.
#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LineHit {
    /// 1-based.
    pub line: u32,
    /// 1-based, in UTF-16 units (what the editor counts), of the line's first match.
    pub column: u32,
    /// The line's text, leading whitespace trimmed (a window around the first match for very long lines).
    pub text: String,
    /// Match spans within `text`, UTF-16 offsets `[start, end)`.
    pub ranges: Vec<(u32, u32)>,
}

/// Groups `matches` (byte ranges into `text`) by line.
pub fn line_hits(text: &str, matches: &[(usize, usize)]) -> Vec<LineHit> {
    let mut hits: Vec<LineHit> = Vec::new();
    let mut line_no = 1u32;
    let mut line_start = 0usize;
    let mut scanned = 0usize;
    let mut i = 0;
    while i < matches.len() {
        let (start, _) = matches[i];
        // Advance to the line containing `start`.
        for (offset, _) in text[scanned..start].match_indices('\n') {
            line_no += 1;
            line_start = scanned + offset + 1;
        }
        scanned = start;
        let line_end = text[line_start..]
            .find('\n')
            .map_or(text.len(), |n| line_start + n);
        let mut line_matches = Vec::new();
        while i < matches.len()
            && matches[i].0 <= line_end
            && (matches[i].0 < line_end || line_matches.is_empty())
        {
            let (s, e) = matches[i];
            line_matches.push((s - line_start, e.min(line_end) - line_start));
            i += 1;
        }
        let raw = text[line_start..line_end].trim_end_matches('\r');
        let column = utf16_len(&raw[..line_matches[0].0.min(raw.len())]) + 1;
        hits.push(display_line(raw, &line_matches, line_no, column));
    }
    hits
}

fn floor_char(s: &str, mut i: usize) -> usize {
    i = i.min(s.len());
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn display_line(raw: &str, matches: &[(usize, usize)], line: u32, column: u32) -> LineHit {
    let indent = raw.len() - raw.trim_start().len();
    let mut start = indent.min(matches[0].0);
    let mut end = raw.len();
    let (mut prefix, mut suffix) = ("", "");
    if raw[start..].chars().count() > MAX_LINE_CHARS {
        let first = matches[0].0;
        start = floor_char(raw, first.saturating_sub(MAX_LINE_CHARS / 4).max(start));
        end = floor_char(raw, start + MAX_LINE_CHARS * 2);
        end = raw[start..end]
            .char_indices()
            .nth(MAX_LINE_CHARS)
            .map_or(end, |(n, _)| start + n);
        if start > indent {
            prefix = "…";
        }
        if end < raw.len() {
            suffix = "…";
        }
    }
    let shown = &raw[start..end];
    let base = utf16_len(prefix);
    let ranges = matches
        .iter()
        .filter(|&&(s, e)| (e > start && s < end) || (s == e && s >= start && s <= end))
        .map(|&(s, e)| {
            let s = floor_char(raw, s.clamp(start, end));
            let e = floor_char(raw, e.clamp(start, end));
            (
                base + utf16_len(&raw[start..s]),
                base + utf16_len(&raw[start..e]),
            )
        })
        .collect();
    LineHit {
        line,
        column,
        text: format!("{prefix}{shown}{suffix}"),
        ranges,
    }
}

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
enum Source<'a> {
    Buffer(&'a str),
    Disk,
}

struct Plan<'a> {
    root: Option<PathBuf>,
    items: Vec<(PathBuf, Source<'a>)>,
}

fn plan<'a>(
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

/// The id of the search allowed to keep running — a new search replaces it,
/// `find_cancel` clears it.
#[derive(Default)]
pub struct SearchState {
    current: Arc<AtomicU64>,
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

fn check_root(state: &State<AppState>, root: Option<&str>, scope: Scope) -> Result<(), String> {
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
    state: State<'_, AppState>,
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

/// Stops whatever search is running.
#[tauri::command]
pub fn find_cancel(search: State<SearchState>) {
    search.current.store(0, Ordering::SeqCst);
}

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
    state: State<'_, AppState>,
    request: ReplaceRequest,
) -> Result<ReplaceSummary, String> {
    check_root(&state, request.root.as_deref(), request.scope)?;
    let roots = state.project_roots.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_replace(&request, &|path| {
            let canonical = path.canonicalize().map_err(|err| err.to_string())?;
            if roots.iter().any(|root| canonical.starts_with(root)) {
                Ok(())
            } else {
                Err("outside any open project".to_string())
            }
        })
    })
    .await
    .map_err(|err| err.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(pattern: &str) -> SearchQuery {
        SearchQuery {
            pattern: pattern.to_string(),
            match_case: false,
            whole_word: false,
            regex: false,
            file_mask: String::new(),
            include_generated: false,
        }
    }

    fn found<'a>(q: &SearchQuery, text: &'a str) -> Vec<&'a str> {
        let m = Matcher::new(q).unwrap();
        m.find_all(text, usize::MAX)
            .into_iter()
            .map(|(s, e)| &text[s..e])
            .collect()
    }

    #[test]
    fn literal_mode_escapes_and_ignores_case() {
        assert_eq!(found(&query("a.b"), "a.b axb A.B"), ["a.b", "A.B"]);
        let q = SearchQuery {
            match_case: true,
            ..query("a.b")
        };
        assert_eq!(found(&q, "a.b A.B"), ["a.b"]);
    }

    #[test]
    fn whole_word_checks_neighbours() {
        let q = SearchQuery {
            whole_word: true,
            ..query("foo")
        };
        assert_eq!(found(&q, "foo foobar _foo foo_ (foo)").len(), 2);
        let q = SearchQuery {
            whole_word: true,
            ..query("aa")
        };
        assert_eq!(found(&q, "aaa aa"), ["aa"]);
        // Punctuation at the edge needs no word boundary.
        let q = SearchQuery {
            whole_word: true,
            ..query("->")
        };
        assert_eq!(found(&q, "a->b"), ["->"]);
    }

    #[test]
    fn regex_mode_and_errors() {
        let q = SearchQuery {
            regex: true,
            ..query(r"fn\s+(\w+)")
        };
        assert_eq!(
            found(&q, "fn main() {}\npub fn run()"),
            ["fn main", "fn run"]
        );
        let q = SearchQuery {
            regex: true,
            ..query("(")
        };
        assert!(Matcher::new(&q).is_err());
        // Empty matches are skipped rather than looping forever.
        let q = SearchQuery {
            regex: true,
            ..query("x*")
        };
        assert_eq!(found(&q, "ab x"), ["x"]);
    }

    #[test]
    fn replace_literal_and_with_captures() {
        let m = Matcher::new(&query("$a")).unwrap();
        assert_eq!(
            m.replace_all("$a + $A", "$1", true),
            ("$1 + $1".to_string(), 2)
        );
        let q = SearchQuery {
            regex: true,
            match_case: true,
            ..query(r"(\w+)\.unwrap\(\)")
        };
        let m = Matcher::new(&q).unwrap();
        assert_eq!(
            m.replace_all("x.unwrap(); y.unwrap()", "$1?", false),
            ("x?; y?".to_string(), 2)
        );
    }

    #[test]
    fn hits_group_by_line_with_utf16_columns() {
        let text = "fn a() {}\n    let é = foo + foo;\r\nfoo";
        let m = Matcher::new(&query("foo")).unwrap();
        let hits = line_hits(text, &m.find_all(text, usize::MAX));
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].line, 2);
        assert_eq!(hits[0].column, 13);
        assert_eq!(hits[0].text, "let é = foo + foo;");
        assert_eq!(hits[0].ranges, vec![(8, 11), (14, 17)]);
        assert_eq!(
            (hits[1].line, hits[1].column, hits[1].text.as_str()),
            (3, 1, "foo")
        );
    }

    #[test]
    fn long_lines_are_windowed() {
        let text = format!("{}needle{}", "x".repeat(2000), "y".repeat(2000));
        let m = Matcher::new(&query("needle")).unwrap();
        let hits = line_hits(&text, &m.find_all(&text, usize::MAX));
        let hit = &hits[0];
        assert!(hit.text.chars().count() <= MAX_LINE_CHARS + 2);
        let (s, e) = hit.ranges[0];
        let shown: Vec<u16> = hit.text.encode_utf16().collect();
        assert_eq!(
            String::from_utf16(&shown[s as usize..e as usize]).unwrap(),
            "needle"
        );
        assert_eq!(hit.column, 2001);
    }

    #[test]
    fn file_mask_globs() {
        let mask = FileMask::parse("*.rs; *.toml; !Cargo.toml").unwrap();
        assert!(mask.matches("src/lib.rs"));
        assert!(mask.matches("yog.toml"));
        assert!(!mask.matches("Cargo.toml"));
        assert!(!mask.matches("README.md"));
        assert!(FileMask::parse("").unwrap().matches("anything"));
        assert!(FileMask::parse("*.*").unwrap().matches("Makefile"));
        assert!(
            FileMask::parse("src/**/*.rs")
                .unwrap()
                .matches("src/a/b.rs")
        );
    }

    fn temp_project(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("yog-idle-search-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for (path, contents) in [
            ("src/lib.rs", "pub fn needle() {}\n"),
            ("src/other.rs", "// no match\n"),
            ("target/debug/out.rs", "needle\n"),
            ("node_modules/x.js", "needle\n"),
            ("ignored/skip.rs", "needle\n"),
            ("notes.md", "a needle here\n"),
            (".gitignore", "ignored/\n"),
        ] {
            let full = dir.join(path);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, contents).unwrap();
        }
        std::fs::write(dir.join("blob.bin"), b"needle\0\0\0").unwrap();
        dir
    }

    #[test]
    fn generated_code_is_searched_only_when_asked() {
        let dir = temp_project("generated");
        let generated = dir.join(".yog-build/generated/screens/menu.g.rs");
        std::fs::create_dir_all(generated.parent().unwrap()).unwrap();
        std::fs::write(&generated, "pub const NEEDLE: &str = \"needle\";\n").unwrap();
        std::fs::write(dir.join(".yog-build/Cargo.toml"), "needle\n").unwrap();
        let root = dir.to_string_lossy().into_owned();
        let search = |include_generated: bool| {
            let mut files = Vec::new();
            let q = SearchQuery {
                include_generated,
                ..query("needle")
            };
            run_search(
                Some(&root),
                Scope::Project,
                &q,
                &[],
                100,
                &|| true,
                &mut |f| files.push(f.rel_path),
            )
            .unwrap();
            files
        };
        assert_eq!(search(false), ["notes.md", "src/lib.rs"]);
        assert_eq!(
            search(true),
            [
                "notes.md",
                "src/lib.rs",
                ".yog-build/generated/screens/menu.g.rs"
            ]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn project_search_skips_ignored_build_and_binary_files() {
        let dir = temp_project("walk");
        let root = dir.to_string_lossy().into_owned();
        let mut files = Vec::new();
        let summary = run_search(
            Some(&root),
            Scope::Project,
            &query("needle"),
            &[],
            100,
            &|| true,
            &mut |f| files.push(f.rel_path),
        )
        .unwrap();
        assert_eq!(files, ["notes.md", "src/lib.rs"]);
        assert_eq!(summary.matching_files, 2);
        assert_eq!(summary.matching_lines, 2);
        assert_eq!(summary.files_searched, 4); // .gitignore, notes.md, lib.rs, other.rs

        // An open buffer stands in for its file.
        let docs = [OpenDocument {
            path: dir.join("src/other.rs").to_string_lossy().into_owned(),
            text: "needle needle\nneedle".to_string(),
        }];
        let q = SearchQuery {
            file_mask: "*.rs".to_string(),
            ..query("needle")
        };
        let mut files = Vec::new();
        let summary = run_search(
            Some(&root),
            Scope::Project,
            &q,
            &docs,
            100,
            &|| true,
            &mut |f| files.push((f.rel_path, f.hits.len())),
        )
        .unwrap();
        assert_eq!(
            files,
            [
                ("src/lib.rs".to_string(), 1),
                ("src/other.rs".to_string(), 2)
            ]
        );
        assert_eq!(summary.matching_lines, 3);

        // The cap stops the search.
        let summary = run_search(
            Some(&root),
            Scope::Project,
            &q,
            &docs,
            2,
            &|| true,
            &mut |_| {},
        )
        .unwrap();
        assert!(summary.truncated);
        assert_eq!(summary.matching_lines, 2);
        let summary = run_search(
            Some(&root),
            Scope::Project,
            &q,
            &docs,
            2,
            &|| false,
            &mut |_| {},
        )
        .unwrap();
        assert!(summary.cancelled);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn replace_writes_files_and_returns_buffers() {
        let dir = temp_project("replace");
        let doc_path = dir.join("notes.md").to_string_lossy().into_owned();
        let request = ReplaceRequest {
            root: Some(dir.to_string_lossy().into_owned()),
            scope: Scope::Project,
            query: SearchQuery {
                whole_word: true,
                ..query("needle")
            },
            replacement: "pin".to_string(),
            documents: vec![OpenDocument {
                path: doc_path.clone(),
                text: "needle, needles".to_string(),
            }],
        };
        let summary = run_replace(&request, &|_| Ok(())).unwrap();
        assert_eq!(summary.total, 2);
        assert_eq!(summary.documents.len(), 1);
        assert_eq!(summary.documents[0].text, "pin, needles");
        assert_eq!(
            std::fs::read_to_string(dir.join("notes.md")).unwrap(),
            "a needle here\n",
            "open documents aren't written"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("src/lib.rs")).unwrap(),
            "pub fn pin() {}\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("ignored/skip.rs")).unwrap(),
            "needle\n"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
