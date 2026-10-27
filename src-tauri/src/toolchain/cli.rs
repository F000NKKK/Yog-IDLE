//! The `yog` CLI — the one place the IDE runs it from — and `yog serve`,
//! the CLI as a service the IDE reads every Yog format through: requests
//! and answers are frames of binary Yog Data (see `yog_cli::serve` in
//! Yog-Mod-Loader); the front end writes and reads them itself, this only
//! carries them. The service is
//! started on the first request and restarted when the `yog` binary
//! changes, so a new CLI takes effect without rebuilding or restarting the
//! IDE.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use std::time::SystemTime;

use yog_data::Value;
use yog_ids::{serve_method, serve_param, serve_request};

/// The CLI's program name, looked up on `PATH`.
const PROGRAM: &str = yog_ids::program::CLI;
/// The service's command.
const SERVE: &str = yog_ids::program::SERVE;

/// A command running the CLI.
pub fn command() -> Command {
    substrate_process::command(binary().unwrap_or_else(|| PathBuf::from(PROGRAM)))
}

/// Where the CLI is: the first `yog` on `PATH`.
pub fn binary() -> Option<PathBuf> {
    let exe = format!("{PROGRAM}{}", std::env::consts::EXE_SUFFIX);
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|d| d.join(&exe))
        .find(|p| p.is_file())
}

struct Service {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
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
    let stdout = child.stdout.take().ok_or("the service has no stdout")?;
    Ok(Service {
        child,
        stdin,
        stdout,
        binary,
    })
}

/// Sends `request` (a request's binary form, as the front end writes it)
/// and gives the service's answer, in its binary form.
pub fn exchange(request: &[u8]) -> Result<Vec<u8>, String> {
    let mut guard = SERVICE.lock().map_err(|e| e.to_string())?;
    // A new binary, or a service that died: start again.
    let stale = guard
        .as_mut()
        .is_none_or(|s| s.binary != binary_stamp() || s.child.try_wait().ok().flatten().is_some());
    if stale {
        *guard = None;
    }
    let service = match guard.as_mut() {
        Some(s) => s,
        None => guard.insert(start()?),
    };
    let answered = yog_data::io::write_frame_bytes(&mut service.stdin, request)
        .and_then(|()| yog_data::io::read_frame_bytes(&mut service.stdout));
    match answered {
        Ok(Some(reply)) => Ok(reply),
        // The service ended mid-request: the next call starts it again.
        _ => {
            *guard = None;
            Err(format!("`{PROGRAM} {SERVE}` stopped answering"))
        }
    }
}

/// Calls `method` of the service with `params`: its result, or its error
/// (a message, or `{message, line}`).
pub fn call(method: &str, params: Value) -> Result<Value, Value> {
    let request: Value = [
        (serve_request::METHOD, Value::from(method)),
        (serve_request::PARAMS, params),
    ]
    .into_iter()
    .collect::<yog_data::Map>()
    .into();
    let reply = exchange(&yog_data::binary::encode(&request))?;
    yog_data::read_bytes::<Result<Value, Value>>(&reply)
        .map_err(|e| Value::from(format!("an answer that isn't one: {e:?}")))?
}

// ── The methods the backend uses ────────────────────────────────────────────

/// The id of the mod at `root` (its `yog.toml`'s), kept until the manifest changes.
pub fn mod_id(root: &Path) -> Option<String> {
    type Ids = Mutex<HashMap<PathBuf, (SystemTime, Option<String>)>>;
    static IDS: std::sync::OnceLock<Ids> = std::sync::OnceLock::new();
    let manifest = root.join(yog_ids::file::MANIFEST);
    let modified = std::fs::metadata(&manifest)
        .and_then(|m| m.modified())
        .ok()?;
    let ids = IDS.get_or_init(Default::default);
    if let Some((at, id)) = ids.lock().ok().and_then(|m| m.get(root).cloned())
        && at == modified
    {
        return id;
    }
    let id = call(serve_method::MOD_ID, path_param(root))
        .ok()
        .and_then(|v| v.as_str().map(str::to_string));
    if let Ok(mut m) = ids.lock() {
        m.insert(root.to_path_buf(), (modified, id.clone()));
    }
    id
}

/// Every Yog format's files (binary on disk) are searched and replaced in
/// as their text: the platform reads and writes them through the service.
pub fn text_views() -> substrate_platform::text_view::TextViews {
    let view = substrate_platform::text_view::TextView {
        read: read_source,
        write: write_source,
    };
    yog_ids::Format::ALL
        .iter()
        .filter(|f| f.is_data())
        .fold(Default::default(), |views, format| {
            views.with(format.ext(), view)
        })
}

/// A Yog format's file as the editor shows it.
fn read_source(path: &Path) -> Option<String> {
    let params = path_param(path);
    call(serve_method::SOURCE_READ, params)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
}

/// `text` saved as a Yog format's file.
fn write_source(path: &Path, text: &str) -> std::io::Result<()> {
    let mut params = path_param(path);
    if let Value::Map(m) = &mut params {
        m.insert(serve_param::TEXT, Value::from(text));
    }
    call(serve_method::SOURCE_WRITE, params)
        .map(|_| ())
        .map_err(|e| std::io::Error::other(yog_data::text::to_string(&e)))
}

/// The `path` parameter, alone.
fn path_param(path: &Path) -> Value {
    yog_data::Map::from_iter([(
        serve_param::PATH,
        Value::from(path.to_string_lossy().as_ref()),
    )])
    .into()
}

#[cfg(test)]
mod tests {
    /// The installed `yog` answers: `.yres` read through the service.
    #[test]
    #[ignore = "needs a `yog` with `serve` on PATH"]
    fn the_service_reads_yres() {
        let params =
            yog_data::text::parse_value(r#"{ text: "{ \"a\": \"@bytes:iVBORw0KGgo=\" }" }"#)
                .unwrap();
        let r = super::call(yog_ids::serve_method::YRES_PARSE, params).unwrap();
        let entry = &r.get("entries").and_then(|e| e.as_list()).unwrap()[0];
        assert_eq!(entry.get("type").and_then(|t| t.as_str()), Some("image"));
        assert!(super::call("nope", super::Value::Null).is_err());
    }
}
