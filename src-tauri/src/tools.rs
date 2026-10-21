//! The environment Yog IDLE starts `yog` and cargo in — `PATH` with cargo's
//! `bin/` and the zig Yog Installer put in Yog's home, `YOG_TARGETS` (the
//! project's platforms, or this machine's only), `YOG_API_PATH` — and what
//! Tools > Yog Installer opens. Installing anything is Yog Installer's job.

use substrate_platform::sync::ReadWrite;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde::{Deserialize, Serialize};
use tauri::State;
use yog_home::Home;
use substrate_platform::process;
use yog_home::components::id;

/// Key of the Build options in the app-wide `state.json` (written by the
/// front end's global store; read here at startup).
pub const SETTINGS_KEY: &str = "build.settings";

/// Where Yog Installer is downloaded when this machine has none.
const INSTALLER_RELEASES: &str = "https://github.com/F000NKKK/Yog-Installer/releases/latest";

/// Tools > Options > Build.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Build for this computer's platform only (`YOG_TARGETS`) — the fast dev loop.
    pub host_only: bool,
    /// Build against this local `yog-api` crate (`YOG_API_PATH`) — empty: crates.io.
    pub yog_api_path: String,
}

#[derive(Default)]
pub struct ToolsState(RwLock<Settings>);

impl ToolsState {
    pub fn new(settings: Settings) -> Self {
        Self(RwLock::new(settings))
    }

    pub fn settings(&self) -> Settings {
        self.0.read_locked().clone()
    }
}

/// The Build options in `state.json` (the file `app_state_load` reads).
pub fn load_settings_from(state_file: &Path) -> Settings {
    std::fs::read_to_string(state_file)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| value.get(SETTINGS_KEY).cloned())
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

/// The app's remembered state in its config dir (Tauri's is `<config>/<identifier>`).
pub fn default_state_file(identifier: &str) -> Option<PathBuf> {
    Some(dirs::config_dir()?.join(identifier).join(substrate_platform::state::APP_STATE_FILE))
}

/// This computer's `yog build` platform tag (`linux-x86_64`, ...), if yog builds for it.
pub fn host_tag() -> Option<&'static str> {
    yog_ids::platform::host().map(|p| p.tag)
}

/// cargo's `bin/`: `$CARGO_HOME/bin`, else `~/.cargo/bin`.
fn cargo_bin() -> Option<PathBuf> {
    let home = std::env::var_os("CARGO_HOME").map(PathBuf::from).or_else(|| dirs::home_dir().map(|h| h.join(".cargo")));
    home.map(|h| h.join("bin"))
}

/// The folder of the zig Yog Installer installed, if it did.
fn installed_zig() -> Option<PathBuf> {
    let components = Home::locate().ok()?.components().ok()?;
    components.newest(id::ZIG).map(|c| c.path.clone())
}

/// `PATH` with cargo's `bin/` and the installed zig in front.
fn joined_path() -> String {
    let mut all: Vec<PathBuf> = cargo_bin().into_iter().chain(installed_zig()).collect();
    if let Some(path) = std::env::var_os("PATH") {
        all.extend(std::env::split_paths(&path));
    }
    std::env::join_paths(all).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
}

/// `YOG_TARGETS` for a build: the project's own platforms (Project Properties
/// > Build), else just this computer's when "host only" is on, else every one.
pub fn yog_targets(settings: &Settings, project_targets: &[String]) -> Option<String> {
    if !project_targets.is_empty() {
        return Some(project_targets.join(","));
    }
    settings.host_only.then(|| host_tag().map(str::to_string)).flatten()
}

/// The environment of a `yog`/cargo process.
pub fn tool_env(settings: &Settings, project_targets: &[String]) -> HashMap<String, String> {
    let mut env = HashMap::from([("PATH".to_string(), joined_path())]);
    if let Some(targets) = yog_targets(settings, project_targets) {
        env.insert(yog_ids::env::TARGETS.into(), targets);
    }
    if !settings.yog_api_path.trim().is_empty() {
        env.insert(yog_ids::env::API_PATH.into(), settings.yog_api_path.trim().into());
    }
    env
}

/// The Build options into Yog IDLE's own environment, for what it starts
/// without [`tool_env`] (Run's `yog run`, terminals). Must run before any
/// other thread exists — first thing in `run()`.
pub fn apply_to_process_at_startup(settings: &Settings) {
    for (key, value) in tool_env(settings, &[]) {
        // SAFETY: called at the very start of `run()`, before Tauri (or
        // anything else) has spawned a thread that could read the
        // environment concurrently.
        unsafe { std::env::set_var(key, value) };
    }
}

#[tauri::command]
pub fn tools_settings_set(state: State<'_, ToolsState>, settings: Settings) {
    *state.0.write_locked() = settings;
}

/// What Yog needs here and has: the CLI, a loader SDK (installed, or the
/// local patch's checkout), Yog Installer.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub yog: Option<String>,
    pub loader_sdk: Option<String>,
    pub installer: Option<String>,
    pub host_tag: Option<&'static str>,
}

#[tauri::command]
pub fn tools_status() -> Status {
    let home = Home::locate().ok();
    let resolver = home.as_ref().and_then(|h| yog_home::targets::Resolver::new(h).ok());
    let installer = home.as_ref().and_then(|h| h.components().ok()).and_then(|c| c.newest(id::INSTALLER).map(|i| i.path.clone()));
    Status {
        yog: crate::cli::binary().map(|p| p.display().to_string()),
        loader_sdk: resolver.and_then(|r| r.loader_sdk()).map(|p| p.display().to_string()),
        installer: installer.map(|p| p.display().to_string()),
        host_tag: host_tag(),
    }
}

/// Starts Yog Installer — or, when this machine has none, opens the page
/// to download it from.
#[tauri::command]
pub fn open_installer() -> Result<(), String> {
    let installer = Home::locate()?.components()?.newest(id::INSTALLER).map(|i| i.path.clone());
    match installer.filter(|p| p.exists()) {
        Some(program) => process::start(&program),
        None => process::open_link(INSTALLER_RELEASES),
    }
    .map_err(|m| m.to_string())
}
