//! "Start Debugging": builds a mod with debug symbols, launches it via
//! `yog run <config> --debugging-symbols`, finds the *real* game JVM process
//! (the spawned process is very often a launcher wrapper — `./gradlew
//! runClient` — that forks its own JVM as a child, not the process itself),
//! and attaches `yog-debugger` to it.
//!
//! Linux-only, matching `yog-debugger`'s own scope (`ptrace`).
//!
//! Deliberately does not reuse `run_and_stream`/`substrate_platform::
//! run_workflow`: that machinery only exposes "is it still running," not a
//! killable/pid-bearing process handle, and this needs both (to find the
//! wrapper's descendants, and to stop the whole tree on "Stop Debugging").
//! So this spawns and streams its own child directly — a small, deliberate
//! duplication of `spawn_streaming`'s shape, scoped to what debugging
//! specifically needs.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use nix::unistd::Pid;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use yog_debugger::discovery::find_descendant_with_module;
use yog_debugger::maps::find_module_base_by_prefix;
use yog_debugger::{Debugger, SourceBreakpoints, StopReason};
use yog_hot_reload::{GenerationAllocator, ModuleGeneration};
use yog_symbols::SymbolTable;

pub struct DebugSession {
    /// The originally-spawned process (often a launcher wrapper, e.g.
    /// gradlew) — not what the debugger is attached to, but what "Stop
    /// Debugging" kills to tear the whole instance down.
    wrapper: Child,
    debugger: Debugger,
    symbols: SymbolTable,
    module_base: u64,
    mod_id: String,
    generation: ModuleGeneration,
    breakpoints: SourceBreakpoints,
}

