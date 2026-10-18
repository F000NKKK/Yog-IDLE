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
pub fn binary() -> Option<PathBuf> {
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
