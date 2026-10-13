//! Minecraft's own resources, read from the user's local game files — the
//! client jar a Gradle dev setup (Loom, ForgeGradle, NeoGradle) or the
//! official launcher already downloaded, plus its asset index/objects —
//! so the designer draws with the game's font and textures. Nothing is
//! bundled or redistributed: when no client jar is found the designer says
//! so and draws with what it has (flat rects, a fallback glyph box).
//!
//! Resources resolve like a resource-pack stack: the mod's own `assets/`
//! first, then the client jar, then the asset objects (where the unifont
//! lives).

use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

/// A decoded RGBA8 image.
pub struct Image {
    pub w: u32,
    pub h: u32,
    pub rgba: Vec<u8>,
}

impl Image {
    pub fn pixel(&self, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * self.w + x) * 4) as usize;
        [self.rgba[i], self.rgba[i + 1], self.rgba[i + 2], self.rgba[i + 3]]
    }

    /// Minecraft's missing texture: 16×16, magenta/black quarters.
    pub fn missing() -> Image {
        let mut rgba = Vec::with_capacity(16 * 16 * 4);
        for y in 0..16 {
            for x in 0..16 {
                let magenta = (x < 8) == (y < 8);
                rgba.extend_from_slice(if magenta { &[0xF8, 0x00, 0xF8, 0xFF] } else { &[0, 0, 0, 0xFF] });
            }
        }
        Image { w: 16, h: 16, rgba }
    }
}

pub fn decode_png(bytes: &[u8]) -> Option<Image> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().ok()?;
    let mut buf = vec![0; reader.output_buffer_size()?];
    let info = reader.next_frame(&mut buf).ok()?;
    let (w, h) = (info.width, info.height);
    let px = (w * h) as usize;
    let rgba = match info.color_type {
        png::ColorType::Rgba => buf[..px * 4].to_vec(),
        png::ColorType::Rgb => buf[..px * 3].chunks(3).flat_map(|c| [c[0], c[1], c[2], 0xFF]).collect(),
        png::ColorType::GrayscaleAlpha => buf[..px * 2].chunks(2).flat_map(|c| [c[0], c[0], c[0], c[1]]).collect(),
        png::ColorType::Grayscale => buf[..px].iter().flat_map(|&g| [g, g, g, 0xFF]).collect(),
        png::ColorType::Indexed => return None, // EXPAND turns these into RGB(A)
    };
    Some(Image { w, h, rgba })
}

/// Where the vanilla resources come from.
pub struct Vanilla {
    pub jar: PathBuf,
    pub version: String,
    zip: Mutex<zip::ZipArchive<File>>,
    /// Asset objects dir + `key → hash` from the version's index.
    objects: Option<(PathBuf, HashMap<String, String>)>,
}

impl Vanilla {
    /// `key` from the jar and from the asset objects — both, for files the
    /// download overrides (the jar's `font/include/unifont.json` is an
    /// empty stub; the real one is an asset object).
    pub fn read_all(&self, key: &str) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        if let Ok(mut zip) = self.zip.lock()
            && let Ok(mut entry) = zip.by_name(&format!("assets/{key}")) {
                let mut bytes = Vec::new();
                if entry.read_to_end(&mut bytes).is_ok() {
                    out.push(bytes);
                }
            }
        if let Some((dir, index)) = &self.objects
            && let Some(bytes) = index.get(key).and_then(|hash| std::fs::read(dir.join(&hash[..2]).join(hash)).ok()) {
                out.push(bytes);
            }
        out
    }

    /// The game's item and block texture names (`apple`, `stone`, ...),
    /// sorted — what `item:` / `block:` sources can show in the designer.
    pub fn texture_names(&self) -> (Vec<String>, Vec<String>) {
        let (mut items, mut blocks) = (Vec::new(), Vec::new());
        if let Ok(zip) = self.zip.lock() {
            for name in zip.file_names() {
                let Ok(name) = name else { continue };
                let Some(stem) = name.strip_prefix("assets/minecraft/textures/").and_then(|n| n.strip_suffix(".png")) else {
                    continue;
                };
                if let Some(item) = stem.strip_prefix("item/") {
                    items.push(item.to_string());
                } else if let Some(block) = stem.strip_prefix("block/") {
                    blocks.push(block.to_string());
                }
            }
        }
        items.sort();
        blocks.sort();
        (items, blocks)
    }

    fn read(&self, key: &str) -> Option<Vec<u8>> {
        // `key` is `namespace/path` — `assets/<key>` in the jar.
        if let Ok(mut zip) = self.zip.lock()
            && let Ok(mut entry) = zip.by_name(&format!("assets/{key}")) {
                let mut out = Vec::new();
                if entry.read_to_end(&mut out).is_ok() {
                    return Some(out);
                }
            }
        let (dir, index) = self.objects.as_ref()?;
        let hash = index.get(key)?;
        std::fs::read(dir.join(&hash[..2]).join(hash)).ok()
    }
}

