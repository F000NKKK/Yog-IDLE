//! `.yui` screen files (the screen designer's format) — regenerating their
//! code (`.yog-build/generated/**/*.g.rs`, what the code-behind pulls in
//! with `yog_api::ui_include!`) when one is saved, through `yog ui gen` —
//! and the same for `.yres` resource files (`resources/<Set>.g.rs`,
//! through `yog res check`).

use std::path::PathBuf;
use std::process::Command;

/// Runs `yog ui gen <path>` in the file's folder, so a saved screen's
/// generated `foo.g.rs` is current without a full build (`yog` finds the
/// project from the `yog.toml` above the file). `Ok` carries the
/// generated file's path; `Err` the generator's message (an invalid
/// attribute, say) or why `yog` couldn't run.
pub fn codegen(path: &str) -> Result<Codegen, String> {
    let file = PathBuf::from(path);
    let args: &[&str] = match file.extension().and_then(|e| e.to_str()) {
        Some("yui") => &["ui", "gen"],
        // Regenerates `.yog-build/generated/resources/<Set>.g.rs` (and checks the set).
        Some("yres") => &["res", "check"],
        // Regenerates `.yog-build/generated/yog-content.g.rs` (and checks every content file).
        Some("yblock" | "yitem") => &["content", "check"],
        _ => return Err(format!("not a .yui, .yres, .yblock or .yitem file: {path}")),
    };
    let mut command = Command::new("yog");
    command.args(args);
    if args[0] == "ui" {
        command.arg(&file);
    }
    // `yog res check` / `yog content check` work on the project in the current folder.
    let project = file
        .ancestors()
        .skip(1)
        .find(|d| crate::manifest::path(d).is_file());
    if let Some(dir) = (if args[0] != "ui" { project } else { None })
        .or(file.parent())
        .filter(|d| d.is_dir())
    {
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
            format!("yog {} failed ({})", args.join(" "), output.status)
        } else {
            message.trim().to_string()
        });
    }
    Ok(Codegen {
        // "==> src/foo.yui -> /project/.yog-build/generated/foo.g.rs"
        generated: stderr
            .lines()
            .find_map(|l| l.rsplit_once(" -> ").map(|(_, out)| out.trim().to_string()))
            .unwrap_or_default(),
        log: stderr.into_owned(),
    })
}

/// A successful regeneration: the generated file, and what `yog` said on
/// the way — its warnings go to the Error List.
#[derive(serde::Serialize)]
pub struct Codegen {
    pub generated: String,
    pub log: String,
}
