//! Code Search (Ctrl+T) — Visual Studio's all-in-one search, backend half:
//! fuzzy matching over the project's files and over a symbol index of its
//! Rust sources (types: structs, enums, traits, type aliases, unions;
//! members: functions, methods, fields, variants, consts, statics, macros,
//! modules), plus the text mode, which is Find in Files capped to a few hits.
//!
//! Symbols come from `syn`; a file it can't parse (mid-edit, or using syntax
//! newer than it knows) falls back to a line-based regex extractor. The
//! index lives per project root and is refreshed lazily — every file's mtime
//! is checked again when the popup opens (`refresh`), so a saved file is
//! re-read the next time it's searched.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::SystemTime;

use regex::Regex;
use serde::{Deserialize, Serialize};
use syn::visit::{self, Visit};
use tauri::State;

use crate::Workspace;
use substrate_platform::search::{self, FileMask, OpenDocument, Scope, Search, SearchQuery};
use substrate_platform::text_view::TextViews;

mod extract;
pub use extract::*;
mod fuzzy;
pub use fuzzy::*;
mod index;
pub(crate) use index::*;
mod code_search;
pub use code_search::*;
#[cfg(test)]
mod tests;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SymbolKind {
    Struct,
    Enum,
    Trait,
    TypeAlias,
    Union,
    Function,
    Method,
    Field,
    Variant,
    Const,
    Static,
    Macro,
    Module,
    AssociatedType,
}

impl SymbolKind {
    /// As serialized (`camelCase`) — Code Search's `kind`.
    pub fn name(self) -> &'static str {
        match self {
            Self::Struct => "struct",
            Self::Enum => "enum",
            Self::Trait => "trait",
            Self::TypeAlias => "typeAlias",
            Self::Union => "union",
            Self::Function => "function",
            Self::Method => "method",
            Self::Field => "field",
            Self::Variant => "variant",
            Self::Const => "const",
            Self::Static => "static",
            Self::Macro => "macro",
            Self::Module => "module",
            Self::AssociatedType => "associatedType",
        }
    }

    /// Types (`t:`) — everything else is a member (`m:`).
    pub fn is_type(self) -> bool {
        matches!(
            self,
            Self::Struct | Self::Enum | Self::Trait | Self::TypeAlias | Self::Union
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Symbol {
    pub name: String,
    pub kind: SymbolKind,
    /// The enclosing type/trait (`Foo`, `Display for Foo`) or module path — `None` at a file's top level.
    pub container: Option<String>,
    /// 1-based.
    pub line: u32,
    /// 1-based, UTF-16 units.
    pub column: u32,
}

/// Every symbol `source` defines, in source order.
pub fn extract_symbols(source: &str) -> Vec<Symbol> {
    let lines: Vec<&str> = source.lines().collect();
    let parsed = syn::parse_file(source).ok().map(|file| {
        let mut collector = Collector {
            lines: &lines,
            containers: Vec::new(),
            symbols: Vec::new(),
        };
        collector.visit_file(&file);
        collector.symbols
    });
    // Spans of a parse are kept in a thread-local source map until dropped
    // this way — the file and every span are gone by now.
    proc_macro2::extra::invalidate_current_thread_spans();
    parsed.unwrap_or_else(|| extract_with_regex(source))
}
