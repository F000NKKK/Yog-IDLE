//! Hot reload: build the mod, ask the game, apply or roll back, and say what changed.

use super::*;
use substrate_platform::sync::Locked;

/// Only one hot reload at a time — a second click while the first is still
/// building would otherwise race it for `bin/<id>.yog`.
pub(super) static HOT_RELOAD_BUSY: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HotReloadEvent {
    /// `"building"` | `"reloading"` | `"done"`.
    pub(super) stage: &'static str,
    pub(super) mod_id: String,
    /// Only set once `stage == "done"`.
    pub(super) ok: Option<bool>,
    pub(super) message: String,
    /// `stage == "confirm"`: what the new build registers that only a
    /// restart applies — `<kind> <id>` each.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) changes: Option<Changes>,
}

pub(super) fn emit_hot_reload(
    app: &AppHandle,
    stage: &'static str,
    mod_id: &str,
    ok: Option<bool>,
    message: String,
) {
    let prefix = match ok {
        Some(false) => "[error] ",
        _ => "",
    };
    let _ = app.emit(
        crate::app::events::OUTPUT_BUILD,
        format!("{prefix}hot reload: {message}"),
    );
    let _ = app.emit(
        crate::app::events::HOT_RELOAD,
        HotReloadEvent {
            stage,
            mod_id: mod_id.to_string(),
            ok,
            message,
            changes: None,
        },
    );
}

/// Rebuilds the open project (`yog build`, or `yog build debug` for a
/// debug-mode run) and asks the running game to hot-reload it over the
/// control socket: `{"cmd":"hot_reload","mod_id",..,"yog_path":..}`,
/// answered by `{"event":"hot-reload-done","ok":..}`. The runtime only
/// accepts a `.yog` of its ABI major and a minor no newer than its own.
/// Only in a Debug run: what only a restart applies is checked first, and
/// the user decides (the `confirm` stage, [`decide_hot_reload`]).
///
/// Returns once the work is started — progress and the outcome arrive as
/// `hot-reload` events (plus Output lines), same reasoning as
/// `run_with_mode`'s about not blocking an invoke on a long-running wait.
pub fn hot_reload(app: AppHandle, project_root: String) -> Result<(), String> {
    let root = PathBuf::from(&project_root);
    let mod_id = mod_id(&root)?;

    let (session_id, debug_mode) = {
        let debug_state = app.state::<DebugState>();
        let guard = debug_state.0.locked();
        let session = guard.as_ref().ok_or("the game isn't running")?;
        if session.control.is_none() {
            return Err(
                "the game hasn't connected its control socket (yet) — hot reload needs it"
                    .to_string(),
            );
        }
        (session.id, session.debug_mode)
    };
    if !debug_mode {
        return Err("hot reload works in a Debug run — a Release run is built as players get it, without it".to_string());
    }
    if HOT_RELOAD_BUSY.swap(true, Ordering::SeqCst) {
        return Err("a hot reload is already in progress".to_string());
    }

    std::thread::spawn(move || {
        let outcome = run_hot_reload(&app, &root, &mod_id, session_id, debug_mode);
        finish_hot_reload(&app, &mod_id, outcome);
    });
    Ok(())
}

/// A built `.yog` waiting for the user: it registers what only a restart applies.
pub(super) struct PendingReload {
    pub(super) mod_id: String,
    pub(super) session_id: u64,
    pub(super) yog_path: PathBuf,
}

pub(super) static PENDING_RELOAD: Mutex<Option<PendingReload>> = Mutex::new(None);

/// What a hot reload came to: done (reloaded, or why not), or waiting for
/// the user's choice ([`decide_hot_reload`]).
pub(super) enum Outcome {
    Done(Result<(), String>),
    Waiting,
}

pub(super) fn finish_hot_reload(app: &AppHandle, mod_id: &str, outcome: Outcome) {
    let (ok, message) = match outcome {
        Outcome::Waiting => return,
        Outcome::Done(Ok(())) => (true, format!("{mod_id} reloaded")),
        Outcome::Done(Err(e)) => (false, e),
    };
    HOT_RELOAD_BUSY.store(false, Ordering::SeqCst);
    emit_hot_reload(app, "done", mod_id, Some(ok), message);
}

/// The user's answer to a hot reload that needs a restart for part of it:
/// `"apply"` reloads what can be (code, resources, data) anyway; anything
/// else drops it (`"restart"`: the IDE restarts the game itself).
pub fn decide_hot_reload(app: AppHandle, choice: String) -> Result<(), String> {
    let pending = PENDING_RELOAD
        .locked()
        .take()
        .ok_or("no hot reload is waiting")?;
    std::thread::spawn(move || {
        let outcome = if choice == "apply" {
            Outcome::Done(apply_reload(
                &app,
                &pending.mod_id,
                pending.session_id,
                &pending.yog_path,
            ))
        } else {
            Outcome::Done(Err(format!("{} not reloaded ({choice})", pending.mod_id)))
        };
        finish_hot_reload(&app, &pending.mod_id, outcome);
    });
    Ok(())
}

