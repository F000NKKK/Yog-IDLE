//! Symbol extraction, fuzzy matching and Code Search's tests.

use super::*;

#[test]
fn kind_names_match_serde() {
    use SymbolKind::*;
    for kind in [
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
    ] {
        assert_eq!(serde_json::to_value(kind).unwrap(), kind.name());
    }
}

const SAMPLE: &str = r#"
pub mod net {
    pub struct Client {
        pub url: String,
        r#type: u8,
    }

    impl Client {
        pub const MAX: usize = 4;
        pub fn connect(&self) {}
    }

    impl std::fmt::Display for Client {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { Ok(()) }
    }
}

enum Shape { Circle { radius: f32 }, Square(f32) }
trait Draw { type Out; fn draw(&self); }
type Alias = u32;
union Bits { i: u32, f: f32 }
static mut COUNT: u32 = 0;
macro_rules! shout { () => {} }
fn main() { let é = 1; fn inner() {} }
"#;

fn find<'a>(symbols: &'a [Symbol], name: &str) -> &'a Symbol {
    symbols
        .iter()
        .find(|s| s.name == name)
        .unwrap_or_else(|| panic!("{name} not found in {symbols:#?}"))
}

#[test]
fn syn_extracts_types_and_members_with_containers() {
    let symbols = extract_symbols(SAMPLE);
    let check = |name: &str, kind: SymbolKind, container: Option<&str>| {
        let s = find(&symbols, name);
        assert_eq!(
            (s.kind, s.container.as_deref()),
            (kind, container),
            "{name}"
        );
    };
    check("net", SymbolKind::Module, None);
    check("Client", SymbolKind::Struct, Some("net"));
    check("url", SymbolKind::Field, Some("Client"));
    check("type", SymbolKind::Field, Some("Client"));
    check("MAX", SymbolKind::Const, Some("Client"));
    check("connect", SymbolKind::Method, Some("Client"));
    check("fmt", SymbolKind::Method, Some("Display for Client"));
    check("Shape", SymbolKind::Enum, None);
    check("Circle", SymbolKind::Variant, Some("Shape"));
    check("radius", SymbolKind::Field, Some("Shape::Circle"));
    check("Draw", SymbolKind::Trait, None);
    check("Out", SymbolKind::AssociatedType, Some("Draw"));
    check("draw", SymbolKind::Method, Some("Draw"));
    check("Alias", SymbolKind::TypeAlias, None);
    check("Bits", SymbolKind::Union, None);
    check("COUNT", SymbolKind::Static, None);
    check("shout", SymbolKind::Macro, None);
    check("main", SymbolKind::Function, None);
    check("inner", SymbolKind::Function, None);
    let connect = find(&symbols, "connect");
    assert_eq!((connect.line, connect.column), (10, 16));
}

#[test]
fn columns_count_utf16_units() {
    let symbols = extract_symbols("const É: u8 = 0; fn 𝔣() {}\n");
    // `𝔣` (non-ASCII identifier) sits after `É`, a 1-unit char, and is 2 units itself.
    let f = find(&symbols, "𝔣");
    assert_eq!((f.line, f.column), (1, 21));
}

#[test]
fn unparsable_files_fall_back_to_regex() {
    let source = "pub struct Broken {\n    x: u8,\n\nimpl Broken {\n    pub async fn go(&self) {\n}\nimpl Show for Broken {\n    fn show() {}\n}\npub(crate) const fn helper() {}\nmacro_rules! m {}\n";
    assert!(syn::parse_file(source).is_err());
    let symbols = extract_symbols(source);
    assert_eq!(find(&symbols, "Broken").kind, SymbolKind::Struct);
    let go = find(&symbols, "go");
    assert_eq!(
        (go.kind, go.container.as_deref(), go.line, go.column),
        (SymbolKind::Method, Some("Broken"), 5, 18)
    );
    assert_eq!(
        find(&symbols, "show").container.as_deref(),
        Some("Show for Broken")
    );
    let helper = find(&symbols, "helper");
    assert_eq!(
        (helper.kind, helper.container.as_deref()),
        (SymbolKind::Function, None)
    );
    assert_eq!(find(&symbols, "m").kind, SymbolKind::Macro);
}

#[test]
fn fuzzy_prefers_word_starts_and_runs() {
    assert!(fuzzy_match("xyz", "find_in_files").is_none());
    let (_, pos) = fuzzy_match("fif", "find_in_files").unwrap();
    assert_eq!(pos, vec![0, 5, 8]);
    let (_, pos) = fuzzy_match("OFC", "OpenFilesContext").unwrap();
    assert_eq!(pos, vec![0, 4, 9]);
    let exact = fuzzy_match("client", "Client").unwrap().0;
    let prefix = fuzzy_match("client", "ClientBuilder").unwrap().0;
    let scattered = fuzzy_match("client", "CodeLineIterEntNumTotal").unwrap().0;
    assert!(
        exact > prefix && prefix > scattered,
        "{exact} {prefix} {scattered}"
    );
    let (_, pos) = fuzzy_match("conn", "reconnect").unwrap();
    assert_eq!(pos, vec![2, 3, 4, 5]);
}

fn names(index: &RootIndex, mode: CodeSearchMode, query: &str) -> Vec<(&'static str, String)> {
    search_index(index, query, mode, 10)
        .into_iter()
        .map(|i| (i.kind, i.name))
        .collect()
}

#[test]
fn index_ranks_files_and_symbols() {
    let dir = std::env::temp_dir().join(format!("yog-idle-symbols-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::write(
        dir.join("src/client.rs"),
        "pub struct Client;\nimpl Client { pub fn connect(&self) {} }\n",
    )
    .unwrap();
    std::fs::write(dir.join("README.md"), "# readme\n").unwrap();
    let mut index = RootIndex::default();
    index.refresh(&dir, &TextViews::default());
    assert_eq!(
        names(&index, CodeSearchMode::Types, "cli"),
        [("struct", "Client".to_string())]
    );
    assert_eq!(
        names(&index, CodeSearchMode::Members, "conn"),
        [("method", "connect".to_string())]
    );
    assert_eq!(
        names(&index, CodeSearchMode::Files, "read"),
        [("file", "README.md".to_string())]
    );
    let all = names(&index, CodeSearchMode::All, "client");
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].1, "Client");

    // An edited file is re-read on refresh.
    std::thread::sleep(std::time::Duration::from_millis(20));
    std::fs::write(dir.join("src/client.rs"), "pub enum Server {}\n").unwrap();
    let later = SystemTime::now() + std::time::Duration::from_secs(5);
    std::fs::File::options()
        .write(true)
        .open(dir.join("src/client.rs"))
        .unwrap()
        .set_modified(later)
        .unwrap();
    index.refresh(&dir, &TextViews::default());
    assert_eq!(
        names(&index, CodeSearchMode::Types, "srv"),
        [("enum", "Server".to_string())]
    );
    assert!(names(&index, CodeSearchMode::Types, "cli").is_empty());

    let views = TextViews::default();
    let items = text_items(&dir.to_string_lossy(), "fn connect", Vec::new(), 10, &views).unwrap();
    assert!(items.is_empty());
    let items = text_items(&dir.to_string_lossy(), "enum", Vec::new(), 10, &views).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].line, Some(1));
    std::fs::remove_dir_all(dir).unwrap();
}
