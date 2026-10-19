//! The native debugger (Linux: `ptrace`): attaching to the game a
//! Debug run started, breakpoints, stepping, variables.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::mpsc::Receiver;

use nix::sys::signal::Signal;
use nix::unistd::Pid;
use yog_debugger::{Debugger, SourceBreakpoints, StepKind, StopReason, is_library_source};
use yog_hot_reload::{GenerationAllocator, ModuleGeneration};
use yog_symbols::{FrameRegs, SymbolTable, TargetMemory, ValueNode, ValueRef};

use super::*;

/// Everything the tracer thread owns for one attached debug session — see
/// `tracer_main`. Never leaves that thread.
pub(super) struct Tracer {
    debugger: Debugger,
    native_path: PathBuf,
    symbols: SymbolTable,
    module_base: u64,
    mod_id: String,
    /// One per load of the mod's native seen by this session — the initial
    /// attach, then each successful hot reload — so `SourceBreakpoints` can
    /// tell which load every breakpoint was last resolved against.
    generations: GenerationAllocator,
    generation: ModuleGeneration,
    breakpoints: SourceBreakpoints,
    /// Why the tracee last stopped — re-reported when the user switches
    /// threads, so the UI keeps showing "breakpoint" rather than a new stop.
    last_stop: StopReason,
    /// Expandable values handed out (`VariableOut::handle`) since the
    /// tracee last stopped — they name places in its memory, so they're
    /// dropped as soon as it runs again (or the native is reloaded).
    values: HashMap<u64, ValueRef>,
    next_value: u64,
}

/// A request for the tracer thread. Breakpoint edits are applied whether
/// the tracee is paused or running (a running one is briefly interrupted —
/// see `TracerHandle::send`); `Continue`/`Step` only mean anything while
/// it's paused.
pub(super) enum TracerCmd {
    SetBreakpoint {
        file: String,
        line: u32,
    },
    ClearBreakpoint {
        file: String,
        line: u32,
    },
    Continue,
    Step(StepKind),
    /// Break All: stop the running game wherever it is.
    Pause,
    /// Inspect another (stopped) thread: re-emits `debug-stopped` with its
    /// stack and registers.
    SelectThread(i32),
    /// The runtime just hot-reloaded the mod: reload symbols from the
    /// freshly built native and re-resolve every breakpoint against them.
    Rebind,
    /// A read-only look at the paused tracee (locals, watch expressions,
    /// expanding a value) — see `tracer_query`.
    Inspect(Box<dyn FnOnce(&mut Tracer) + Send>),
    /// Yog-IDLE is exiting: take every breakpoint out and let the game run
    /// on untraced, then say so on `done`.
    Detach {
        done: Sender<()>,
    },
}

/// The state `TracerHandle` shares with its tracer thread.
struct TracerFlags {
    running: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    pause_request: Arc<AtomicBool>,
}

#[derive(Clone, Copy)]
enum Resume {
    Continue,
    Step(StepKind),
}

/// The rest of the app's way to reach a debug-mode run's tracer thread.
pub(super) struct TracerHandle {
    tx: Sender<TracerCmd>,
    pid: i32,
    /// `true` while the tracee is executing a Continue or a step and the
    /// tracer thread is blocked in `waitpid` — the only state in which it
    /// can't pick up a command on its own.
    running: Arc<AtomicBool>,
    /// `true` while the tracer is parked waiting for the user — the only
    /// time a Continue/Step is accepted (see `TracerHandle::resume`).
    paused: Arc<AtomicBool>,
    /// Raised with a Pause sent while running, so a step in progress gives
    /// up for it (`Debugger::set_pause_request`) instead of absorbing it
    /// like a breakpoint edit's interrupt.
    pause_request: Arc<AtomicBool>,
}

impl TracerHandle {
    /// Queues `cmd`; if it's one that has to take effect *now* (a
    /// breakpoint edit) and the tracee is running, also interrupts it so
    /// the tracer's `waitpid` returns and it can drain its queue —
    /// `tracer_main` gets `StopReason::Interrupted` and resumes straight
    /// afterward. Returns `false` once the tracer thread is gone.
    pub(super) fn send(&self, cmd: TracerCmd) -> bool {
        let urgent = matches!(
            cmd,
            TracerCmd::SetBreakpoint { .. }
                | TracerCmd::ClearBreakpoint { .. }
                | TracerCmd::Rebind
                | TracerCmd::Pause
                | TracerCmd::Detach { .. }
        );
        let pause = matches!(cmd, TracerCmd::Pause);
        if self.tx.send(cmd).is_err() {
            return false;
        }
        if urgent && self.running.load(Ordering::SeqCst) {
            if pause {
                self.pause_request.store(true, Ordering::SeqCst);
            }
            yog_debugger::ptrace_debugger::interrupt(self.pid);
        }
        true
    }

