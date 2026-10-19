//! Find and Replace in Files' tests.

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
fn project_entries_and_content_matches_skip_what_search_skips() {
    let dir = temp_project("entries");
    let rel = |path: &str| relative(&dir, Path::new(path));
    let entries: Vec<_> = project_entries(&dir)
        .into_iter()
        .map(|e| (rel(&e.path), e.kind))
        .collect();
    assert_eq!(
        entries,
        [
            (".gitignore".to_string(), "file"),
            ("blob.bin".to_string(), "file"),
            ("notes.md".to_string(), "file"),
            ("src".to_string(), "dir"),
            ("src/lib.rs".to_string(), "file"),
            ("src/other.rs".to_string(), "file"),
        ]
    );
    let containing: Vec<_> = files_containing(&dir, &query("needle"), 10)
        .unwrap()
        .iter()
        .map(|p| rel(p))
        .collect();
    assert_eq!(containing, ["notes.md", "src/lib.rs"]);
    assert_eq!(files_containing(&dir, &query("needle"), 1).unwrap().len(), 1);
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
