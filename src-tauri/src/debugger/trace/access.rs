//! When the system refuses us the game: why, on this system, and what
//! fixes it. The messages start with a stable tag the Debug panel keys its
//! actions on.

/// Why attaching to `pid` was refused, and the one thing that fixes it.
/// Yama (`kernel.yama.ptrace_scope`) only lets a process trace its
/// descendants, and the game isn't one of ours — Gradle's daemon launches
/// it. The runtime lifts that for us when we connect (`PR_SET_PTRACER`);
/// this is for when that wasn't enough.
#[cfg(target_os = "linux")]
pub(super) fn denied_message(pid: i32) -> String {
    let scope = std::fs::read_to_string("/proc/sys/kernel/yama/ptrace_scope")
        .ok()
        .and_then(|s| s.trim().parse::<u8>().ok());
    match scope {
        Some(3) => format!(
            "[ptrace-disabled] attaching to pid {pid}: permission denied — ptrace is disabled on this system \
             (kernel.yama.ptrace_scope = 3) until the next reboot; no debugger can attach."
        ),
        _ => format!(
            "[needs-capability] attaching to pid {pid}: permission denied — kernel.yama.ptrace_scope = {} here, \
             which only lets privileged processes trace. Grant Yog-IDLE the ptrace capability (once), restart it, \
             and launch again.",
            scope.map_or_else(|| "?".to_string(), |s| s.to_string())
        ),
    }
}

/// macOS lets a debugger at a process only when both sides agree: the
/// debugger signed with the debugger entitlement, the target with
/// `get-task-allow` (the JDKs Yog Installer installs are).
#[cfg(target_os = "macos")]
pub(super) fn denied_message(pid: i32) -> String {
    format!(
        "[needs-get-task-allow] attaching to pid {pid}: macOS refused — the game's Java has to allow debugging \
         (get-task-allow). Run the game on a JDK installed by Yog Installer, which signs them so."
    )
}

#[cfg(windows)]
pub(super) fn denied_message(pid: i32) -> String {
    format!(
        "[needs-elevation] attaching to pid {pid}: access denied — the game runs elevated (as administrator) \
         and Yog-IDLE doesn't. Run both the same way."
    )
}

/// A capability can only be granted to a binary's on-disk file (checked at
/// `exec()` time) by something already privileged — a running process can
/// never grant *itself* one. So this is the one-time, user-initiated setup
/// step for attaching without needing `ptrace_scope` set to 0 system-wide:
/// `pkexec` (Polkit's graphical sudo-equivalent, standard on GNOME/KDE)
/// prompts for elevation once, then `setcap` stamps `cap_sys_ptrace+ep`
/// onto Yog-IDLE's own executable so every future launch already has it,
/// no repeated prompts. Never called implicitly — only in direct response
/// to the user asking for it (the "Grant ptrace access" action shown after
/// a `[needs-capability]` failure, which only Linux reports).
#[cfg(target_os = "linux")]
#[tauri::command]
pub fn debug_grant_ptrace_capability() -> Result<(), String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("couldn't determine Yog-IDLE's own executable path: {e}"))?;
    let status = substrate_process::command("pkexec")
        .arg("setcap")
        .arg("cap_sys_ptrace+ep")
        .arg(&exe)
        .status()
        .map_err(|e| format!("failed to run pkexec (is Polkit installed?): {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "setcap exited with {status} — cancelled, or `setcap`/`pkexec` isn't available. You can also run this manually: sudo setcap cap_sys_ptrace+ep {}",
            exe.display()
        ))
    }
}

/// Only Linux has a capability to grant (its failure is the only one that
/// offers the action).
#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub fn debug_grant_ptrace_capability() -> Result<(), String> {
    Err("only Linux debugs through a ptrace capability".to_string())
}