    /// Queues a Continue/Step — only while the tracer is paused waiting for
    /// one, and only one per pause: a held-down F10 must not pile up steps
    /// that then run back to back (or after a step that turned into a free
    /// run) long after the key was let go.
    pub(super) fn resume(&self, cmd: TracerCmd) -> Result<(), String> {
        if self
            .paused
            .compare_exchange(true, false, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("not paused".to_string());
        }
        self.tx
            .send(cmd)
            .map_err(|_| "no active debug session".to_string())
    }
}




/// One row of the Locals/Watch/Autos views and DataTips — a
/// `yog_symbols::ValueNode`. `children` is only ever filled for an eagerly
/// read tree; rows with a `handle` are expanded on demand with
/// `debug_children`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VariableOut {
    pub name: String,
    pub type_name: String,
    pub value: String,
    pub children: Vec<VariableOut>,
    /// An expression that evaluates back to this row ("Add Watch").
    pub expr: String,
    /// Set when the row can be expanded: pass to `debug_children` while
    /// the tracee is still paused at the same stop.
    pub handle: Option<u64>,
}

/// One watch expression's result: a row, or why there isn't one.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchOut {
    pub value: Option<VariableOut>,
    pub error: Option<String>,
}

/// The tracee's memory through `/proc/<pid>/mem` — readable by its tracer
/// while it's stopped, and far cheaper than a word-at-a-time `PTRACE_PEEKDATA`.
struct ProcMem(std::fs::File);

