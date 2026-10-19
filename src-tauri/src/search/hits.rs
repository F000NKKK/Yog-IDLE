//! Matches as the Find Results show them: line, column and a trimmed preview with the hits marked.

use super::*;

pub(super) fn utf16_len(s: &str) -> u32 {
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

pub(super) fn floor_char(s: &str, mut i: usize) -> usize {
    i = i.min(s.len());
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

pub(super) fn display_line(raw: &str, matches: &[(usize, usize)], line: u32, column: u32) -> LineHit {
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
