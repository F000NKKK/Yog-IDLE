//! A mod's `.yui` that books and recipes use — its kinds of book page
//! (`book_page`) and its recipe layouts (`recipe_layout`) — read with
//! yog-book's own reader and compiler, as `yog build` reads them.

use std::path::{Path, PathBuf};

use yog_book::layout::RecipeLayout;
use yog_book::page_type::PageType;
use yog_book::ui::Element;

/// Every `src/**/*.yui` of the mod at `root`, parsed (broken ones left out).
fn trees(root: &Path) -> Vec<(PathBuf, Element)> {
    let mut out: Vec<(PathBuf, Element)> = ignore::WalkBuilder::new(root.join("src"))
        .hidden(false)
        .build()
        .flatten()
        .map(|e| e.into_path())
        .filter(|p| p.is_file() && p.extension().is_some_and(|e| e == "yui"))
        .filter_map(|p| {
            let text = std::fs::read_to_string(&p).ok()?;
            Some((p, yog_book::ui::parse(&text).ok()?))
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn ns(root: &Path) -> String {
    crate::manifest::read_mod_field(root, "id").unwrap_or_else(|| "minecraft".into())
}

/// The mod's recipe layouts and the files they're in.
pub fn recipe_layouts(root: &Path) -> Vec<(PathBuf, RecipeLayout)> {
    let ns = ns(root);
    trees(root)
        .into_iter()
        .filter(|(_, el)| yog_book::layout::is_recipe_layout(el))
        .filter_map(|(p, el)| Some((p, yog_book::layout::compile(&el, &ns).ok()?)))
        .collect()
}

/// The mod's kinds of book page.
pub fn page_types(root: &Path) -> Vec<PageType> {
    let ns = ns(root);
    trees(root)
        .into_iter()
        .filter(|(_, el)| yog_book::page_type::is_book_page(el))
        .filter_map(|(_, el)| yog_book::page_type::compile(&el, &ns).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn reads_the_mods_layouts_and_page_types() {
        let dir = std::env::temp_dir().join(format!("yog-idle-mod-ui-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src/ui")).unwrap();
        std::fs::write(dir.join("yog.toml"), "[mod]\nid = \"mymod\"\n").unwrap();
        std::fs::write(
            dir.join("src/ui/crusher.yui"),
            r#"<Component recipe_layout="crusher" width="60" height="24"><RecipeSlot slot="input" x="4" y="4"/><RecipeResult x="40" y="4"/></Component>"#,
        )
        .unwrap();
        std::fs::write(dir.join("src/ui/page.yui"), r#"<Component book_page="note"><Property name="t" type="book_text"/><BookText text="{x:Bind t}"/></Component>"#).unwrap();
        std::fs::write(dir.join("src/ui/screen.yui"), r#"<Screen width="10" height="10"/>"#).unwrap();
        let l = super::recipe_layouts(&dir);
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].1.kinds, ["mymod:crusher"]);
        assert_eq!(super::page_types(&dir)[0].id, "mymod:note");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
