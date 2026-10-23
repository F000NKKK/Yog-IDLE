//! The debugged game process: its threads, where the mod's native is loaded.

use std::path::{Path, PathBuf};

use yog_debugger::Debugger;

/// The threads Break All stops: the ones mod code runs on — the client's
/// render thread and the integrated server's tick thread. Everything else
/// (sound, networking, GC, ...) keeps going, so pausing the game doesn't
/// stall the system's audio or drop the connection.
pub(super) fn is_game_thread(name: &str) -> bool {
    matches!(name, "Render thread" | "Server thread")
}

/// The local, just-built unstripped native's path — `target/<triple>/
/// release/<lib>`, exactly how `yog-cli`'s `Builder`/`package()` name it for
/// the host platform. Not the runtime-extracted temp copy (unpredictable —
/// see `find_latest_module_base`) — this is only used for
/// its DWARF data, which is byte-identical between the two.
///
/// `release` is correct for debug-mode runs too: `yog run --debug` (like
/// `yog build debug`) is still a `cargo build --release`, just with
/// `CARGO_PROFILE_RELEASE_DEBUG=true`/`..._STRIP=none` so the debug info
/// survives — there is no separate `debug/` output for it.
pub(crate) fn local_native_path(project_root: &Path, mod_id: &str) -> PathBuf {
    let triple = yog_ids::platform::host().map_or("", |p| p.triple);
    let lib = format!(
        "{}{}{}",
        std::env::consts::DLL_PREFIX,
        yog_ids::mod_lib_name(mod_id),
        std::env::consts::DLL_SUFFIX
    );
    project_root
        .join("target")
        .join(triple)
        .join("release")
        .join(lib)
}

/// Load base of `mod_id`'s native in the debugged process. The runtime
/// extracts each load to a fresh `yog-<mod_id>-<pid>-<n>.<ext>` in the temp
/// dir, so after a hot reload several copies can be loaded at once — pick
/// the newest (highest `n`). Matching the whole name, not a prefix, keeps
/// `yog-pipes` from matching a `yog-pipes-extra` mod.
pub(super) fn find_latest_module_base(debugger: &Debugger, mod_id: &str) -> Option<u64> {
    let prefix = format!("yog-{mod_id}-");
    debugger
        .modules()
        .into_iter()
        .filter_map(|m| {
            let name = m.path.file_name()?.to_str()?.to_owned();
            let stem = name.strip_prefix(&prefix)?.split('.').next()?.to_owned();
            // `<pid>-<n>`.
            let mut parts = stem.split('-');
            parts.next()?.parse::<u32>().ok()?;
            let n = parts.next()?.parse::<u64>().ok()?;
            parts.next().is_none().then_some((n, m.base))
        })
        .max_by_key(|&(n, _)| n)
        .map(|(_, base)| base)
}