fn home() -> Option<PathBuf> {
    dirs::home_dir()
}

/// `1.21.1` > `1.20.1` > `1.9`.
fn version_key(v: &str) -> Vec<u32> {
    v.split(['.', '-']).map(|p| p.parse().unwrap_or(0)).collect()
}

/// Every client jar on this machine, as `(version, path)`.
fn client_jars(extra_roots: &[PathBuf]) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    if let Ok(p) = std::env::var("YOG_MC_CLIENT_JAR") {
        let p = PathBuf::from(p);
        if p.is_file() {
            out.push(("999".to_string(), p));
        }
    }
    let mut version_dirs: Vec<(PathBuf, &str)> = Vec::new();
    if let Some(h) = home() {
        let caches = h.join(".gradle/caches");
        version_dirs.push((caches.join("fabric-loom"), "minecraft-client.jar"));
        version_dirs.push((caches.join("forge_gradle/minecraft_repo/versions"), "client.jar"));
        version_dirs.push((caches.join("minecraft/versions"), "client.jar"));
        version_dirs.push((h.join(".minecraft/versions"), ""));
        version_dirs.push((h.join("Library/Application Support/minecraft/versions"), ""));
    }
    if let Some(d) = dirs::data_dir() {
        version_dirs.push((d.join(".minecraft/versions"), ""));
    }
    for root in extra_roots {
        // A Yog workspace: the loader's NeoGradle caches beside the mod.
        for loader in ["neoforge", "fabric", "forge"] {
            for base in [root.join("Yog-Mod-Loader"), root.join("../Yog-Mod-Loader")] {
                version_dirs.push((base.join(loader).join(".gradle/caches/minecraft/versions"), "client.jar"));
            }
        }
    }
    for (dir, file) in version_dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            let version = e.file_name().to_string_lossy().into_owned();
            if !version.chars().next().is_some_and(|c| c.is_ascii_digit()) {
                continue;
            }
            let jar = if file.is_empty() {
                e.path().join(format!("{version}.jar"))
            } else {
                e.path().join(file)
            };
            if jar.is_file() {
                out.push((version, jar));
            }
        }
    }
    out
}

/// The asset objects dir and the index for `version` (any index that knows
/// the unifont when there's no exact match).
fn asset_objects(version: &str) -> Option<(PathBuf, HashMap<String, String>)> {
    let h = home()?;
    let mut dirs = vec![
        h.join(".gradle/caches/fabric-loom/assets"),
        h.join(".gradle/caches/forge_gradle/assets"),
        h.join(".gradle/caches/minecraft/assets"),
        h.join(".minecraft/assets"),
    ];
    if let Some(d) = dirs::data_dir() {
        dirs.push(d.join(".minecraft/assets"));
    }
    let mut best: Option<(bool, PathBuf, HashMap<String, String>)> = None;
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir.join("indexes")) else {
            continue;
        };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let exact = name.starts_with(&format!("{version}-")) || name == format!("{version}.json");
            if best.as_ref().is_some_and(|b| b.0 || !exact) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(e.path()) else {
                continue;
            };
            let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
                continue;
            };
            let Some(objects) = json.get("objects").and_then(|o| o.as_object()) else {
                continue;
            };
            if !objects.contains_key("minecraft/font/include/unifont.json") {
                continue;
            }
            let index = objects
                .iter()
                .filter_map(|(k, v)| Some((k.clone(), v.get("hash")?.as_str()?.to_string())))
                .collect();
            best = Some((exact, dir.join("objects"), index));
        }
    }
    best.map(|(_, dir, index)| (dir, index))
}

