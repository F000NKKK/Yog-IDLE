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

mod process;
pub(crate) use process::*;
mod session;
pub(crate) use session::*;
mod tracer;
mod commands;
pub use commands::*;

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
