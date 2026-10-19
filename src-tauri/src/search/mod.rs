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

use crate::Workspace;

mod files;
pub use files::*;
mod hits;
pub use hits::*;
mod run;
pub use run::*;
mod commands;
pub use commands::*;
mod replace;
pub use replace::*;
#[cfg(test)]
mod tests;

/// Directories never searched, ignored or not: build output, dependencies,
/// VCS metadata, Yog's generated crates and Yog-IDLE's own per-project data.
const SKIP_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "target",
    "node_modules",
    crate::manifest::BUILD_DIR,
    crate::manifest::IDLE_DIR,
];

/// Files larger than this are assumed not to be source and skipped.
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
/// A NUL byte this early in a file marks it as binary.
const BINARY_SNIFF_BYTES: usize = 8000;
/// A result line longer than this is shown as a window around its first match.
const MAX_LINE_CHARS: usize = 400;
/// Default cap on matching lines per search.
pub(crate) const DEFAULT_MAX_LINES: usize = 20_000;

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
    /// Every file.
    pub fn all() -> Self {
        Self { include: None, exclude: None }
    }

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
