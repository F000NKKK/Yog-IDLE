//! The `.ybook` designer's backend: the book drawn by yog-book itself —
//! the renderer the game runs — through the recording `YogGfxApi`, and
//! clicked through like a reader would (`docs/books.md`).
//!
//! Each open `.ybook` keeps its own reader (the page it's on); an edit
//! swaps the book under it without losing the place.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use yog_book::{Book, BookRenderer};

use super::assets::Resources;
use super::{gfx, images, raster};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookArgs {
    pub path: String,
    /// The `.ybook` as it is in the editor.
    pub text: String,
    pub screen_w: u32,
    pub screen_h: u32,
    pub scale: u32,
    #[serde(default)]
    pub action: Option<BookAction>,
}

/// What the reader does before the book is drawn.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BookAction {
    /// A click at GUI pixels `x, y`.
    Click { x: f32, y: f32 },
    /// Go to an entry's page (the document's selection).
    Show { entry: String, page: usize },
    /// Back to the landing page.
    Home,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookRendered {
    /// `data:image/png;base64,…` — `scale` physical px per GUI px; `None`
    /// when the book doesn't parse.
    pub image: Option<String>,
    pub scale: u32,
    /// The entry and page shown (`None`: the landing or a list page).
    pub shown: Option<(String, usize)>,
    /// What a click did (`"next_page"`, `"entry:2"`, …).
    pub action: Option<String>,
    /// The page moves by itself (an entity, a structure): draw it again.
    pub animated: bool,
    pub error: Option<String>,
}

struct Session {
    renderer: BookRenderer,
    /// The resolved book JSON it was last given.
    json: String,
}

static SESSIONS: LazyLock<Mutex<HashMap<String, Session>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// The mod a content file belongs to: the folder with its `yog.toml`.
fn mod_root(path: &Path) -> Option<PathBuf> {
    path.ancestors().find(|p| p.join("yog.toml").is_file()).map(Path::to_path_buf)
}

/// `Set.name` → text, from the mod's `resources/*.yres` (the neutral ones,
/// not `Set.<locale>.yres`).
fn texts(mod_root: &Path) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Ok(dir) = std::fs::read_dir(mod_root.join("resources")) else { return out };
    for f in dir.flatten() {
        let p = f.path();
        let Some(set) = p.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix(".yres")) else {
            continue;
        };
        if set.contains('.') {
            continue;
        }
        let Some(Value::Object(map)) = std::fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str(&t).ok())
        else {
            continue;
        };
        for (k, v) in map {
            let text = match &v {
                Value::String(s) => Some(s.clone()),
                Value::Object(o) if o.get("type").is_none_or(|t| t == "text") => {
                    o.get("value").and_then(Value::as_str).map(str::to_string)
                }
                _ => None,
            };
            if let Some(t) = text {
                out.insert(format!("{set}.{k}"), t);
            }
        }
    }
    out
}

/// The mod's recipes, as the game gets them: `content/**/*.yrecipe` in
/// Yog's recipe format — (id, JSON).
fn recipes(mod_root: &Path) -> Vec<(String, String)> {
    let mod_id = crate::manifest::read_mod_field(mod_root, "id").unwrap_or_default();
    let mut out = Vec::new();
    let mut stack = vec![mod_root.join("content")];
    while let Some(dir) = stack.pop() {
        for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            if p.extension().is_none_or(|x| x != "yrecipe") {
                continue;
            }
            let Some(v) = std::fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else {
                continue;
            };
            let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let id = match v.get("id").and_then(Value::as_str) {
                Some(id) if id.contains(':') => id.to_string(),
                Some(id) => format!("{mod_id}:{id}"),
                None => format!("{mod_id}:{stem}"),
            };
            out.push((id, v.to_string()));
        }
    }
    out
}

/// `minecraft:amethyst_dust` → `Amethyst Dust`.
fn humanize(id: &str) -> String {
    let path = id.rsplit([':', '/']).next().unwrap_or(id);
    path.split('_')
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Replaces references the way `yog build` does — but with the texts
/// themselves, as the player reads them.
fn resolve(v: Value, texts: &HashMap<String, String>, missing: &mut Vec<String>) -> Value {
    match v {
        Value::String(s) => match s.strip_prefix('@') {
            Some(rest) if rest.starts_with('@') => Value::String(rest.to_string()),
            Some(rest) => {
                if let Some(id) = rest.strip_prefix("item:").or_else(|| rest.strip_prefix("block:")) {
                    Value::String(humanize(id))
                } else if let Some(t) = texts.get(rest) {
                    Value::String(t.clone())
                } else {
                    missing.push(s.clone());
                    Value::String(s)
                }
            }
            None => Value::String(s),
        },
        Value::Array(a) => Value::Array(a.into_iter().map(|v| resolve(v, texts, missing)).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (k, resolve(v, texts, missing))).collect()),
        other => other,
    }
}