impl ProcMem {
    fn open(pid: Pid) -> Result<Self, String> {
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
fn is_game_thread(name: &str) -> bool {
    matches!(name, "Render thread" | "Server thread")
}

fn to_snake_name(id: &str) -> String {
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
pub(super) fn local_native_path(project_root: &Path, mod_id: &str) -> PathBuf {
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
fn find_latest_module_base(pid: Pid, mod_id: &str) -> Option<u64> {
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


/// An attached session's tracer gave up mid-session — reported as
/// `debug-failed` (not `debug-attach-failed`: the attach itself worked),
/// unless the session it belonged to is already over (Stop, the game
/// exiting, a newer run), where a late `ptrace` error from the dying
/// process is just noise — or the game itself is what went away, which
/// is an exit, not a failure.
fn emit_session_failed(app: &AppHandle, session_id: u64, real_pid: i32, message: String) {
    let current = app
        .state::<DebugState>()
        .0
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|s| s.id == session_id);
    if !current {
        return;
    }
    if process_gone(real_pid) {
        let _ = app.emit(crate::events::DEBUG_STOPPED, DebugStoppedEvent::exited());
        return;
    }
    let _ = app.emit(crate::events::DEBUG_FAILED, message.clone());
    let _ = app.emit(
        crate::events::OUTPUT_DEBUG,
        format!("[error] debugger: {message}"),
    );
}

/// Whether `pid` has exited (or is only a zombie left to be reaped).
fn process_gone(pid: i32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat")).map_or(true, |stat| {
        stat.rsplit_once(')')
            .and_then(|(_, rest)| rest.trim_start().chars().next())
            .is_none_or(|state| matches!(state, 'Z' | 'X'))
    })
}


/// Registers a `TracerHandle` on the session (so breakpoint toggles made
/// while attach is still in progress queue up instead of being lost) and
/// spawns the tracer thread itself.
pub(super) fn start_tracer(
    app: &AppHandle,
    session_id: u64,
    real_pid: i32,
    mod_id: String,
    native_path: PathBuf,
    ptracer: Option<bool>,
) {
    let (tx, rx) = mpsc::channel();
    let running = Arc::new(AtomicBool::new(false));
    let paused = Arc::new(AtomicBool::new(false));
    let pause_request = Arc::new(AtomicBool::new(false));
    {
        let debug_state = app.state::<DebugState>();
        let mut guard = debug_state.0.lock().unwrap();
        match guard.as_mut() {
            Some(session) if session.id == session_id => {
                session.tracer = Some(TracerHandle {
                    tx,
                    pid: real_pid,
                    running: running.clone(),
                    paused: paused.clone(),
                    pause_request: pause_request.clone(),
                });
            }
            _ => return,
        }
    }
    let app = app.clone();
    let flags = TracerFlags {
        running,
        paused,
        pause_request,
    };
    std::thread::spawn(move || {
        tracer_main(
            app,
            session_id,
            real_pid,
            mod_id,
            native_path,
            ptracer,
            rx,
            flags,
        )
    });
}

/// The one thread that ever touches the tracee. Linux `ptrace` binds a
/// tracee to the *thread* that attached, not the process — every later
/// `PTRACE_*` request from any other thread fails with `ESRCH` — so attach,
/// breakpoint edits, continue/step, and backtraces all have to run here,
/// fed by `TracerCmd`s, rather than on whichever Tauri command thread
/// happened to ask.
///
/// `Debugger::attach` leaves the tracee stopped (attach + `waitpid`), so
/// right after arming breakpoints this resumes it — otherwise the game
/// would sit frozen with nothing in the UI able to continue it.
#[allow(clippy::too_many_arguments)]
fn tracer_main(
    app: AppHandle,
    session_id: u64,
    real_pid: i32,
    mod_id: String,
    native_path: PathBuf,
    ptracer: Option<bool>,
    rx: Receiver<TracerCmd>,
    flags: TracerFlags,
) {
    let TracerFlags {
        running,
        paused,
        pause_request,
    } = flags;
    let mut tracer = match Tracer::attach(&app, real_pid, &mod_id, &native_path, ptracer) {
        Ok(t) => t,
        Err(e) => {
            emit_failed(&app, e);
            return;
        }
    };
    tracer.debugger.set_pause_request(pause_request.clone());
    // Anything toggled while attach was in progress — already reflected in
    // `BREAKPOINTS` (and therefore armed above) or not, applying it again
    // is idempotent.
    while let Ok(cmd) = rx.try_recv() {
        tracer.apply(&app, cmd);
    }
    let _ = app.emit(crate::events::DEBUG_ATTACHED, real_pid);

    let mut resume = Some(Resume::Continue);
    loop {
        if let Some(kind) = resume.take() {
            tracer.values.clear();
            let result = match kind {
                Resume::Continue => {
                    running.store(true, Ordering::SeqCst);
                    let result = tracer.debugger.continue_();
                    running.store(false, Ordering::SeqCst);
                    result
                }
                // A step can turn into a free run (stepping off the end of
                // the mod's code continues to the next breakpoint), so it
                // must be interruptible for Pause/breakpoint edits too.
                Resume::Step(step) => {
                    running.store(true, Ordering::SeqCst);
                    let result =
                        tracer
                            .debugger
                            .source_step(step, &tracer.symbols, tracer.module_base);
                    running.store(false, Ordering::SeqCst);
                    result
                }
            };
            match result {
                // Our own interrupt (see `TracerHandle::send`): apply what
                // was queued and carry on with whatever was in progress.
                Ok(StopReason::Interrupted) => {
                    let mut pause = pause_request.swap(false, Ordering::SeqCst);
                    while let Ok(cmd) = rx.try_recv() {
                        match cmd {
                            TracerCmd::Pause => pause = true,
                            cmd => tracer.apply(&app, cmd),
                        }
                    }
                    // Detached (Yog-IDLE exiting): nothing left to run.
                    if tracer.debugger.threads().is_empty() {
                        return;
                    }
                    if !pause {
                        // A step only lets an edit's interrupt through once
                        // it has turned into a free run (stepping off the
                        // end of the mod's code back into Java), and what's
                        // left of it is that run — its thread may be long
                        // gone, so it can't be stepped again.
                        resume = Some(Resume::Continue);
                        continue;
                    }
                    if let Err(e) = tracer.debugger.pause() {
                        emit_session_failed(&app, session_id, real_pid, e.to_string());
                        break;
                    }
                    tracer.select_interesting_thread();
                    tracer.last_stop = StopReason::Interrupted;
                    tracer.emit_stop(&app, StopReason::Interrupted);
                }
                Ok(reason) => {
                    let exited = matches!(reason, StopReason::Exited(_) | StopReason::Killed(_));
                    tracer.last_stop = reason.clone();
                    tracer.emit_stop(&app, reason);
                    if exited {
                        return;
                    }
                }
                Err(e) => {
                    emit_session_failed(&app, session_id, real_pid, e.to_string());
                    break;
                }
            }
        }
        // Paused — wait for the user. The channel closing means the
        // session itself is gone (Stop, or the game exiting). A Pause that
        // raced the stop is moot now.
        pause_request.store(false, Ordering::SeqCst);
        paused.store(true, Ordering::SeqCst);
        match rx.recv() {
            Ok(TracerCmd::Continue) => resume = Some(Resume::Continue),
            Ok(TracerCmd::Step(step)) => resume = Some(Resume::Step(step)),
            Ok(cmd) => tracer.apply(&app, cmd),
            Err(_) => break,
        }
    }
    let _ = tracer.debugger.detach();
}

impl Tracer {
    fn attach(
        app: &AppHandle,
        real_pid: i32,
        mod_id: &str,
        native_path: &Path,
        ptracer: Option<bool>,
    ) -> Result<Self, String> {
        let symbols = SymbolTable::load(native_path)
            .map_err(|e| format!("loading symbols from {}: {e}", native_path.display()))?;
        let mut debugger = Debugger::attach(real_pid).map_err(|e| {
            let raw = e.to_string();
            if raw.contains("EPERM") {
                permission_denied_message(real_pid, ptracer)
            } else {
                format!("attaching to pid {real_pid}: {raw}")
            }
        })?;
        debugger.set_pause_filter(is_game_thread);
        let Some(module_base) = find_latest_module_base(debugger.pid(), mod_id) else {
            // Attached but unusable — let the game go rather than leaving
            // it stopped.
            let _ = debugger.detach();
            return Err(format!(
                "couldn't locate {mod_id}'s native in pid {real_pid}'s memory map"
            ));
        };

        let generations = GenerationAllocator::new();
        let mut tracer = Tracer {
            debugger,
            native_path: native_path.to_path_buf(),
            symbols,
            module_base,
            mod_id: mod_id.to_string(),
            generation: generations.next(),
            generations,
            breakpoints: SourceBreakpoints::new(),
            last_stop: StopReason::Signal(Signal::SIGSTOP),
            values: HashMap::new(),
            next_value: 1,
        };
        for (file, line) in BREAKPOINTS.lock().unwrap().clone() {
            tracer.set_breakpoint(app, file, line);
        }
        Ok(tracer)
    }

    fn apply(&mut self, app: &AppHandle, cmd: TracerCmd) {
        match cmd {
            TracerCmd::SetBreakpoint { file, line } => self.set_breakpoint(app, file, line),
            TracerCmd::ClearBreakpoint { file, line } => {
                if let Err(e) =
                    self.breakpoints
                        .clear(&mut self.debugger, &self.mod_id, &file, line)
                {
                    warn(app, format!("clearing breakpoint {file}:{line}: {e}"));
                }
            }
            TracerCmd::Rebind => {
                if let Err(e) = self.rebind() {
                    warn(app, format!("re-binding breakpoints after hot reload: {e}"));
                }
            }
            // Only meaningful while paused, where `tracer_main` handles
            // them itself — one arriving mid-run is a stale double-click.
            TracerCmd::SelectThread(tid) => match self.debugger.select_thread(Pid::from_raw(tid)) {
                Ok(()) => self.emit_stop(app, self.last_stop.clone()),
                Err(e) => warn(app, format!("selecting thread {tid}: {e}")),
            },
            TracerCmd::Inspect(query) => query(self),
            TracerCmd::Detach { done } => {
                let _ = self.debugger.detach();
                let _ = done.send(());
            }
            // Already paused (a Pause racing a breakpoint hit) — nothing to do.
            TracerCmd::Pause => {}
            TracerCmd::Continue | TracerCmd::Step(_) => {}
        }
    }

    fn rebind(&mut self) -> Result<(), String> {
        let symbols = SymbolTable::load(&self.native_path)
            .map_err(|e| format!("loading symbols from {}: {e}", self.native_path.display()))?;
        let module_base = find_latest_module_base(self.debugger.pid(), &self.mod_id)
            .ok_or_else(|| format!("couldn't locate {}'s reloaded native", self.mod_id))?;
        let generation = self.generations.next();
        self.breakpoints
            .rebind_after_reload(
                &mut self.debugger,
                &self.mod_id,
                generation,
                module_base,
                &symbols,
            )
            .map_err(|e| e.to_string())?;
        self.symbols = symbols;
        self.values.clear();
        self.module_base = module_base;
        self.generation = generation;
        Ok(())
    }

    /// Arms `file:line` unless it's already tracked (`SourceBreakpoints`
    /// itself would happily track a duplicate), reporting both outright
    /// failures and lines that don't map to any code in the native.
    fn set_breakpoint(&mut self, app: &AppHandle, file: String, line: u32) {
        if self
            .breakpoints
            .all()
            .iter()
            .any(|bp| bp.file == file && bp.line == line)
        {
            return;
        }
        match self.breakpoints.set(
            &mut self.debugger,
            &self.mod_id,
            self.generation,
            self.module_base,
            &self.symbols,
            &file,
            line,
        ) {
            Err(e) => warn(app, format!("setting breakpoint {file}:{line}: {e}")),
            Ok(()) => {
                if self
                    .breakpoints
                    .all()
                    .last()
                    .is_some_and(|bp| bp.addr.is_none())
                {
                    warn(
                        app,
                        format!(
                            "breakpoint {file}:{line} doesn't map to any code in {}'s native — it won't be hit",
                            self.mod_id
                        ),
                    );
                }
            }
        }
    }

    /// After a pause, show a thread that's actually in the mod's own code
    /// if there is one; otherwise the main thread.
    fn select_interesting_thread(&mut self) {
        for tid in self.debugger.threads() {
            if self.debugger.select_thread(tid).is_ok()
                && self
                    .stack_trace()
                    .iter()
                    .any(|f| !is_library_source(Path::new(&f.file)))
            {
                return;
            }
        }
        let _ = self.debugger.select_thread(self.debugger.pid());
    }

    /// The selected thread's physical frames, unwound by CFI — through
    /// `std`, which keeps no frame pointers.
    fn frames(&self) -> Vec<FrameRegs> {
        self.debugger
            .backtrace_with(&self.symbols, self.module_base, 64)
            .unwrap_or_default()
    }

    /// Every frame in the mod's native — user code and the `std` statically
    /// linked into it — innermost first, with inlined calls as frames of
    /// their own. `id` encodes the physical frame (see `FRAME_ID_STRIDE`);
    /// `std`'s `/rustc/<commit>/...` paths point into the local `rust-src`.
    fn stack_trace(&self) -> Vec<StackFrameOut> {
        let mut out = Vec::new();
        for (i, regs) in self.frames().iter().enumerate() {
            let Some(offset) = regs.pc().checked_sub(self.module_base) else {
                continue;
            };
            for (j, location) in self.symbols.resolve_inlined(offset).into_iter().enumerate() {
                if location.line == 0 || j >= FRAME_ID_STRIDE {
                    continue;
                }
                out.push(StackFrameOut {
                    id: (i * FRAME_ID_STRIDE + j) as i64,
                    name: location.function.unwrap_or_else(|| "<unknown>".to_string()),
                    file: map_rust_src(&location.file.to_string_lossy()),
                    line: location.line,
                });
            }
        }
        out
    }

    /// The registers of the selected thread's frame `frame` (a
    /// `stack_trace` id) and the index of the function instance at its pc
    /// the id names — an inlined call's caller shows its own variables,
    /// not the callee's. The innermost frame has every register; outer
    /// ones have what CFI recovered (`rsp`, `rip` and the callee-saved
    /// registers), so variables kept in other registers read as
    /// `<unavailable>`.
    fn frame_regs(&self, frame: usize) -> Result<(FrameRegs, usize), String> {
        let frames = self.frames();
        let regs = frames
            .get(frame / FRAME_ID_STRIDE)
            .ok_or_else(|| format!("frame {frame} is past the end of the stack"))?;
        Ok((regs.clone(), frame % FRAME_ID_STRIDE))
    }

    /// A row for the UI, remembering its expandable value under a handle.
    fn row(&mut self, node: ValueNode) -> VariableOut {
        let handle = node.children.map(|value| {
            let id = self.next_value;
            self.next_value += 1;
            self.values.insert(id, value);
            id
        });
        VariableOut {
            name: node.name,
            type_name: node.type_name,
            value: node.value,
            children: Vec::new(),
            expr: node.expr,
            handle,
        }
    }

    /// Locals of the selected thread's frame `frame`, one level at a time.
    fn variables(&mut self, frame: usize) -> Result<Vec<VariableOut>, String> {
        let mem = ProcMem::open(self.debugger.pid())?;
        let (regs, inline) = self.frame_regs(frame)?;
        let nodes = self
            .symbols
            .local_nodes(&regs, self.module_base, &mem, inline);
        Ok(nodes.into_iter().map(|n| self.row(n)).collect())
    }

    /// Watch expressions evaluated in frame `frame`.
    fn evaluate(&mut self, frame: usize, exprs: &[String]) -> Result<Vec<WatchOut>, String> {
        let mem = ProcMem::open(self.debugger.pid())?;
        let (regs, inline) = self.frame_regs(frame)?;
        Ok(exprs
            .iter()
            .map(|expr| {
                match self
                    .symbols
                    .evaluate(expr, &regs, self.module_base, &mem, inline)
                {
                    Ok(node) => WatchOut {
                        value: Some(self.row(node)),
                        error: None,
                    },
                    Err(e) => WatchOut {
                        value: None,
                        error: Some(e.to_string()),
                    },
                }
            })
            .collect())
    }

    /// The rows under an expandable row from this same stop.
    fn children(&mut self, handle: u64) -> Result<Vec<VariableOut>, String> {
        let value = self
            .values
            .get(&handle)
            .cloned()
            .ok_or("the value is no longer available — the game has run since")?;
        let mem = ProcMem::open(self.debugger.pid())?;
        let nodes = self.symbols.expand(&value, &mem);
        Ok(nodes.into_iter().map(|n| self.row(n)).collect())
    }

    fn emit_stop(&self, app: &AppHandle, reason: StopReason) {
        let reason_str = match reason {
            StopReason::Breakpoint(_) => "breakpoint",
            StopReason::Signal(Signal::SIGTRAP) => "step",
            StopReason::Interrupted => "pause",
            StopReason::Signal(_) => "signal",
            StopReason::Exited(_) | StopReason::Killed(_) => "exited",
        };
        let exited = reason_str == "exited";
        let pid = self.debugger.pid();
        let thread = self.debugger.current_thread();
        let threads = if exited {
            Vec::new()
        } else {
            self.debugger
                .threads()
                .into_iter()
                .map(|tid| ThreadOut {
                    id: tid.as_raw(),
                    name: yog_debugger::thread_name(pid, tid),
                    stopped: self.debugger.is_stopped(tid),
                })
                .collect()
        };
        let registers = match self.debugger.registers() {
            Ok(r) if !exited => [
                ("rip", r.rip),
                ("rsp", r.rsp),
                ("rbp", r.rbp),
                ("rax", r.rax),
                ("rbx", r.rbx),
                ("rcx", r.rcx),
                ("rdx", r.rdx),
                ("rsi", r.rsi),
                ("rdi", r.rdi),
                ("r8", r.r8),
                ("r9", r.r9),
                ("r10", r.r10),
                ("r11", r.r11),
                ("r12", r.r12),
                ("r13", r.r13),
                ("r14", r.r14),
                ("r15", r.r15),
                ("eflags", r.eflags),
            ]
            .into_iter()
            .map(|(name, value)| (name.to_string(), format!("{value:#018x}")))
            .collect(),
            _ => Vec::new(),
        };
        let _ = app.emit(
            crate::events::DEBUG_STOPPED,
            DebugStoppedEvent {
                reason: reason_str.to_string(),
                stack_trace: if exited {
                    Vec::new()
                } else {
                    self.stack_trace()
                },
                threads,
                thread: thread.as_raw(),
                registers,
            },
        );
    }
}

fn warn(app: &AppHandle, message: String) {
    let _ = app.emit(crate::events::OUTPUT_DEBUG, format!("[warn] {message}"));
}

/// Mirrors the editor gutter: every breakpoint the user currently has set,
/// whether or not a debug session is attached — kept in sync on every
/// toggle (deduplicated), so a session attaching later (or a second one
/// after Restart) arms exactly what the gutter shows, same as any IDE lets
/// you set breakpoints before pressing Start.
static BREAKPOINTS: Mutex<Vec<(String, u32)>> = Mutex::new(Vec::new());

/// `StackFrameOut::id` = physical frame * this + inline depth.
const FRAME_ID_STRIDE: usize = 64;

/// `std`'s DWARF paths (`/rustc/<commit>/library/...`) mapped into an
/// installed `rust-src`: the toolchain whose `rustc` was built from that
/// commit, else any toolchain that has `rust-src`. Unchanged when nothing
/// matches (the UI then suggests installing `rust-src`).
fn map_rust_src(path: &str) -> String {
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
        .lock()
        .unwrap()
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
fn rust_src_library(commit: &str) -> Option<PathBuf> {
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
        substrate_platform::process::command(toolchain.join("bin/rustc"))
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

fn tracer_send(state: &State<DebugState>, cmd: TracerCmd) -> bool {
    let guard = state.inner().0.lock().unwrap();
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
        let mut breakpoints = BREAKPOINTS.lock().unwrap();
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
        .lock()
        .unwrap()
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
pub fn debug_select_thread(state: State<DebugState>, thread: i32) -> Result<(), String> {
    if tracer_send(&state, TracerCmd::SelectThread(thread)) {
        Ok(())
    } else {
        Err("no active debug session".to_string())
    }
}

/// Runs `query` on the tracer thread against the paused tracee and
/// returns its answer. Only answerable while paused — reading a running
/// thread's registers and memory would be meaningless anyway.
async fn tracer_query<T: Send + 'static>(
    state: State<'_, DebugState>,
    query: impl FnOnce(&mut Tracer) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (reply, answer) = mpsc::channel();
    {
        let guard = state.inner().0.lock().unwrap();
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
fn tracer_resume(state: &State<DebugState>, cmd: TracerCmd) -> Result<(), String> {
    let guard = state.inner().0.lock().unwrap();
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

/// Why an attach got `EPERM`, and the one thing that fixes it here. Yama
/// (`kernel.yama.ptrace_scope`) only lets a process trace its descendants,
/// and the game isn't one of ours — Gradle's daemon launches it. The
/// runtime lifts that for us when we connect (`PR_SET_PTRACER`, reported as
/// `ready.ptracer`); the messages start with a stable tag the Debug panel
/// keys its actions on.
fn permission_denied_message(pid: i32, ptracer: Option<bool>) -> String {
    let scope = std::fs::read_to_string("/proc/sys/kernel/yama/ptrace_scope")
        .ok()
        .and_then(|s| s.trim().parse::<u8>().ok());
    match (ptracer, scope) {
        (_, Some(3)) => format!(
            "[ptrace-disabled] attaching to pid {pid}: permission denied — ptrace is disabled on this system \
             (kernel.yama.ptrace_scope = 3) until the next reboot; no debugger can attach."
        ),
        (None, Some(0 | 1) | None) => format!(
            "[runtime-outdated] attaching to pid {pid}: permission denied — this game runs a yog-runtime from \
             before it let the IDE trace it (PR_SET_PTRACER). Rebuild the runtime (`./build.sh build rust` in \
             Yog-Mod-Loader, or `./dev.sh`) and launch again."
        ),
        _ => format!(
            "[needs-capability] attaching to pid {pid}: permission denied — kernel.yama.ptrace_scope = {} here, \
             which only lets privileged processes trace. Grant Yog-IDLE the ptrace capability (once), restart it, \
             and launch again.",
            scope.map_or_else(|| "?".to_string(), |s| s.to_string())
        ),
    }
}

/// A capability can only be granted to a binary's on-disk file (checked at
/// `exec()` time) by something already privileged — a running process can
/// never grant *itself* one. So this is the one-time, user-initiated setup
/// step for attaching without needing `ptrace_scope` set to 0 system-wide:
/// `pkexec` (Polkit's graphical sudo-equivalent, standard on GNOME/KDE)
/// prompts for elevation once, then `setcap` stamps `cap_sys_ptrace+ep`
/// onto Yog-IDLE's own executable so every future launch already has it,
/// no repeated prompts. Never called implicitly — only in direct response
/// to the user asking for it (e.g. a "Grant ptrace access" action shown
/// after an `EPERM` attach failure).
#[tauri::command]
pub fn debug_grant_ptrace_capability() -> Result<(), String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("couldn't determine Yog-IDLE's own executable path: {e}"))?;
    let status = substrate_platform::process::command("pkexec")
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
