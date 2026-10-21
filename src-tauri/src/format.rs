//! Formatting documents (rustfmt and the CLI's formatters) and calling the CLI.

use super::*;

/// The external formatter for a file kind, by extension: the program and its
/// arguments for reading the document on stdin and writing the formatted
/// result to stdout.
pub(super) fn formatter_for(path: &Path) -> Option<(&'static str, Vec<String>)> {
    let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect();
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "rs" => Some((
            "rustfmt",
            args(&["--edition", &rust_edition(path), "--emit", "stdout"]),
        )),
        "toml" => Some(("taplo", args(&["fmt", "-"]))),
        _ => None,
    }
}

/// The Rust edition `file` is written in — rustfmt can't tell from stdin:
/// its mod's `[mod] edition` (yog-cli's default 2021), else its crate's
/// `[package] edition`.
pub(super) fn rust_edition(file: &Path) -> String {
    const DEFAULT: &str = "2021";
    for dir in file.ancestors().skip(1) {
        if manifest::path(dir).is_file() {
            return manifest::read_mod_field(dir, "edition").unwrap_or_else(|| DEFAULT.into());
        }
        if let Ok(text) = std::fs::read_to_string(dir.join("Cargo.toml")) {
            let edition = text
                .parse::<toml::Table>()
                .ok()
                .and_then(|doc| Some(doc.get("package")?.get("edition")?.as_str()?.to_string()));
            return edition.unwrap_or_else(|| DEFAULT.into());
        }
    }
    DEFAULT.into()
}

/// Whether Format Document can work for `path` — a formatter exists for its
/// kind and is actually installed (it answers `--version`).
#[tauri::command]
pub(super) async fn format_supported(path: String) -> bool {
    let Some((program, _)) = formatter_for(Path::new(&path)) else {
        return false;
    };
    tauri::async_runtime::spawn_blocking(move || {
        substrate_platform::process::command(program)
            .arg("--version")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    })
    .await
    .unwrap_or(false)
}

/// Calls `method` of the CLI service (`yog serve`) — how the front end reads
/// and writes every Yog format.
#[tauri::command]
pub(super) async fn cli(
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    tauri::async_runtime::spawn_blocking(move || cli::call(&method, params))
        .await
        .map_err(|e| serde_json::Value::from(e.to_string()))?
}

/// Format Document: pipes `contents` (the editor's text — not necessarily
/// what's saved on disk) through the formatter for `path`'s kind and returns
/// the result. Runs in the file's own folder so the formatter picks up a
/// `rustfmt.toml`/`taplo.toml` there. A syntax error comes back as `Err`
/// with the formatter's own message.
#[tauri::command]
pub(super) async fn format_document(path: String, contents: String) -> Result<String, String> {
    let target = PathBuf::from(&path);
    let (program, args) =
        formatter_for(&target).ok_or_else(|| format!("no formatter for '{path}'"))?;
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Write;
        use std::process::Stdio;
        let mut command = substrate_platform::process::command(program);
        command
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(dir) = target.parent().filter(|d| d.is_dir()) {
            command.current_dir(dir);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("failed to run {program}: {e}"))?;
        // Written from its own thread: a large document can fill the stdout
        // pipe before stdin is fully consumed, which would deadlock a
        // write-then-read on one thread.
        let Some(mut stdin) = child.stdin.take() else {
            return Err(format!("{program} has no input"));
        };
        let writer = std::thread::spawn(move || stdin.write_all(contents.as_bytes()));
        let output = child.wait_with_output().map_err(|e| e.to_string())?;
        let _ = writer.join();
        if output.status.success() {
            String::from_utf8(output.stdout).map_err(|e| e.to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(if stderr.is_empty() {
                format!("{program} exited with {}", output.status)
            } else {
                stderr
            })
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