/// Sends `request` over the session's control socket and waits for the
/// runtime's answer: the first event `answers` takes.
pub(super) fn ask_control(
    app: &AppHandle,
    session_id: u64,
    request: &Command,
    answers: fn(&Event) -> bool,
) -> Result<Event, String> {
    let (tx, rx) = mpsc::channel();
    {
        let debug_state = app.state::<DebugState>();
        let mut guard = debug_state.0.locked();
        let session = guard
            .as_mut()
            .filter(|s| s.id == session_id)
            .ok_or("the game exited")?;
        let control = session.control.as_mut().ok_or("control socket is gone")?;
        send_control(control, request)
            .map_err(|e| format!("writing to the control socket: {e}"))?;
        session.reply_waiter = Some((answers, tx));
    }
    match rx.recv_timeout(HOT_RELOAD_TIMEOUT) {
        Ok(v) => Ok(v),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(format!(
            "the game didn't answer within {}s",
            HOT_RELOAD_TIMEOUT.as_secs()
        )),
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("the game exited before answering".to_string())
        }
    }
}

pub(super) fn run_hot_reload(
    app: &AppHandle,
    root: &Path,
    mod_id: &str,
    session_id: u64,
    debug_mode: bool,
) -> Outcome {
    match build_and_check(app, root, mod_id, session_id, debug_mode) {
        Err(e) => Outcome::Done(Err(e)),
        Ok((yog_path, changes)) if changes.is_empty() => {
            Outcome::Done(apply_reload(app, mod_id, session_id, &yog_path))
        }
        Ok((yog_path, changes)) => {
            *PENDING_RELOAD.locked() = Some(PendingReload {
                mod_id: mod_id.to_string(),
                session_id,
                yog_path,
            });
            let n = changes.added.len() + changes.removed.len() + changes.changed.len();
            let _ = app.emit(
                crate::app::events::OUTPUT_BUILD,
                format!("hot reload: {n} change(s) only a restart applies"),
            );
            let _ = app.emit(
                crate::app::events::HOT_RELOAD,
                HotReloadEvent {
                    stage: "confirm",
                    mod_id: mod_id.to_string(),
                    ok: None,
                    message: format!("{n} change(s) need a restart"),
                    changes: Some(changes),
                },
            );
            Outcome::Waiting
        }
    }
}

/// Builds the mod for hot reload (`yog build [debug] --dev`) and asks the
/// game what of it only a restart applies.
pub(super) fn build_and_check(
    app: &AppHandle,
    root: &Path,
    mod_id: &str,
    session_id: u64,
    debug_mode: bool,
) -> Result<(PathBuf, Changes), String> {
    let mut args = vec!["build"];
    if debug_mode {
        args.push("debug");
    }
    args.push("--dev");
    emit_hot_reload(
        app,
        "building",
        mod_id,
        None,
        format!("running `yog {}`", args.join(" ")),
    );
    let feed = crate::toolchain::diagnostics_feed::Feed::open(app);
    let (feed_key, feed_path) = feed.env();
    let mut child = crate::toolchain::cli::command()
        .args(&args)
        .current_dir(root)
        .env(feed_key, feed_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to launch `yog build`: {e}"))?;
    // `yog build` reports progress on stderr — not a warning in itself.
    let pipes: Vec<Box<dyn std::io::Read + Send>> = [
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn std::io::Read + Send>),
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn std::io::Read + Send>),
    ]
    .into_iter()
    .flatten()
    .collect();
    let readers: Vec<_> = pipes
        .into_iter()
        .map(|pipe| {
            let out_app = app.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                    let _ = out_app.emit(crate::app::events::OUTPUT_BUILD, line);
                }
            })
        })
        .collect();
    let status = child.wait().map_err(|e| e.to_string())?;
    for reader in readers {
        let _ = reader.join();
    }
    drop(feed);
    if !status.success() {
        return Err(format!(
            "`yog build` failed ({status}) — the game keeps running the previous build"
        ));
    }

    let yog_path = root
        .join(yog_ids::project::BIN)
        .join(format!("{mod_id}.yog"));
    let yog_path = yog_path
        .canonicalize()
        .map_err(|e| format!("{}: {e}", yog_path.display()))?;

    let check = ask_control(
        app,
        session_id,
        &Command::HotReloadCheck {
            mod_id: mod_id.to_string(),
            yog_path: yog_path.clone(),
        },
        |e| matches!(e, Event::HotReloadCheck { .. }),
    )?;
    let Event::HotReloadCheck { changes, .. } = check else {
        return Err("the game answered something else than the check".to_string());
    };
    Ok((yog_path, changes))
}

/// Swaps the built `.yog` into the game: its code, then the game rereads
/// its resources and data (F3+T, `/reload`).
pub(super) fn apply_reload(
    app: &AppHandle,
    mod_id: &str,
    session_id: u64,
    yog_path: &Path,
) -> Result<(), String> {
    emit_hot_reload(
        app,
        "reloading",
        mod_id,
        None,
        format!("sent {} to the game", yog_path.display()),
    );
    let done = ask_control(
        app,
        session_id,
        &Command::HotReload {
            mod_id: mod_id.to_string(),
            yog_path: yog_path.to_path_buf(),
            resources: true,
        },
        |e| matches!(e, Event::HotReloadDone { .. }),
    )?;
    if !matches!(done, Event::HotReloadDone { ok: true, .. }) {
        return Err(format!(
            "the game rejected the new build of {mod_id} (see the game log — most often an ABI version mismatch, \
             which needs a full restart)"
        ));
    }
    let debug_state = app.state::<DebugState>();
    let mut guard = debug_state.0.locked();
    if let Some(session) = guard.as_mut().filter(|s| s.id == session_id) {
        if let Some(tracer) = &session.tracer {
            tracer.send(TracerCmd::Rebind);
        }
        // A reload can change the mod's reported version — refresh the list
        // (the answer arrives as a `mods` event, see `handle_control_event`).
        if let Some(control) = session.control.as_mut() {
            let _ = send_control(control, &Command::ListMods);
        }
    }
    Ok(())
}
