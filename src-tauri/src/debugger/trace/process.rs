//! The traced game process: its memory, its threads, where the mod's native is loaded.

use super::*;

/// The tracee's memory through `/proc/<pid>/mem` — readable by its tracer
/// while it's stopped, and far cheaper than a word-at-a-time `PTRACE_PEEKDATA`.
pub(super) struct ProcMem(std::fs::File);

impl ProcMem {
    pub(super) fn open(pid: Pid) -> Result<Self, String> {
        std::fs::File::open(format!("/proc/{pid}/mem"))
            .map(Self)
            .map_err(|e| format!("opening /proc/{pid}/mem: {e}"))
    }
}

impl TargetMemory for ProcMem {
    fn read(&self, addr: u64, buf: &mut [u8]) -> bool {
        use std::os::unix::fs::FileExt;
        self.0.read_exact_at(buf, addr).is_ok()
    }
}

/// The threads Break All stops: the ones mod code runs on — the client's
/// render thread and the integrated server's tick thread. Everything else
/// (sound, networking, GC, ...) keeps going, so pausing the game doesn't
/// stall the system's audio or drop the connection.
pub(super) fn is_game_thread(name: &str) -> bool {
    matches!(name, "Render thread" | "Server thread")
}

pub(super) fn to_snake_name(id: &str) -> String {
    // Mirrors yog-cli's own `to_snake_name` exactly — the native's lib name
    // (and therefore its filename) is derived this way, and Yog-IDLE has to
    // agree with yog-cli's convention to find the same file on disk.
    let mut out = String::with_capacity(id.len());
    for c in id.chars() {
        if c == '-' || c == '_' {
            if !out.ends_with('_') {
                out.push('_');
            }
        } else if c.is_uppercase() {
            if !out.is_empty() && !out.ends_with('_') {
                out.push('_');
            }
            out.extend(c.to_lowercase());
        } else {
            out.push(c);
        }
    }
    out
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
    let triple = match std::env::consts::ARCH {
        "aarch64" => "aarch64-unknown-linux-gnu",
        _ => "x86_64-unknown-linux-gnu",
    };
    let lib = format!("lib{}.so", to_snake_name(mod_id));
    project_root
        .join("target")
        .join(triple)
        .join("release")
        .join(lib)
}

/// Load base of `mod_id`'s native in `pid`. The runtime extracts each load
/// to a fresh `yog-<mod_id>-<pid>-<n>.<ext>` in the temp dir, so after a hot
/// reload several copies can be mapped at once — pick the newest (highest
/// `n`). Matching the whole name, not a prefix, keeps `yog-pipes` from
/// matching a `yog-pipes-extra` mod.
pub(super) fn find_latest_module_base(pid: Pid, mod_id: &str) -> Option<u64> {
    let maps = std::fs::read_to_string(format!("/proc/{}/maps", pid.as_raw())).ok()?;
    let prefix = format!("yog-{mod_id}-");
    let mut best: Option<(u64, u64)> = None; // (n, base)
    for line in maps.lines() {
        let mut fields = line.split_whitespace();
        let range = fields.next()?;
        let Some(path) = fields.nth(4) else { continue };
        let Some(name) = Path::new(path).file_name().and_then(|f| f.to_str()) else {
            continue;
        };
        let Some(rest) = name.strip_prefix(&prefix) else {
            continue;
        };
        let stem = rest.split('.').next().unwrap_or("");
        // `<pid>-<n>`.
        let mut parts = stem.split('-');
        let pid_ok = parts.next().is_some_and(|p| p.parse::<u32>().is_ok());
        let Some(Ok(n)) = parts.next().map(str::parse::<u64>) else {
            continue;
        };
        if !pid_ok || parts.next().is_some() {
            continue;
        }
        let Some(base) = range
            .split('-')
            .next()
            .and_then(|h| u64::from_str_radix(h, 16).ok())
        else {
            continue;
        };
        // The first mapping of a file is its lowest address — the load base.
        match best {
            Some((bn, _)) if bn >= n => {}
            _ => best = Some((n, base)),
        }
    }
    best.map(|(_, base)| base)
}
