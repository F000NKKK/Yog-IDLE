//! `.yui` screen files (the screen designer's format) — regenerating their
//! code (`.yog-build/generated/**/*.g.rs`, what the code-behind pulls in
//! with `yog_api::ui_include!`) when one is saved, through `yog ui gen`.

use std::path::PathBuf;
use std::process::Command;

/// Runs `yog ui gen <path>` in the file's folder, so a saved screen's
/// generated `foo.g.rs` is current without a full build (`yog` finds the
/// project from the `yog.toml` above the file). `Ok` carries the
/// generated file's path; `Err` the generator's message (an invalid
/// attribute, say) or why `yog` couldn't run.
pub fn codegen(path: &str) -> Result<String, String> {
    let file = PathBuf::from(path);
    if file.extension().and_then(|e| e.to_str()) != Some("yui") {
        return Err(format!("not a .yui file: {path}"));
    }
    let mut command = Command::new("yog");
    command.args(["ui", "gen"]).arg(&file);
    if let Some(dir) = file.parent().filter(|d| d.is_dir()) {
        command.current_dir(dir);
    }
    let output = command
        .output()
        .map_err(|e| format!("failed to run yog: {e}"))?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        let message = stderr
            .lines()
            .map(|l| l.trim_start_matches("yog: error: "))
            .collect::<Vec<_>>()
            .join("\n");
        return Err(if message.trim().is_empty() {
            format!("yog ui gen failed ({})", output.status)
        } else {
            message.trim().to_string()
        });
    }
    // "==> src/foo.yui -> /project/.yog-build/generated/foo.g.rs"
    Ok(stderr
        .lines()
        .find_map(|l| l.rsplit_once(" -> ").map(|(_, out)| out.trim().to_string()))
        .unwrap_or_default())
}
