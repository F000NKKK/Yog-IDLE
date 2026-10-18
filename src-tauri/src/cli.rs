//! The `yog` CLI — the one place the IDE runs it from — and `yog serve`,
//! the CLI as a service the IDE reads every Yog format through: requests
//! are JSON lines (see `yog_cli::serve` in Yog-Mod-Loader). The service is
//! started on the first request and restarted when the `yog` binary
//! changes, so a new CLI takes effect without rebuilding or restarting the
//! IDE.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use std::time::SystemTime;

use base64::Engine as _;
use serde_json::{Value, json};

/// The CLI's program name, looked up on `PATH`.
const PROGRAM: &str = yog_ids::program::CLI;
/// The service's command.
const SERVE: &str = yog_ids::program::SERVE;

/// A command running the CLI.
pub fn command() -> Command {
    Command::new(binary().unwrap_or_else(|| PathBuf::from(PROGRAM)))
}

/// Where the CLI is: the first `yog` on `PATH`.
fn binary() -> Option<PathBuf> {
    let exe = format!("{PROGRAM}{}", std::env::consts::EXE_SUFFIX);
    std::env::split_paths(&std::env::var_os("PATH")?).map(|d| d.join(&exe)).find(|p| p.is_file())
}

struct Service {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
    /// The binary it was started from, and when that changed last.
    binary: Option<(PathBuf, SystemTime)>,
}

impl Drop for Service {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

static SERVICE: Mutex<Option<Service>> = Mutex::new(None);

/// The binary and its modification time, to notice a new CLI.
fn binary_stamp() -> Option<(PathBuf, SystemTime)> {
    let path = binary()?;
    let modified = std::fs::metadata(&path).and_then(|m| m.modified()).ok()?;
    Some((path, modified))
}

fn start() -> Result<Service, String> {
    let binary = binary_stamp();
    let mut child = command()
        .arg(SERVE)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("couldn't start `{PROGRAM} {SERVE}`: {e}"))?;
    let stdin = child.stdin.take().ok_or("the service has no stdin")?;
    let stdout = BufReader::new(child.stdout.take().ok_or("the service has no stdout")?);
    Ok(Service { child, stdin, stdout, next_id: 1, binary })
}

/// Calls `method` of the service with `params`: its result, or its error
/// (a message, or `{message, line}`).
pub fn call(method: &str, params: Value) -> Result<Value, Value> {
    let mut guard = SERVICE.lock().map_err(|e| json!(e.to_string()))?;
    // A new binary, or a service that died: start again.
    let stale = guard.as_mut().is_none_or(|s| s.binary != binary_stamp() || s.child.try_wait().ok().flatten().is_some());
    if stale {
        *guard = None;
    }
    let service = match guard.as_mut() {
        Some(s) => s,
        None => guard.insert(start().map_err(Value::from)?),
    };
    let id = service.next_id;
    service.next_id += 1;
    let request = json!({ "id": id, "method": method, "params": params });
    let mut reply = String::new();
    let sent = writeln!(service.stdin, "{request}").and_then(|()| service.stdin.flush()).and_then(|()| service.stdout.read_line(&mut reply));
    match sent {
        Ok(n) if n > 0 => {}
        // The service ended mid-request: the next call starts it again.
        _ => {
            *guard = None;
            return Err(json!(format!("`{PROGRAM} {SERVE}` stopped answering ({method})")));
        }
    }
    let mut reply: Value = serde_json::from_str(&reply).map_err(|e| json!(format!("a reply that isn't JSON: {e}")))?;
    match reply.get_mut("error").map(Value::take) {
        Some(error) => Err(error),
        None => Ok(reply.get_mut("result").map(Value::take).unwrap_or(Value::Null)),
    }
}

// ── The methods the backend uses ────────────────────────────────────────────

