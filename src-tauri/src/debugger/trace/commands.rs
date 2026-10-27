//! The debugger's commands: breakpoints, continue, step, pause, threads.

use substrate_lock::Locked;

use super::*;

pub(super) fn warn(app: &AppHandle, message: String) {
    let _ = app.emit(
        crate::app::events::OUTPUT_DEBUG,
        format!("[warn] {message}"),
    );
}

/// Mirrors the editor gutter: every breakpoint the user currently has set,
/// whether or not a debug session is attached — kept in sync on every
/// toggle (deduplicated), so a session attaching later (or a second one
/// after Restart) arms exactly what the gutter shows, same as any IDE lets
/// you set breakpoints before pressing Start.
pub(super) static BREAKPOINTS: Mutex<Vec<(String, u32)>> = Mutex::new(Vec::new());

/// `StackFrameOut::id` = physical frame * this + inline depth.
pub(super) const FRAME_ID_STRIDE: usize = 64;

/// `std`'s DWARF paths (`/rustc/<commit>/library/...`) mapped into an
/// installed `rust-src`: the toolchain whose `rustc` was built from that
/// commit, else any toolchain that has `rust-src`. Unchanged when nothing
/// matches (the UI then suggests installing `rust-src`).
pub(super) fn map_rust_src(path: &str) -> String {
    let Some(rest) = path.strip_prefix("/rustc/") else {
        return path.to_string();
    };
    let Some((commit, rel)) = rest.split_once('/') else {
        return path.to_string();
    };
    let Some(rel) = rel.strip_prefix("library/") else {
        return path.to_string();
    };
    static CACHE: Mutex<Option<HashMap<String, Option<PathBuf>>>> = Mutex::new(None);
    let library = CACHE
        .locked()
        .get_or_insert_with(HashMap::new)
        .entry(commit.to_string())
        .or_insert_with(|| rust_src_library(commit))
        .clone();
    match library.map(|lib| lib.join(rel)) {
        Some(mapped) if mapped.is_file() => mapped.to_string_lossy().into_owned(),
        _ => path.to_string(),
    }
}

