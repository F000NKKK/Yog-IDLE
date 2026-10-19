//! Symbols out of Rust source: a syn walk of the items, a regex fallback for what doesn't parse.

use super::*;

pub(super) struct Collector<'a> {
    pub(super) lines: &'a [&'a str],
    /// Enclosing modules and types, outermost first.
    pub(super) containers: Vec<Container>,
    pub(super) symbols: Vec<Symbol>,
}

pub(super) enum Container {
    Module(String),
    Type(String),
}

impl Collector<'_> {
    pub(super) fn container(&self) -> Option<String> {
        if let Some(Container::Type(name)) = self
            .containers
            .iter()
            .rev()
            .find(|c| matches!(c, Container::Type(_)))
        {
            return Some(name.clone());
        }
        let modules: Vec<&str> = self
            .containers
            .iter()
            .filter_map(|c| match c {
                Container::Module(name) => Some(name.as_str()),
                Container::Type(_) => None,
            })
            .collect();
        (!modules.is_empty()).then(|| modules.join("::"))
    }

    pub(super) fn push(&mut self, ident: &syn::Ident, kind: SymbolKind) {
        let start = ident.span().start();
        let line_text = self
            .lines
            .get(start.line.saturating_sub(1))
            .copied()
            .unwrap_or("");
        let column = line_text
            .chars()
            .take(start.column)
            .map(char::len_utf16)
            .sum::<usize>()
            + 1;
        let name = ident.to_string();
        self.symbols.push(Symbol {
            name: name.strip_prefix("r#").map(str::to_string).unwrap_or(name),
            kind,
            container: self.container(),
            line: start.line as u32,
            column: column as u32,
        });
    }

    pub(super) fn within(&mut self, container: Container, f: impl FnOnce(&mut Self)) {
        self.containers.push(container);
        f(self);
        self.containers.pop();
    }
}

/// `Foo` for `Foo<T>`, `&mut Foo`, `crate::a::Foo` — the name an impl block is listed under.
pub(super) fn type_name(ty: &syn::Type) -> String {
    match ty {
        syn::Type::Path(path) => path
            .path
            .segments
            .last()
            .map_or_else(|| "?".to_string(), |s| s.ident.to_string()),
        syn::Type::Reference(reference) => type_name(&reference.elem),
        syn::Type::Paren(paren) => type_name(&paren.elem),
        syn::Type::Group(group) => type_name(&group.elem),
        syn::Type::Slice(slice) => format!("[{}]", type_name(&slice.elem)),
        syn::Type::Array(array) => format!("[{}]", type_name(&array.elem)),
        syn::Type::Ptr(ptr) => type_name(&ptr.elem),
        syn::Type::Tuple(_) => "()".to_string(),
        _ => "impl".to_string(),
    }
}

impl<'ast> Visit<'ast> for Collector<'_> {
    fn visit_item_mod(&mut self, node: &'ast syn::ItemMod) {
        self.push(&node.ident, SymbolKind::Module);
        self.within(Container::Module(node.ident.to_string()), |v| {
            visit::visit_item_mod(v, node)
        });
    }

    fn visit_item_struct(&mut self, node: &'ast syn::ItemStruct) {
        self.push(&node.ident, SymbolKind::Struct);
        self.within(Container::Type(node.ident.to_string()), |v| {
            visit::visit_item_struct(v, node)
        });
    }

    fn visit_item_union(&mut self, node: &'ast syn::ItemUnion) {
        self.push(&node.ident, SymbolKind::Union);
        self.within(Container::Type(node.ident.to_string()), |v| {
            visit::visit_item_union(v, node)
        });
    }

    fn visit_item_enum(&mut self, node: &'ast syn::ItemEnum) {
        self.push(&node.ident, SymbolKind::Enum);
        self.within(Container::Type(node.ident.to_string()), |v| {
            visit::visit_item_enum(v, node)
        });
    }

    fn visit_variant(&mut self, node: &'ast syn::Variant) {
        self.push(&node.ident, SymbolKind::Variant);
        let outer = self.container().unwrap_or_default();
        self.within(Container::Type(format!("{outer}::{}", node.ident)), |v| {
            visit::visit_variant(v, node)
        });
    }

    fn visit_field(&mut self, node: &'ast syn::Field) {
        if let Some(ident) = &node.ident {
            self.push(ident, SymbolKind::Field);
        }
        visit::visit_field(self, node);
    }

    fn visit_item_trait(&mut self, node: &'ast syn::ItemTrait) {
        self.push(&node.ident, SymbolKind::Trait);
        self.within(Container::Type(node.ident.to_string()), |v| {
            visit::visit_item_trait(v, node)
        });
    }

    fn visit_item_type(&mut self, node: &'ast syn::ItemType) {
        self.push(&node.ident, SymbolKind::TypeAlias);
        visit::visit_item_type(self, node);
    }

    fn visit_item_fn(&mut self, node: &'ast syn::ItemFn) {
        self.push(&node.sig.ident, SymbolKind::Function);
        visit::visit_item_fn(self, node);
    }

    fn visit_item_const(&mut self, node: &'ast syn::ItemConst) {
        self.push(&node.ident, SymbolKind::Const);
        visit::visit_item_const(self, node);
    }

    fn visit_item_static(&mut self, node: &'ast syn::ItemStatic) {
        self.push(&node.ident, SymbolKind::Static);
        visit::visit_item_static(self, node);
    }

    fn visit_item_macro(&mut self, node: &'ast syn::ItemMacro) {
        if let Some(ident) = &node.ident {
            self.push(ident, SymbolKind::Macro);
        }
        visit::visit_item_macro(self, node);
    }

    fn visit_item_impl(&mut self, node: &'ast syn::ItemImpl) {
        let self_ty = type_name(&node.self_ty);
        let name = match &node.trait_ {
            Some((path, _)) => match path.segments.last() {
                Some(segment) => format!("{} for {self_ty}", segment.ident),
                None => self_ty,
            },
            None => self_ty,
        };
        self.within(Container::Type(name), |v| visit::visit_item_impl(v, node));
    }

    fn visit_impl_item_fn(&mut self, node: &'ast syn::ImplItemFn) {
        self.push(&node.sig.ident, SymbolKind::Method);
        visit::visit_impl_item_fn(self, node);
    }

    fn visit_impl_item_const(&mut self, node: &'ast syn::ImplItemConst) {
        self.push(&node.ident, SymbolKind::Const);
        visit::visit_impl_item_const(self, node);
    }

    fn visit_impl_item_type(&mut self, node: &'ast syn::ImplItemType) {
        self.push(&node.ident, SymbolKind::AssociatedType);
        visit::visit_impl_item_type(self, node);
    }

    fn visit_trait_item_fn(&mut self, node: &'ast syn::TraitItemFn) {
        self.push(&node.sig.ident, SymbolKind::Method);
        visit::visit_trait_item_fn(self, node);
    }

    fn visit_trait_item_const(&mut self, node: &'ast syn::TraitItemConst) {
        self.push(&node.ident, SymbolKind::Const);
        visit::visit_trait_item_const(self, node);
    }

    fn visit_trait_item_type(&mut self, node: &'ast syn::TraitItemType) {
        self.push(&node.ident, SymbolKind::AssociatedType);
        visit::visit_trait_item_type(self, node);
    }
}