/// The id of the mod at `root` (its `yog.toml`'s), kept until the manifest changes.
pub fn mod_id(root: &Path) -> Option<String> {
    type Ids = Mutex<HashMap<PathBuf, (SystemTime, Option<String>)>>;
    static IDS: std::sync::OnceLock<Ids> = std::sync::OnceLock::new();
    let manifest = root.join(yog_ids::file::MANIFEST);
    let modified = std::fs::metadata(&manifest).and_then(|m| m.modified()).ok()?;
    let ids = IDS.get_or_init(Default::default);
    if let Some((at, id)) = ids.lock().ok().and_then(|m| m.get(root).cloned())
        && at == modified
    {
        return id;
    }
    let id = call("mod.id", json!({ "path": root })).ok().and_then(|v| v.as_str().map(str::to_string));
    if let Ok(mut m) = ids.lock() {
        m.insert(root.to_path_buf(), (modified, id.clone()));
    }
    id
}

/// The file the build makes at `assets/<ns>/<asset>` from the mod at `root`, when it's the mod's.
pub fn built_asset(root: &Path, ns: &str, asset: &str) -> Option<Vec<u8>> {
    if mod_id(root)?.as_str() != ns {
        return None;
    }
    let b64 = call("media.built_asset", json!({ "path": root, "ns": ns, "asset": asset })).ok()?;
    base64::engine::general_purpose::STANDARD.decode(b64.as_str()?).ok()
}

/// A texture of the mod (from `media.textures`).
#[derive(serde::Deserialize, Debug, Clone)]
pub struct Texture {
    pub id: String,
}

/// The mod's textures.
pub fn textures(root: &Path) -> Vec<Texture> {
    call("media.textures", json!({ "path": root })).ok().and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
}

/// A picture of the mod's `.yres` sets (from `media.pictures`).
#[derive(serde::Deserialize, Debug, Clone)]
pub struct Picture {
    pub set: String,
    pub name: String,
    pub path: String,
}

/// The mod's pictures.
pub fn pictures(root: &Path) -> Vec<Picture> {
    call("media.pictures", json!({ "path": root })).ok().and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
}

/// Whether texture `id` is the mod's own.
pub fn is_own_texture(root: &Path, id: &str) -> bool {
    call("media.is_own_texture", json!({ "path": root, "id": id })).ok().and_then(|v| v.as_bool()).unwrap_or(false)
}

/// The reply's error as text.
fn message(e: Value) -> String {
    match e {
        Value::String(s) => s,
        Value::Object(o) => o.get("message").and_then(Value::as_str).map_or_else(|| Value::Object(o.clone()).to_string(), str::to_string),
        other => other.to_string(),
    }
}

/// Paints texture `id`: `png` as its picture; the file written.
pub fn save_texture_picture(root: &Path, id: &str, png: &[u8]) -> Result<PathBuf, String> {
    let png = base64::engine::general_purpose::STANDARD.encode(png);
    call("media.save_texture_picture", json!({ "path": root, "id": id, "png": png })).map(|v| PathBuf::from(v.as_str().unwrap_or_default())).map_err(message)
}

/// Sets texture `id`'s animation (the game's `.mcmeta` JSON, or none).
pub fn save_texture_animation(root: &Path, id: &str, mcmeta: Option<&Value>) -> Result<PathBuf, String> {
    call("media.save_texture_animation", json!({ "path": root, "id": id, "mcmeta": mcmeta })).map(|v| PathBuf::from(v.as_str().unwrap_or_default())).map_err(message)
}

#[cfg(test)]
mod tests {
    /// The installed `yog` answers: `.yres` read through the service.
    #[test]
    #[ignore = "needs a `yog` with `serve` on PATH"]
    fn the_service_reads_yres() {
        let r = super::call("yres.parse", serde_json::json!({ "text": "{ \"a\": \"@bytes:iVBORw0KGgo=\" }" })).unwrap();
        assert_eq!(r["entries"][0]["type"], "image");
        assert!(super::call("nope", serde_json::Value::Null).is_err());
    }
}