/// `<toolchain>/lib/rustlib/src/rust/library` of the toolchain built from
/// `commit`, or of any toolchain with `rust-src`.
pub(super) fn rust_src_library(commit: &str) -> Option<PathBuf> {
    let rustup_home = std::env::var_os("RUSTUP_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".rustup")))?;
    let mut toolchains: Vec<PathBuf> = std::fs::read_dir(rustup_home.join("toolchains"))
        .ok()?
        .filter_map(|e| Some(e.ok()?.path()))
        .filter(|t| t.join("lib/rustlib/src/rust/library").is_dir())
        .collect();
    toolchains.sort();
    let built_from = |toolchain: &Path| {
        substrate_process::command(toolchain.join("bin/rustc"))
            .arg("-vV")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()
            .is_some_and(|out| {
                String::from_utf8_lossy(&out.stdout)
                    .lines()
                    .any(|l| l.strip_prefix("commit-hash: ") == Some(commit))
            })
    };
    let toolchain = toolchains
        .iter()
        .find(|t| built_from(t))
        .or(toolchains.first())?;
    Some(toolchain.join("lib/rustlib/src/rust/library"))
}

pub(super) fn tracer_send(state: &State<DebugState>, cmd: TracerCmd) -> bool {
    let guard = state.inner().0.locked();
    guard
        .as_ref()
        .and_then(|s| s.tracer.as_ref())
        .is_some_and(|tracer| tracer.send(cmd))
}

#[tauri::command]
pub fn debug_set_breakpoint(
    state: State<DebugState>,
    file: String,
    line: u32,
) -> Result<(), String> {
    {
        let mut breakpoints = BREAKPOINTS.locked();
        if !breakpoints.iter().any(|(f, l)| f == &file && *l == line) {
            breakpoints.push((file.clone(), line));
        }
    }
    // Errors from actually arming it surface in Output from the tracer
    // thread; with no session, remembering it above is all there is to do.
    tracer_send(&state, TracerCmd::SetBreakpoint { file, line });
    Ok(())
}

#[tauri::command]
pub fn debug_clear_breakpoint(
    state: State<DebugState>,
    file: String,
    line: u32,
) -> Result<(), String> {
    BREAKPOINTS
        .locked()
        .retain(|(f, l)| !(f == &file && *l == line));
    tracer_send(&state, TracerCmd::ClearBreakpoint { file, line });
    Ok(())
}

#[tauri::command]
pub fn debug_pause(state: State<DebugState>) -> Result<(), String> {
    if tracer_send(&state, TracerCmd::Pause) {
        Ok(())
    } else {
        Err("no active debug session".to_string())
    }
}

#[tauri::command]
pub fn debug_select_thread(state: State<DebugState>, thread: Tid) -> Result<(), String> {
    if tracer_send(&state, TracerCmd::SelectThread(thread)) {
        Ok(())
    } else {
        Err("no active debug session".to_string())
    }
}

/// Runs `query` on the tracer thread against the paused tracee and
/// returns its answer. Only answerable while paused — reading a running
/// thread's registers and memory would be meaningless anyway.
pub(super) async fn tracer_query<T: Send + 'static>(
    state: State<'_, DebugState>,
    query: impl FnOnce(&mut Tracer) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (reply, answer) = mpsc::channel();
    {
        let guard = state.inner().0.locked();
        let tracer = guard
            .as_ref()
            .and_then(|s| s.tracer.as_ref())
            .ok_or("no active debug session")?;
        if tracer.running.load(Ordering::SeqCst) {
            return Err("the game is running".to_string());
        }
        let cmd = TracerCmd::Inspect(Box::new(move |t: &mut Tracer| {
            let _ = reply.send(query(t));
        }));
        if !tracer.send(cmd) {
            return Err("no active debug session".to_string());
        }
    }
    // The first lookup parses the native's DWARF units, which can take a
    // moment for a large mod.
    tauri::async_runtime::spawn_blocking(move || {
        answer
            .recv_timeout(Duration::from_secs(20))
            .map_err(|_| "the debugger didn't answer".to_string())?
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Locals of frame `frame` (a `StackFrameOut::id`) of the thread the last
/// `debug-stopped` described, one level deep — expand rows with
/// `debug_children`.
#[tauri::command]
pub async fn debug_variables(
    state: State<'_, DebugState>,
    frame: usize,
) -> Result<Vec<VariableOut>, String> {
    tracer_query(state, move |t| t.variables(frame)).await
}

/// Watch expressions (and DataTips) evaluated in frame `frame`, one result
/// per expression, in order.
#[tauri::command]
pub async fn debug_evaluate(
    state: State<'_, DebugState>,
    frame: usize,
    exprs: Vec<String>,
) -> Result<Vec<WatchOut>, String> {
    tracer_query(state, move |t| t.evaluate(frame, &exprs)).await
}

/// The rows under an expandable row (`VariableOut::handle`) from the
/// current stop.
#[tauri::command]
pub async fn debug_children(
    state: State<'_, DebugState>,
    handle: u64,
) -> Result<Vec<VariableOut>, String> {
    tracer_query(state, move |t| t.children(handle)).await
}

#[tauri::command]
pub fn debug_continue(state: State<DebugState>) -> Result<(), String> {
    tracer_resume(&state, TracerCmd::Continue)
}

/// Continue/Step: rejected unless the tracer is paused (see
/// `TracerHandle::resume`).
pub(super) fn tracer_resume(state: &State<DebugState>, cmd: TracerCmd) -> Result<(), String> {
    let guard = state.inner().0.locked();
    guard
        .as_ref()
        .and_then(|s| s.tracer.as_ref())
        .ok_or("no active debug session")?
        .resume(cmd)
}

/// `kind`: `"over"` (F10, the default), `"into"` (F11) or `"out"`
/// (Shift+F11) — a source-level step, not a single instruction.
#[tauri::command]
pub fn debug_step(state: State<DebugState>, kind: Option<String>) -> Result<(), String> {
    let kind = match kind.as_deref() {
        None | Some("over") => StepKind::Over,
        Some("into") => StepKind::Into,
        Some("out") => StepKind::Out,
        Some(other) => return Err(format!("unknown step kind {other:?}")),
    };
    tracer_resume(&state, TracerCmd::Step(kind))
}
