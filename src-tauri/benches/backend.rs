//! The backend's hot paths on synthetic input: Code Search (index + fuzzy
//! ranking), symbol extraction, Find in Files, and Git Changes' status parse — each including the JSON the frontend gets.

use std::hint::black_box;
use std::path::{Path, PathBuf};

use criterion::{Criterion, criterion_group, criterion_main};
use yog_idle_tauri_lib::bench::{
    self, CodeIndex, OpenDocument, extract_symbols, fuzzy_match,
};

const WORDS: &[&str] = &[
    "project", "window", "state", "find", "files", "search", "index", "symbol", "render", "layout",
    "screen", "button", "label", "texture", "model", "block", "item", "debug", "session",
    "control", "socket", "reload", "status", "branch", "commit", "stash",
];

fn word(i: usize) -> &'static str {
    WORDS[i % WORDS.len()]
}

fn camel(i: usize) -> String {
    [word(i), word(i / 3 + 1), word(i / 7 + 2)]
        .iter()
        .map(|w| w[..1].to_uppercase() + &w[1..])
        .collect()
}

fn snake(i: usize) -> String {
    format!("{}_{}_{}", word(i), word(i / 5 + 3), word(i / 11 + 4))
}

/// A module of `n` types, each with fields, an impl and free functions.
fn rust_source(seed: usize, n: usize) -> String {
    let mut out = String::from("//! Generated.\n\nuse std::collections::HashMap;\n\n");
    for t in 0..n {
        let i = seed * 31 + t;
        let ty = camel(i);
        out += &format!(
            "/// {ty}.\n#[derive(Debug, Clone)]\npub struct {ty}{t} {{\n    pub {}: u32,\n    {}: String,\n    cache: HashMap<String, Vec<u8>>,\n}}\n\n",
            snake(i),
            snake(i + 1)
        );
        out += &format!(
            "impl {ty}{t} {{\n    pub const LIMIT: usize = {t};\n\n    pub fn {}(&self, value: u32) -> u32 {{\n        let doubled = value * 2;\n        doubled + self.{}\n    }}\n\n    fn {}(&mut self) {{\n        self.cache.clear();\n    }}\n}}\n\n",
            snake(i + 2),
            snake(i),
            snake(i + 3)
        );
        out += &format!(
            "pub enum {}Kind{t} {{ First, Second(u8), Third {{ at: usize }} }}\n\npub fn {}_{t}(input: &str) -> Option<usize> {{\n    input.find(\"needle\").map(|at| at + 1)\n}}\n\n",
            camel(i + 5),
            snake(i + 4)
        );
    }
    out
}

fn project(files: usize, types_per_file: usize) -> Vec<(PathBuf, String, String)> {
    (0..files)
        .map(|f| {
            let rel = format!("src/{}/{}_{f}.rs", word(f / 9), snake(f));
            (
                Path::new("/bench").join(&rel),
                rel,
                rust_source(f, types_per_file),
            )
        })
        .collect()
}

fn code_search(c: &mut Criterion) {
    let files = project(300, 12);
    let names: Vec<String> = (0..20_000)
        .map(|i| if i % 2 == 0 { camel(i) } else { snake(i) })
        .collect();
    c.bench_function("fuzzy_match/20k_names", |b| {
        b.iter(|| {
            let mut hits = 0;
            for name in &names {
                hits += fuzzy_match(black_box("prwist"), name).is_some() as usize;
            }
            hits
        })
    });
    c.bench_function("extract_symbols/300_files", |b| {
        b.iter(|| {
            files
                .iter()
                .map(|(_, _, text)| extract_symbols(black_box(text)).len())
                .sum::<usize>()
        })
    });
    let index = CodeIndex::new(&files);
    c.bench_function("code_search/broad", |b| {
        b.iter(|| index.search(black_box("st"), 200))
    });
    c.bench_function("code_search/narrow", |b| {
        b.iter(|| index.search(black_box("ProjWinSt"), 200))
    });
}

fn find_in_files(c: &mut Criterion) {
    let documents: Vec<OpenDocument> = project(200, 12)
        .into_iter()
        .map(|(path, _, text)| OpenDocument {
            path: path.to_string_lossy().into_owned(),
            text,
        })
        .collect();
    c.bench_function("find_in_documents/200_files", |b| {
        b.iter(|| bench::find_in_documents(&documents, black_box("self.")))
    });
}

fn git_status(c: &mut Criterion) {
    let mut raw = String::from(
        "# branch.oid 0123456789abcdef0123456789abcdef01234567\0# branch.head master\0# branch.upstream origin/master\0# branch.ab +2 -1\0# stash 3\0",
    );
    for i in 0..5_000 {
        let path = format!("src/{}/{}_{i}.rs", word(i / 13), snake(i));
        match i % 4 {
            0 => raw += &format!("1 .M N... 100644 100644 100644 aaaa bbbb {path}\0"),
            1 => raw += &format!("1 M. N... 100644 100644 100644 aaaa bbbb {path}\0"),
            2 => {
                raw +=
                    &format!("2 R. N... 100644 100644 100644 aaaa bbbb R100 {path}\0old/{path}\0")
            }
            _ => raw += &format!("? {path}\0"),
        }
    }
    let top = Path::new("/home/user/project");
    c.bench_function("git_status/5k_changes", |b| {
        b.iter(|| bench::git_status(top, black_box(&raw)))
    });
}

criterion_group!(benches, code_search, find_in_files, git_status);
criterion_main!(benches);