#[derive(Default)]
pub struct DebugState(pub Mutex<Option<DebugSession>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StackFrameOut {
    pub id: i64,
    pub name: String,
    pub file: String,
    pub line: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugStoppedEvent {
    pub reason: String,
    pub stack_trace: Vec<StackFrameOut>,
}

fn to_snake_name(id: &str) -> String {
    // Mirrors yog-cli's own `to_snake_name` exactly — the native's lib name
    // (and therefore its filename) is derived this way, and Yog-IDLE has to
    // agree with yog-cli's convention to find the same file on disk.
    let mut out = String::with_capacity(id.len());
    for c in id.chars() {
        if c == '-' || c == '_' {
            if out.chars().last() != Some('_') {
                out.push('_');
            }
        } else if c.is_uppercase() {
            if !out.is_empty() && out.chars().last() != Some('_') {
                out.push('_');
            }
            out.extend(c.to_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// Reads `[mod]`/`[package]`'s `id` out of a `yog.toml` — the minimal slice
/// of yog-cli's own parsing this needs, not a general yog.toml reader.
fn read_mod_id(contents: &str) -> Option<String> {
    let mut section = "";
    for raw in contents.lines() {
        let line = raw.trim();
        if line.starts_with('[') && line.ends_with(']') {
            section = &line[1..line.len() - 1];
            continue;
        }
        if section != "mod" && section != "package" {
            continue;
        }
        if let Some(value) = line.strip_prefix("id").and_then(|rest| rest.trim_start().strip_prefix('=')) {
            return Some(value.trim().trim_matches('"').to_string());
        }
    }
    None
}

/// The local, just-built unstripped native's path — `target/<triple>/
/// release/<lib>`, exactly how `yog-cli`'s `Builder`/`package()` name it for
/// the host platform. Not the runtime-extracted temp copy (unpredictable —
/// see `find_module_base_by_prefix`'s doc comment) — this is only used for
/// its DWARF data, which is byte-identical between the two.
fn local_native_path(project_root: &Path, mod_id: &str) -> PathBuf {
    let triple = match std::env::consts::ARCH {
        "aarch64" => "aarch64-unknown-linux-gnu",
        _ => "x86_64-unknown-linux-gnu",
    };
    let lib = format!("lib{}.so", to_snake_name(mod_id));
    project_root.join("target").join(triple).join("release").join(lib)
}

/// Starts `yog run <config_name> --debugging-symbols`, scans its output for
/// the `"==> launched pid "` line (yog-cli emits this right after spawning),
/// then hunts the spawned process's descendants for the one that actually
/// has `yog_runtime` loaded — since the spawned process is commonly a
/// launcher wrapper, not the game itself.
#[tauri::command]
pub fn debug_start(app: AppHandle, state: State<DebugState>, project_root: String, config_name: String) -> Result<(), String> {
    let root = PathBuf::from(&project_root);
    let yog_toml = std::fs::read_to_string(root.join("yog.toml")).map_err(|e| e.to_string())?;
    let mod_id = read_mod_id(&yog_toml).ok_or("yog.toml has no [mod]/[package] id")?;
    let native_path = local_native_path(&root, &mod_id);

    let mut child = Command::new("yog")
        .args(["run", &config_name, "--debugging-symbols"])
        .current_dir(&root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to launch `yog run {config_name}`: {e}"))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_app = app.clone();
    if let Some(stdout) = stdout {
        let out_app = out_app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let _ = out_app.emit("workflow-output", line);
            }
        });
    }

    // The pid line specifically — read on this thread (not the generic
    // stdout-forwarding one above) so we can act on it before it's lost in
    // the stream, and because yog-cli writes it to stderr.
    let Some(stderr) = stderr else {
        return Err("failed to capture yog run's output".to_string());
    };
    let mut wrapper_pid: Option<i32> = None;
    let mut lines = BufReader::new(stderr).lines();
    let deadline = Instant::now() + Duration::from_secs(120);
    while Instant::now() < deadline {
        let Some(Ok(line)) = lines.next() else { break };
        let _ = app.emit("workflow-output", format!("[warn] {line}"));
        if let Some(pid_str) = line.strip_prefix("==> launched pid ") {
            wrapper_pid = pid_str.trim().parse().ok();
            break;
        }
    }
    // Keep forwarding the rest of stderr in the background regardless of
    // whether we found the pid line.
    std::thread::spawn(move || {
        for line in lines.map_while(Result::ok) {
            let _ = out_app.emit("workflow-output", format!("[warn] {line}"));
        }
    });

    let Some(wrapper_pid) = wrapper_pid else {
        let _ = child.kill();
        return Err("yog run never printed its launched pid — did the build fail?".to_string());
    };

    // The wrapper (e.g. gradlew) may take a while to actually fork the real
    // JVM — poll for it rather than assuming it's there immediately.
    let discover_deadline = Instant::now() + Duration::from_secs(120);
    let real_pid = loop {
        if let Some(pid) = find_descendant_with_module(Pid::from_raw(wrapper_pid), "yog_runtime") {
            break pid;
        }
        if Instant::now() >= discover_deadline {
            let _ = child.kill();
            return Err("timed out waiting for the game process to load yog-runtime".to_string());
        }
        std::thread::sleep(Duration::from_millis(200));
    };

    let symbols = SymbolTable::load(&native_path).map_err(|e| format!("loading symbols from {}: {e}", native_path.display()))?;
    let mut debugger = Debugger::attach(real_pid.as_raw()).map_err(|e| format!("attaching to pid {}: {e}", real_pid.as_raw()))?;
    let prefix = format!("yog-{mod_id}-");
    let module_base = find_module_base_by_prefix(debugger.pid(), &prefix)
        .ok_or_else(|| format!("couldn't locate {mod_id}'s native in pid {}'s memory map", real_pid.as_raw()))?;

    let generation = GenerationAllocator::new().next();
    let mut breakpoints = SourceBreakpoints::new();
    for (file, line) in PENDING_BREAKPOINTS.lock().unwrap().iter().cloned().collect::<Vec<_>>() {
        let _ = breakpoints.set(&mut debugger, &mod_id, generation, module_base, &symbols, &file, line);
    }

    *state.0.lock().unwrap() = Some(DebugSession { wrapper: child, debugger, symbols, module_base, mod_id, generation, breakpoints });

    let _ = app.emit("debug-attached", real_pid.as_raw());
    Ok(())
}

/// Breakpoints requested before a debug session is attached — applied the
/// moment `debug_start` succeeds, same as any IDE lets you set breakpoints
/// before pressing Start.
static PENDING_BREAKPOINTS: Mutex<Vec<(String, u32)>> = Mutex::new(Vec::new());

#[tauri::command]
pub fn debug_set_breakpoint(state: State<DebugState>, file: String, line: u32) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    match guard.as_mut() {
        Some(session) => session
            .breakpoints
            .set(&mut session.debugger, &session.mod_id, session.generation, session.module_base, &session.symbols, &file, line)
            .map_err(|e| e.to_string()),
        None => {
            PENDING_BREAKPOINTS.lock().unwrap().push((file, line));
            Ok(())
        }
    }
}

#[tauri::command]
pub fn debug_clear_breakpoint(state: State<DebugState>, file: String, line: u32) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    match guard.as_mut() {
        Some(session) => session.breakpoints.clear(&mut session.debugger, &session.mod_id, &file, line).map_err(|e| e.to_string()),
        None => {
            PENDING_BREAKPOINTS.lock().unwrap().retain(|(f, l)| !(f == &file && *l == line));
            Ok(())
        }
    }
}

fn stack_trace_of(session: &DebugSession) -> Vec<StackFrameOut> {
    let Ok(addrs) = session.debugger.backtrace(64) else { return Vec::new() };
    addrs
        .into_iter()
        .enumerate()
        .filter_map(|(i, addr)| {
            let offset = addr.checked_sub(session.module_base)?;
            let location = session.symbols.resolve_addr(offset)?;
            Some(StackFrameOut {
                id: i as i64,
                name: location.function.unwrap_or_else(|| "<unknown>".to_string()),
                file: location.file.to_string_lossy().into_owned(),
                line: location.line,
            })
        })
        .collect()
}

fn emit_stop(app: &AppHandle, session: &DebugSession, reason: StopReason) {
    let reason_str = match reason {
        StopReason::Breakpoint(_) => "breakpoint",
        StopReason::Signal(_) => "signal",
        StopReason::Exited(_) | StopReason::Killed(_) => "exited",
    };
    let stack_trace = if reason_str == "exited" { Vec::new() } else { stack_trace_of(session) };
    let _ = app.emit("debug-stopped", DebugStoppedEvent { reason: reason_str.to_string(), stack_trace });
}

#[tauri::command]
pub fn debug_continue(app: AppHandle, state: State<DebugState>) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    let session = guard.as_mut().ok_or("no active debug session")?;
    let reason = session.debugger.continue_().map_err(|e| e.to_string())?;
    emit_stop(&app, session, reason);
    Ok(())
}

#[tauri::command]
pub fn debug_step(app: AppHandle, state: State<DebugState>) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    let session = guard.as_mut().ok_or("no active debug session")?;
    let reason = session.debugger.single_step().map_err(|e| e.to_string())?;
    emit_stop(&app, session, reason);
    Ok(())
}

/// Detaches (clearing every armed breakpoint first) and kills both the real
/// game process discovery found *and* the original wrapper — a plain
/// `Child::kill()` on the wrapper alone would leave its forked JVM running
/// orphaned; conversely a wrapper like Gradle can hand off to a persistent
/// background daemon that outlives `./gradlew` by design, so killing only
/// the process discovery found is the more reliable half of this, with the
/// wrapper cleanup as a best-effort second step (a lingering Gradle daemon
/// itself is not something this can or should tear down — `gradlew --stop`
/// is the user's own tool for that, out of scope here).
#[tauri::command]
pub fn debug_stop(state: State<DebugState>) -> Result<(), String> {
    let Some(mut session) = state.0.lock().unwrap().take() else {
        return Ok(());
    };
    let real_pid = session.debugger.pid();
    let _ = session.debugger.detach();
    let _ = nix::sys::signal::kill(real_pid, nix::sys::signal::Signal::SIGKILL);
    let _ = Command::new("pkill").args(["-P", &session.wrapper.id().to_string()]).status();
    let _ = session.wrapper.kill();
    let _ = session.wrapper.wait();
    Ok(())
}
