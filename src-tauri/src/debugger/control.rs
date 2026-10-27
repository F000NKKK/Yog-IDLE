//! Running the game under the IDE: the mod's id, the control connection, its events and the session's status.

use substrate_lock::Locked;

use super::*;

/// `[mod] id` of the mod at `root`.
pub(super) fn mod_id(root: &Path) -> Result<String, String> {
    crate::toolchain::cli::mod_id(root)
        .ok_or_else(|| format!("{} has no mod id", yog_ids::file::MANIFEST))
}

/// How long a write to the control socket may block.
pub(super) const CONTROL_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
/// How long a hot reload waits for the game's answer.
pub(super) const HOT_RELOAD_TIMEOUT: Duration = Duration::from_secs(60);

/// One request to the control socket, in a single write.
pub(super) fn send_control(control: &mut TcpStream, request: &Command) -> std::io::Result<()> {
    protocol::send(control, request)
}

/// The control channel's address: this machine only.
const LOOPBACK: &str = "127.0.0.1";
/// Port 0: the system picks a free one.
const ANY_PORT: u16 = 0;
/// How many random 64-bit words the token has.
const TOKEN_WORDS: u64 = 3;

/// Where the game's control channel listens and the token that opens it:
/// a free loopback port (bound and let go — the game binds it next), and
/// random bytes no other process has seen.
pub(super) fn control_endpoint() -> Result<(String, String), String> {
    let port = std::net::TcpListener::bind((LOOPBACK, ANY_PORT))
        .and_then(|l| l.local_addr())
        .map_err(|e| format!("no free port for the game's control channel: {e}"))?
        .port();
    // Std's hasher keys are seeded from the OS's randomness.
    use std::hash::{BuildHasher, Hasher};
    let token: String = (0..TOKEN_WORDS)
        .map(|i| {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u64(i);
            format!("{:016x}", h.finish())
        })
        .collect();
    Ok((format!("{LOOPBACK}:{port}"), token))
}

/// Runs `name` (`yog run <name> [--debug]`), always connecting the control
/// socket for live `game-status` events; if `mode == "debug"`, also
/// attaches `yog-debugger` the moment the socket's `ready` message arrives.
///
/// Returns as soon as the child is spawned — everything after that runs on
/// a background thread and reports back via `game-status`/`debug-attached`/
/// `debug-attach-failed` events. A command that instead blocked here on a
/// socket read that never arrives would hang Tauri's invoke call (and,
/// since its blocking-thread pool is bounded, eventually every *other*
/// command too) for as long as that read blocks.
pub fn run_with_mode(
    app: AppHandle,
    project_root: String,
    config_name: String,
    mode: String,
) -> Result<(), String> {
    let root = PathBuf::from(&project_root);
    let mod_id = mod_id(&root)?;
    let debug = mode == "debug";
    let native_path = local_native_path(&root, &mod_id);
    let (control_addr, control_token) = control_endpoint()?;

    let mut args = vec!["run".to_string(), config_name.clone()];
    // A Debug run is the one that hot-reloads (`--dev`); a Release run is
    // built as players get it, nothing of hot reload in it.
    if debug {
        args.push("--debug".to_string());
        args.push("--dev".to_string());
    }

    let diagnostics = crate::toolchain::diagnostics_feed::Feed::open(&app);
    let (feed_key, feed_path) = diagnostics.env();
    let (child, log) = crate::spawn_yog_run(
        crate::toolchain::cli::command()
            .args(&args)
            .current_dir(&root)
            .env(feed_key, feed_path)
            .env(yog_ids::env::CONTROL_SOCKET, &control_addr)
            .env(yog_ids::env::CONTROL_TOKEN, &control_token),
    )
    .map_err(|e| format!("failed to launch `yog run {config_name}`: {e}"))?;
    let output = crate::stream_yog_run(&app, log);

    let id = NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed);
    *app.state::<DebugState>().0.locked() = Some(RunSession {
        id,
        wrapper: child,
        _output: output,
        _diagnostics: diagnostics,
        real_pid: None,
        debug_mode: debug,
        control: None,
        reply_waiter: None,
        tracer: None,
    });
    let _ = app.emit(
        crate::app::events::GAME_STATUS,
        GameStatus {
            stage: "starting",
            pid: None,
            mods: Vec::new(),
        },
    );

    spawn_exit_watcher(app.clone(), id);
    let attach = Attach {
        mod_id,
        debug,
        native_path,
    };
    std::thread::spawn(move || connect_and_watch(app, id, control_addr, control_token, attach));
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GameStatus {
    pub(super) stage: &'static str,
    pub(super) pid: Option<i32>,
    pub(super) mods: Vec<ModInfo>,
}

