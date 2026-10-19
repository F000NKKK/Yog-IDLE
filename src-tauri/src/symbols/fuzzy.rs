//! Fuzzy matching of a query against a name: score and matched positions (UTF-16, for the UI).

/// How well `query` fuzzy-matches `candidate` (higher is better), and which
/// of `candidate`'s chars matched — a subsequence match, case-insensitive,
/// rewarding consecutive runs and matches at word starts (`_`, `/`, `::`,
/// camelCase humps), so `fif` finds `find_in_files` and `OFC` `OpenFilesContext`.
pub fn fuzzy_match(query: &str, candidate: &str) -> Option<(i32, Vec<usize>)> {
    let q: Vec<char> = query.chars().filter(|c| !c.is_whitespace()).collect();
    let c: Vec<char> = candidate.chars().collect();
    if q.is_empty() {
        return Some((0, Vec::new()));
    }
    if q.len() > c.len() {
        return None;
    }
    let lower = |ch: char| ch.to_lowercase().next().unwrap_or(ch);
    let ql: Vec<char> = q.iter().copied().map(lower).collect();
    let cl: Vec<char> = c.iter().copied().map(lower).collect();

    // Quick reject: not a subsequence at all.
    let mut k = 0;
    for &ch in &cl {
        if k < ql.len() && ch == ql[k] {
            k += 1;
        }
    }
    if k < ql.len() {
        return None;
    }

    const MATCH: i32 = 16;
    const BOUNDARY: i32 = 24;
    const FIRST_CHAR: i32 = 32;
    const CONSECUTIVE: i32 = 20;
    const GAP: i32 = 2;
    const CASE: i32 = 2;
    const NONE: i32 = i32::MIN / 2;

    let bonus: Vec<i32> = (0..c.len())
        .map(|j| {
            if j == 0 {
                return FIRST_CHAR;
            }
            let prev = c[j - 1];
            let cur = c[j];
            if !prev.is_alphanumeric()
                || (prev.is_lowercase() && cur.is_uppercase())
                || (!prev.is_ascii_digit() && cur.is_ascii_digit())
            {
                BOUNDARY
            } else {
                0
            }
        })
        .collect();

    let (n, m) = (q.len(), c.len());
    // score[i][j]: best score with q[..=i] matched and q[i] at c[j]; from[i][j]: where q[i-1] was.
    let mut score = vec![vec![NONE; m]; n];
    let mut from = vec![vec![usize::MAX; m]; n];
    for i in 0..n {
        // Best of row i-1 over k < j - 1, decayed by the gap to j.
        let mut run = NONE;
        let mut run_at = usize::MAX;
        for j in i..m {
            if i > 0 && j >= 2 {
                let candidate = score[i - 1][j - 2];
                if candidate > NONE && candidate - GAP >= run {
                    run = candidate - GAP;
                    run_at = j - 2;
                } else if run > NONE {
                    run -= GAP;
                }
            }
            if cl[j] != ql[i] {
                continue;
            }
            let here = MATCH + bonus[j] + if c[j] == q[i] { CASE } else { 0 };
            if i == 0 {
                // Matches further in are penalised a little.
                score[0][j] = here - (j as i32).min(20);
                continue;
            }
            let adjacent = if j >= 1 && score[i - 1][j - 1] > NONE {
                score[i - 1][j - 1] + CONSECUTIVE
            } else {
                NONE
            };
            if adjacent >= run && adjacent > NONE {
                score[i][j] = adjacent + here;
                from[i][j] = j - 1;
            } else if run > NONE {
                score[i][j] = run - GAP + here;
                from[i][j] = run_at;
            }
        }
    }
    let (mut j, best) = score[n - 1]
        .iter()
        .enumerate()
        .filter(|(_, s)| **s > NONE)
        .max_by_key(|(j, s)| (**s, std::cmp::Reverse(*j)))
        .map(|(j, s)| (j, *s))?;
    let mut positions = vec![0; n];
    for i in (0..n).rev() {
        positions[i] = j;
        j = from[i][j];
    }
    // Shorter candidates rank first among equal matches.
    let total = best - (m as i32 - n as i32).min(40) / 2 + if m == n { 40 } else { 0 };
    Some((total, positions))
}

/// `positions` (char indices into `text`) as UTF-16 offsets.
pub(super) fn utf16_positions(text: &str, positions: &[usize]) -> Vec<u32> {
    if text.is_ascii() {
        return positions.iter().map(|&p| p as u32).collect();
    }
    let offsets: Vec<u32> = text
        .chars()
        .scan(0u32, |acc, ch| {
            let at = *acc;
            *acc += ch.len_utf16() as u32;
            Some(at)
        })
        .collect();
    positions
        .iter()
        .filter_map(|&p| offsets.get(p).copied())
        .collect()
}

// -- Index ---------------------------------------------------------------------