/// The item a line declares (`syn` couldn't parse the file) — `None` only if
/// the pattern itself were wrong, which the tests rule out.
pub(super) static ITEM_RE: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(
        r#"^\s*(?:pub(?:\s*\([^)]*\))?\s+)?(?:(?:default|const|async|unsafe|safe)\s+|extern\s+(?:"[^"]*"\s+)?)*(fn|struct|enum|trait|type|union|mod|const|static(?:\s+mut)?|macro_rules!)\s*([A-Za-z_][A-Za-z0-9_]*)"#,
    )
    .ok()
});
/// The type (and trait) an `impl` line is for.
pub(super) static IMPL_RE: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(r"^\s*(?:unsafe\s+)?impl\b(?:\s*<[^{]*?>)?\s+(?:([A-Za-z_][\w:]*)(?:<[^{]*>)?\s+for\s+)?&?(?:mut\s+)?(?:[\w]+::)*([A-Za-z_]\w*)").ok()
});

/// Best-effort extraction for a file `syn` can't parse: items declared at
/// the start of a line, with `impl` blocks tracked by indentation so methods
/// get their type as container.
pub fn extract_with_regex(source: &str) -> Vec<Symbol> {
    let mut symbols = Vec::new();
    let (Some(item_re), Some(impl_re)) = (ITEM_RE.as_ref(), IMPL_RE.as_ref()) else {
        return symbols;
    };
    let mut impl_block: Option<(usize, String)> = None;
    for (index, line) in source.lines().enumerate() {
        let indent = line.len() - line.trim_start().len();
        if let Some((impl_indent, _)) = &impl_block
            && indent <= *impl_indent
            && !line.trim().is_empty()
            && !line.trim_start().starts_with('}')
        {
            impl_block = None;
        }
        if let Some(caps) = impl_re.captures(line) {
            let ty = caps[2].to_string();
            let name = match caps.get(1) {
                Some(tr) => format!(
                    "{} for {ty}",
                    tr.as_str().rsplit("::").next().unwrap_or(tr.as_str())
                ),
                None => ty,
            };
            impl_block = Some((indent, name));
            continue;
        }
        let Some(caps) = item_re.captures(line) else {
            continue;
        };
        let (keyword, Some(ident)) = (&caps[1], caps.get(2)) else {
            continue;
        };
        let in_impl = impl_block
            .as_ref()
            .filter(|(i, _)| indent > *i)
            .map(|(_, name)| name.clone());
        let kind = match keyword {
            "fn" if in_impl.is_some() => SymbolKind::Method,
            "fn" => SymbolKind::Function,
            "struct" => SymbolKind::Struct,
            "enum" => SymbolKind::Enum,
            "trait" => SymbolKind::Trait,
            "type" if in_impl.is_some() => SymbolKind::AssociatedType,
            "type" => SymbolKind::TypeAlias,
            "union" => SymbolKind::Union,
            "mod" => SymbolKind::Module,
            "const" => SymbolKind::Const,
            "macro_rules!" => SymbolKind::Macro,
            _ => SymbolKind::Static,
        };
        symbols.push(Symbol {
            name: ident.as_str().to_string(),
            kind,
            container: in_impl,
            line: index as u32 + 1,
            column: line[..ident.start()].encode_utf16().count() as u32 + 1,
        });
    }
    symbols
}

// -- Fuzzy matching ------------------------------------------------------------