/// The `.ybook` text → the book a player would see.
pub fn parse(text: &str, mod_root: Option<&Path>) -> Result<Book, String> {
    let value: Value = serde_json::from_str(text).map_err(|e| format!("not JSON: {e}"))?;
    let texts = mod_root.map(texts).unwrap_or_default();
    let mut missing = Vec::new();
    let mut value = resolve(value, &texts, &mut missing);
    if let Some(o) = value.as_object_mut() {
        // The reader shows texts, not keys.
        o.insert("i18n".into(), false.into());
    }
    let book: Book = serde_json::from_value(value).map_err(|e| format!("not a book: {e}"))?;
    if let Some(first) = missing.first() {
        return Err(format!("{first}: no such text in resources/*.yres"));
    }
    Ok(book)
}

pub fn render(args: &BookArgs) -> BookRendered {
    let (sw, sh) = (args.screen_w.clamp(1, 4096), args.screen_h.clamp(1, 4096));
    let root = mod_root(Path::new(&args.path));
    let fail = |error: String| BookRendered { image: None, scale: args.scale, shown: None, action: None, animated: false, error: Some(error) };
    let book = match parse(&args.text, root.as_deref()) {
        Ok(b) => b,
        Err(e) => return fail(e),
    };
    let json = serde_json::to_string(&book).unwrap_or_default();

    let mut sessions = SESSIONS.lock().unwrap_or_else(|e| e.into_inner());
    let session = sessions.entry(args.path.clone()).or_insert_with(|| {
        let mut renderer = BookRenderer::new(book.clone());
        for (id, recipe) in root.as_deref().map(recipes).unwrap_or_default() {
            renderer.add_recipe(id, &recipe);
        }
        Session { renderer, json: json.clone() }
    });
    if session.json != json {
        session.renderer.set_book(book);
        session.json = json;
    }
    let r = &mut session.renderer;

    // Lay out first: a click hits what was last drawn at this size.
    gfx::record(sw as i32, sh as i32, |ctx| r.render(ctx, sw as f32, sh as f32));
    let action = match &args.action {
        Some(BookAction::Click { x, y }) => r.click(*x, *y),
        Some(BookAction::Show { entry, page }) => {
            r.show(entry, *page);
            None
        }
        Some(BookAction::Home) => {
            r.handle_event("home");
            None
        }
        None => None,
    };

    images::set_document(root.as_deref());
    let ops = gfx::record(sw as i32, sh as i32, |ctx| r.render(ctx, sw as f32, sh as f32));
    let res = Resources::for_mod(root.as_deref());
    let scale = raster::fit_scale(sw, sh, args.scale);
    let canvas = raster::rasterize(&ops, sw, sh, scale, &res);
    match canvas.png() {
        Ok(png) => BookRendered {
            image: Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png))),
            scale,
            shown: r.shown(),
            action,
            animated: r.animated(),
            error: None,
        },
        Err(e) => fail(e),
    }
}

/// Forgets a closed `.ybook`'s reader.
pub fn close(path: &str) {
    SESSIONS.lock().unwrap_or_else(|e| e.into_inner()).remove(path);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_references_to_their_texts() {
        let mut texts = HashMap::new();
        texts.insert("Book.title".to_string(), "Guide".to_string());
        let mut missing = Vec::new();
        let v = serde_json::json!({ "name": "@Book.title", "a": "@item:mymod:ruby_block", "b": "@@x", "c": "@Book.nope" });
        let v = resolve(v, &texts, &mut missing);
        assert_eq!(v["name"], "Guide");
        assert_eq!(v["a"], "Ruby Block");
        assert_eq!(v["b"], "@x");
        assert_eq!(missing, ["@Book.nope"]);
    }

    #[test]
    fn draws_and_clicks_through_a_book() {
        let text = r#"{ "id": "t:guide", "name": "Guide",
            "categories": [{ "id": "c", "name": "Basics" }],
            "entries": [{ "id": "e", "name": "First", "category": "c",
                "pages": [{ "type": "text", "text": "one" }, { "type": "text", "text": "two" }] }] }"#;
        let args = |action| BookArgs { path: "/tmp/test.ybook".into(), text: text.into(), screen_w: 400, screen_h: 240, scale: 1, action };
        let r = render(&args(None));
        assert!(r.error.is_none() && r.image.is_some(), "{:?}", r.error);
        assert_eq!(r.shown, None);
        let r = render(&args(Some(BookAction::Show { entry: "e".into(), page: 1 })));
        assert_eq!(r.shown, Some(("e".into(), 1)));
        let r = render(&args(Some(BookAction::Home)));
        assert_eq!(r.shown, None);
        close("/tmp/test.ybook");
    }
}
