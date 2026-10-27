//! A tracing session: started on the game, its thread, the failures it reports.

use substrate_lock::Locked;

use super::*;

/// An attached session's tracer gave up mid-session — reported as
/// `debug-failed` (not `debug-attach-failed`: the attach itself worked),
/// unless the session it belonged to is already over (Stop, the game
/// exiting, a newer run), where a late error from the dying
/// process is just noise — or the game itself is what went away, which
/// is an exit, not a failure.
pub(super) fn emit_session_failed(
    app: &AppHandle,
    session_id: u64,
    real_pid: i32,
    message: String,
) {
    let current = app
        .state::<DebugState>()
        .0
        .locked()
        .as_ref()
        .is_some_and(|s| s.id == session_id);
    if !current {
        return;
    }
    if yog_debugger::process_ended(real_pid as u32) {
        let _ = app.emit(
            crate::app::events::DEBUG_STOPPED,
            DebugStoppedEvent::exited(),
        );
        return;
    }
    let _ = app.emit(crate::app::events::DEBUG_FAILED, message.clone());
    let _ = app.emit(
        crate::app::events::OUTPUT_DEBUG,
        format!("[error] debugger: {message}"),
    );
}

/// Registers a `TracerHandle` on the session (so breakpoint toggles made
/// while attach is still in progress queue up instead of being lost) and
/// spawns the tracer thread itself.
pub(crate) fn start_tracer(
    app: &AppHandle,
    session_id: u64,
    real_pid: i32,
    mod_id: String,
    native_path: PathBuf,
) {
    let (tx, rx) = mpsc::channel();
    let running = Arc::new(AtomicBool::new(false));
    let paused = Arc::new(AtomicBool::new(false));
    let pause_request = Arc::new(AtomicBool::new(false));
    {
        let debug_state = app.state::<DebugState>();
        let mut guard = debug_state.0.locked();
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
        tracer_main(app, session_id, real_pid, mod_id, native_path, rx, flags)
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
pub(super) fn tracer_main(
    app: AppHandle,
    session_id: u64,
    real_pid: i32,
    mod_id: String,
    native_path: PathBuf,
    rx: Receiver<TracerCmd>,
    flags: TracerFlags,
) {
    let TracerFlags {
        running,
        paused,
        pause_request,
    } = flags;
    let mut tracer = match Tracer::attach(&app, real_pid, &mod_id, &native_path) {
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
    let _ = app.emit(crate::app::events::DEBUG_ATTACHED, real_pid);

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