/// Retries connecting to the control socket (the child needs a moment to
/// reach `nativeInit`), reads the `ready` line for the real pid directly —
/// no `/proc` walking at all — then keeps reading further event lines for
/// the rest of the session, translating each into a `game-status` event.
/// What a Debug run attaches the debugger to, once the game reports in.
pub(super) struct Attach {
    pub(super) mod_id: String,
    pub(super) debug: bool,
    pub(super) native_path: PathBuf,
}

pub(super) fn connect_and_watch(
    app: AppHandle,
    session_id: u64,
    addr: String,
    token: String,
    attach: Attach,
) {
    let debug = attach.debug;
    // No fixed deadline: before the game starts, `yog run` builds the mod
    // (and refreshes the others it exported), and Gradle may build the
    // runtime — minutes, not seconds. Waits for as long as the run lives.
    let alive = || {
        let state = app.state::<DebugState>();
        let guard = state.0.locked();
        guard.as_ref().is_some_and(|s| s.id == session_id)
    };
    let stream = loop {
        match TcpStream::connect(&addr) {
            Ok(s) => break Some(s),
            Err(_) if alive() => std::thread::sleep(Duration::from_millis(200)),
            Err(_) => break None,
        }
    };

    let Some(stream) = stream else {
        // The run ended before the game opened the socket (a failed build,
        // a crash at startup) — its own output says why.
        let _ = app.emit(
            crate::app::events::OUTPUT_DEBUG,
            "[warn] the run ended before the game opened its control socket — see the Build output"
                .to_string(),
        );
        if debug {
            emit_failed(
                &app,
                "the run ended before the game started — nothing to attach to",
            );
        }
        return;
    };

    // We're the launcher: the token says so, our pid is who may trace the game.
    let Ok((mut client, ready)) = protocol::Client::hello(stream, &token) else {
        return;
    };
    let Event::Ready { pid, mods, .. } = ready else {
        return;
    };
    let real_pid = pid as i32;

    {
        let debug_state = app.state::<DebugState>();
        let mut guard = debug_state.0.locked();
        match guard.as_mut() {
            Some(session) if session.id == session_id => {
                session.real_pid = Some(real_pid);
                session.control = client.stream().try_clone().ok();
                // Written under `DebugState`'s lock: a game that stops reading mustn't wedge every command.
                if let Some(control) = &session.control {
                    let _ = control.set_write_timeout(Some(CONTROL_WRITE_TIMEOUT));
                }
            }
            // Stopped (or restarted) before the game even reported in.
            _ => return,
        }
    }
    let _ = app.emit(
        crate::app::events::GAME_STATUS,
        GameStatus {
            stage: "ready",
            pid: Some(real_pid),
            mods,
        },
    );

    if debug {
        start_tracer(
            &app,
            session_id,
            real_pid,
            attach.mod_id,
            attach.native_path,
        );
    }

    // Keep reading further event lines for the rest of the session: a
    // refreshed mod list (`mods`) becomes another `game-status` "ready",
    // same shape as the `ready` handling above; `hot-reload-done` answers
    // whichever `hot_reload` call is waiting on it; anything else is just
    // echoed to Output. When the game process exits (however it
    // exits — the user closing the client themselves, a crash, Stop) the
    // OS closes its end of the socket, so this read loop ending is exactly
    // the "the game is gone" signal: emit it and clean up the session
    // instead of silently leaving stale state around (a manually-closed
    // client previously left Yog-IDLE with no idea anything had changed).
    while let Ok(Some(event)) = client.event() {
        handle_control_event(&app, session_id, real_pid, event);
    }
    mark_exited(&app, session_id);
}

/// One event from the game: the answer a request waits for, a refreshed
/// mod list, or Output's.
pub(super) fn handle_control_event(app: &AppHandle, session_id: u64, real_pid: i32, event: Event) {
    // An answer someone's waiting for.
    {
        let debug_state = app.state::<DebugState>();
        let mut guard = debug_state.0.locked();
        if let Some(session) = guard.as_mut().filter(|s| s.id == session_id)
            && session
                .reply_waiter
                .as_ref()
                .is_some_and(|(answers, _)| answers(&event))
            && let Some((_, waiter)) = session.reply_waiter.take()
        {
            let _ = waiter.send(event);
            return;
        }
    }
    match event {
        Event::Mods { mods } => {
            let _ = app.emit(
                crate::app::events::GAME_STATUS,
                GameStatus {
                    stage: "ready",
                    pid: Some(real_pid),
                    mods,
                },
            );
        }
        other => {
            let _ = app.emit(
                crate::app::events::OUTPUT_DEBUG,
                format!("[control] {other:?}"),
            );
        }
    }
}