static VANILLA: OnceLock<Mutex<Option<Arc<Vanilla>>>> = OnceLock::new();

/// The newest client jar found (cached after the first successful lookup).
pub fn vanilla(extra_roots: &[PathBuf]) -> Option<Arc<Vanilla>> {
    let cell = VANILLA.get_or_init(|| Mutex::new(None));
    let mut slot = cell.lock().ok()?;
    if let Some(v) = slot.as_ref() {
        return Some(v.clone());
    }
    let mut jars = client_jars(extra_roots);
    jars.sort_by_key(|(v, _)| std::cmp::Reverse(version_key(v)));
    for (version, jar) in jars {
        let Ok(file) = File::open(&jar) else { continue };
        let Ok(zip) = zip::ZipArchive::new(file) else {
            continue;
        };
        let v = Arc::new(Vanilla {
            objects: asset_objects(&version),
            jar,
            version,
            zip: Mutex::new(zip),
        });
        *slot = Some(v.clone());
        return Some(v);
    }
    None
}

/// Resolves `namespace:path` resources for one mod: its `assets/` dir, then vanilla.
#[derive(Clone)]
pub struct Resources {
    pub mod_root: Option<PathBuf>,
    pub vanilla: Option<Arc<Vanilla>>,
}

/// `"ns:path"` → `("ns", "path")`; a bare path is `minecraft`.
pub fn split_id(id: &str) -> (&str, &str) {
    id.split_once(':').unwrap_or(("minecraft", id))
}

impl Resources {
    pub fn for_mod(mod_root: Option<&Path>) -> Resources {
        let roots: Vec<PathBuf> = mod_root.into_iter().map(Path::to_path_buf).collect();
        let parents: Vec<PathBuf> = roots.iter().filter_map(|r| r.parent().map(Path::to_path_buf)).collect();
        Resources {
            mod_root: mod_root.map(Path::to_path_buf),
            vanilla: vanilla(&[roots, parents].concat()),
        }
    }

    /// The bytes of `assets/<ns>/<path>`.
    pub fn read(&self, ns: &str, path: &str) -> Option<Vec<u8>> {
        if let Some(root) = &self.mod_root {
            for base in [root.join("assets"), root.join("src/assets"), root.join("resources/assets")] {
                if let Ok(bytes) = std::fs::read(base.join(ns).join(path)) {
                    return Some(bytes);
                }
            }
        }
        self.vanilla.as_ref()?.read(&format!("{ns}/{path}"))
    }

    /// A texture by full resource id (`minecraft:textures/item/apple.png`).
    pub fn texture(&self, id: &str) -> Option<Arc<Image>> {
        type Cache = Mutex<HashMap<(Option<PathBuf>, String), Option<Arc<Image>>>>;
        static CACHE: OnceLock<Cache> = OnceLock::new();
        let cache = CACHE.get_or_init(Default::default);
        let key = (self.mod_root.clone(), id.to_string());
        if let Some(hit) = cache.lock().ok()?.get(&key) {
            return hit.clone();
        }
        let (ns, path) = split_id(id);
        let image = self.read(ns, path).and_then(|b| decode_png(&b)).map(Arc::new);
        if let Ok(mut c) = cache.lock() {
            c.insert(key, image.clone());
        }
        image
    }
}
