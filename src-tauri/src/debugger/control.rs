//! Running the game under the IDE: the mod's id, the control connection, its events and the session's status.

use substrate_platform::sync::Locked;
use super::*;

/// `[mod] id` of the mod at `root`.
pub(super) fn mod_id(root: &Path) -> Result<String, String> {
    crate::cli::mod_id(root).ok_or_else(|| format!("{} has no mod id", yog_ids::file::MANIFEST))
}

/// How long a write to the control socket may block.
pub(super) const CONTROL_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
/// How long a hot reload waits for the game's answer.
pub(super) const HOT_RELOAD_TIMEOUT: Duration = Duration::from_secs(60);

/// One request line to the control socket, in a single write.
pub(super) fn send_control(control: &mut TcpStream, request: &serde_json::Value) -> std::io::Result<()> {
    let mut line = request.to_string();
    line.push('\n');
    control.write_all(line.as_bytes())
}

/// Where the game's control channel listens and the token that opens it:
/// a free loopback port (bound and let go — the game binds it next), and
/// random bytes no other process has seen.
pub(super) fn control_endpoint() -> Result<(String, String), String> {
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map_err(|e| format!("no free port for the game's control channel: {e}"))?
        .port();
    // Std's hasher keys are seeded from the OS's randomness.
    use std::hash::{BuildHasher, Hasher};
    let token: String = (0..3)
        .map(|i| {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u64(i);
            format!("{:016x}", h.finish())
        })
        .collect();
    Ok((format!("127.0.0.1:{port}"), token))
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
    #[cfg(target_os = "linux")]
    let native_path = local_native_path(&root, &mod_id);
    let (control_addr, control_token) = control_endpoint()?;

    let mut args = vec!["run".to_string(), config_name.clone()];
    // A Debug run is the one that hot-reloads (`--dev`); a Release run is
    // built as players get it, nothing of hot reload in it.
    if debug {
        args.push("--debug".to_string());
        args.push("--dev".to_string());
    }

    let (child, log) = crate::spawn_yog_run(
        crate::cli::command()
            .args(&args)
            .current_dir(&root)
            .env("YOG_CONTROL_SOCKET", &control_addr)
            .env("YOG_CONTROL_TOKEN", &control_token),
    )
    .map_err(|e| format!("failed to launch `yog run {config_name}`: {e}"))?;
    let output = crate::stream_yog_run(&app, log);

    let id = NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed);
    *app.state::<DebugState>().0.locked() = Some(RunSession {
        id,
        wrapper: child,
        _output: output,
        real_pid: None,
        debug_mode: debug,
        control: None,
        reply_waiter: None,
        #[cfg(target_os = "linux")]
        tracer: None,
    });
    let _ = app.emit(
        crate::events::GAME_STATUS,
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
        #[cfg(target_os = "linux")]
        native_path,
    };
    std::thread::spawn(move || connect_and_watch(app, id, control_addr, control_token, attach));
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ModInfoOut {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) version: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GameStatus {
    pub(super) stage: &'static str,
    pub(super) pid: Option<i32>,
    pub(super) mods: Vec<ModInfoOut>,
}

/// Retries connecting to the control socket (the child needs a moment to
/// reach `nativeInit`), reads the `ready` line for the real pid directly —
/// no `/proc` walking at all — then keeps reading further event lines for
/// the rest of the session, translating each into a `game-status` event.
/// What a Debug run attaches the debugger to, once the game reports in.
pub(super) struct Attach {
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub(super) mod_id: String,
    pub(super) debug: bool,
    #[cfg(target_os = "linux")]
    pub(super) native_path: PathBuf,
}

pub(super) fn connect_and_watch(app: AppHandle, session_id: u64, addr: String, token: String, attach: Attach) {
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
            crate::events::OUTPUT_DEBUG,
            "[warn] the run ended before the game opened its control socket — see the Build output".to_string(),
        );
        if debug {
            emit_failed(
                &app,
                "the run ended before the game started — nothing to attach to",
            );
        }
        return;
    };

    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    });
    // We're the launcher: the token says so, our pid is who may trace the game.
    let mut hello_stream = match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };
    if send_control(&mut hello_stream, &serde_json::json!({ "cmd": "hello", "token": token, "pid": std::process::id() })).is_err() {
        return;
    }

    let mut line = String::new();
    if reader.read_line(&mut line).unwrap_or(0) == 0 {
        return;
    }
    let Ok(ready) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
        return;
    };
    let Some(real_pid) = ready.get("pid").and_then(|v| v.as_i64()).map(|v| v as i32) else {
        return;
    };
    let mods = parse_mods(&ready);
    // Whether the runtime handed us `PR_SET_PTRACER` — absent from runtimes
    // that predate it, which is what an `EPERM` attach then means.
    let ptracer = ready.get("ptracer").and_then(|v| v.as_bool());

    {
        let debug_state = app.state::<DebugState>();
        let mut guard = debug_state.0.locked();
        match guard.as_mut() {
            Some(session) if session.id == session_id => {
                session.real_pid = Some(real_pid);
                session.control = stream.try_clone().ok();
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
        crate::events::GAME_STATUS,
        GameStatus {
            stage: "ready",
            pid: Some(real_pid),
            mods,
        },
    );

    #[cfg(target_os = "linux")]
    if debug {
        start_tracer(&app, session_id, real_pid, attach.mod_id, attach.native_path, ptracer);
    }
    #[cfg(not(target_os = "linux"))]
    let _ = ptracer;

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
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                if let Ok(event) = serde_json::from_str::<serde_json::Value>(line.trim()) {
                    handle_control_event(&app, session_id, real_pid, &event, line.trim());
                }
            }
        }
    }
    mark_exited(&app, session_id);
}

pub(super) fn parse_mods(message: &serde_json::Value) -> Vec<ModInfoOut> {
    let field = |m: &serde_json::Value, key: &str| {
        m.get(key)
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string()
    };
    message
        .get("mods")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|m| ModInfoOut {
                    id: field(m, "id"),
                    name: field(m, "name"),
                    version: field(m, "version"),
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn handle_control_event(
    app: &AppHandle,
    session_id: u64,
    real_pid: i32,
    event: &serde_json::Value,
    raw: &str,
) {
    let name = event.get("event").and_then(|v| v.as_str());
    // An answer someone's waiting for.
    {
        let debug_state = app.state::<DebugState>();
        let mut guard = debug_state.0.locked();
        if let Some(session) = guard.as_mut().filter(|s| s.id == session_id)
            && session.reply_waiter.as_ref().is_some_and(|(want, _)| Some(*want) == name)
            && let Some((_, waiter)) = session.reply_waiter.take()
        {
            let _ = waiter.send(event.clone());
            return;
        }
    }
    match name {
        Some("mods") => {
            let _ = app.emit(
                crate::events::GAME_STATUS,
                GameStatus {
                    stage: "ready",
                    pid: Some(real_pid),
                    mods: parse_mods(event),
                },
            );
        }
        other => {
            let _ = app.emit(
                crate::events::OUTPUT_DEBUG,
                format!("[control] {}: {raw}", other.unwrap_or("unknown")),
            );
        }
    }
}
