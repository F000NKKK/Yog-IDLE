//! The development environment a Yog mod needs — Visual Studio
//! Installer-style: detect what's there (`environment_detect`), install or
//! update what isn't (`environment_install`, streamed to the Output panel's
//! "Environment" source, cancellable), and the Environment options that
//! decide which tools Yog-IDLE runs (`environment_settings_set`, applied to
//! every `yog` it spawns — see [`tool_env`]).
//!
//! What a Yog dev needs, from how `yog-cli` works: `yog` itself (crates.io
//! `yog-cli`), rustup with the Rust toolchain the yog crates pin plus the
//! five targets a `.yog` bundles, `cargo-zigbuild` + `zig` to cross-link
//! them, a JDK per Minecraft version the run targets use (17 for 1.20.1,
//! 21 for 1.21.1 — each loader's `versions/<mc>.properties`), and a
//! Yog-Mod-Loader checkout whose Gradle dev runs (`./gradlew runClient`)
//! the `[run.*]` targets launch — Gradle fetches Minecraft itself.
//!
//! Detection only reads: `--version` style queries, `rustup … list`, a
//! JDK's `release` file (never runs `java`). Installs go into user-level
//! locations (rustup's own `~/.cargo`, the IDE's tools dir) and only ever
//! start from an explicit `environment_install` call the user confirmed.
//! Prefers `yog doctor --json` (yog-cli 0.24+) for the toolchain/targets
//! yog wants, and falls back to its own checks with older CLIs.

use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

/// The Output panel source installs write to.
pub const OUTPUT_ENVIRONMENT: &str = "environment-output";

/// Key of the Environment options in the app-wide `state.json` (written by
/// the frontend's global store; read here at startup).
pub const SETTINGS_KEY: &str = "environment.settings";

/// The Rust toolchain mods build with when the installed `yog` can't say
/// (pre-0.24 CLIs have no `yog doctor`) — the yog crates' `rust-version`.
const FALLBACK_TOOLCHAIN: &str = "1.99";

/// Every platform a `.yog` bundles natives for: `(tag, triple)` — the same
/// list as `yog-cli`'s `TARGETS`.
pub const TARGETS: &[(&str, &str)] = &[
    ("linux-x86_64", "x86_64-unknown-linux-gnu"),
    ("linux-aarch64", "aarch64-unknown-linux-gnu"),
    ("windows-x86_64", "x86_64-pc-windows-gnu"),
    ("macos-x86_64", "x86_64-apple-darwin"),
    ("macos-aarch64", "aarch64-apple-darwin"),
];

/// JDKs needed when no loader checkout says otherwise (MC 1.20.1 / 1.21.1).
const DEFAULT_JAVA_MAJORS: &[u32] = &[17, 21];

const LOADER_REPO_URL: &str = "https://github.com/F000NKKK/Yog-Mod-Loader";

// ── Settings ────────────────────────────────────────────────────────────────

/// Tools > Options > Environment. Empty strings mean "detect/default".
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// The `yog` executable to run — empty: the one on `PATH` / in cargo's bin dir.
    pub yog_path: String,
    /// `CARGO_HOME` (its `bin/` holds cargo, rustup, `cargo install`ed tools) — empty: `~/.cargo`.
    pub cargo_home: String,
    /// Where Yog-IDLE installs JDKs, zig and the loader checkout — empty: the app data dir's `tools/`.
    pub tools_dir: String,
    /// JDK home per Java major version (`"17"`, `"21"`) — empty/missing: the newest detected one.
    pub jdks: BTreeMap<String, String>,
    /// The Yog-Mod-Loader checkout run targets use — empty: found next to the project or in the tools dir.
    pub loader_repo: String,
    /// Build for the host platform only (`YOG_TARGETS`) — the fast dev loop.
    pub host_only: bool,
    /// Build against this local `yog-api` crate (`YOG_API_PATH`) — empty: crates.io.
    pub yog_api_path: String,
    /// Check the environment when Yog-IDLE starts.
    pub skip_startup_check: bool,
}

#[derive(Default)]
pub struct EnvironmentState {
    settings: RwLock<Settings>,
    /// The install in flight: its cancel flag.
    install: Mutex<Option<Arc<AtomicBool>>>,
}

impl EnvironmentState {
    pub fn with_settings(settings: Settings) -> Self {
        Self {
            settings: RwLock::new(settings),
            install: Mutex::new(None),
        }
    }

    pub fn settings(&self) -> Settings {
        self.settings.read().unwrap().clone()
    }
}

/// `state.json` in the app config dir — the same file `app_state_load`
/// reads through `AppHandle` (Tauri's config dir is `<config>/<identifier>`).
pub fn load_settings_from(state_file: &Path) -> Settings {
    std::fs::read_to_string(state_file)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| value.get(SETTINGS_KEY).cloned())
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

pub fn default_state_file(identifier: &str) -> Option<PathBuf> {
    Some(dirs::config_dir()?.join(identifier).join("state.json"))
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
}

fn cargo_bin(settings: &Settings) -> PathBuf {
    let base = if !settings.cargo_home.trim().is_empty() {
        PathBuf::from(settings.cargo_home.trim())
    } else if let Some(env) = std::env::var_os("CARGO_HOME") {
        PathBuf::from(env)
    } else {
        home().join(".cargo")
    };
    base.join("bin")
}

pub fn tools_dir(settings: &Settings) -> PathBuf {
    if !settings.tools_dir.trim().is_empty() {
        return PathBuf::from(settings.tools_dir.trim());
    }
    dirs::data_dir()
        .unwrap_or_else(home)
        .join("dev.yog.idle")
        .join("tools")
}

/// Directories put in front of `PATH` for every tool Yog-IDLE runs: the
/// configured `yog`'s folder, cargo's `bin/`, and an IDE-installed zig.
fn extra_path_dirs(settings: &Settings, probe: &dyn Probe) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(parent) = Path::new(settings.yog_path.trim()).parent()
        && !settings.yog_path.trim().is_empty()
    {
        dirs.push(parent.to_path_buf());
    }
    dirs.push(cargo_bin(settings));
    if let Some(zig) = newest_child_with(probe, &tools_dir(settings).join("zig"), exe("zig")) {
        dirs.push(zig);
    }
    dirs
}

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// The newest (by name) subdirectory of `dir` holding `file` — IDE-installed
/// tools are extracted one folder per version.
fn newest_child_with(probe: &dyn Probe, dir: &Path, file: String) -> Option<PathBuf> {
    let mut found: Vec<PathBuf> = probe
        .list_dir(dir)
        .into_iter()
        .filter(|d| probe.is_file(&d.join(&file)))
        .collect();
    found.sort_by(|a, b| compare_versions(&a.to_string_lossy(), &b.to_string_lossy()));
    found.pop()
}

fn joined_path(front: &[PathBuf]) -> String {
    let mut all: Vec<PathBuf> = front.to_vec();
    if let Some(path) = std::env::var_os("PATH") {
        all.extend(std::env::split_paths(&path));
    }
    std::env::join_paths(all)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// The host's `yog build` platform tag (`linux-x86_64`, ...), if yog builds for it.
pub fn host_tag() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("linux-x86_64"),
        ("linux", "aarch64") => Some("linux-aarch64"),
        ("windows", "x86_64") => Some("windows-x86_64"),
        ("macos", "x86_64") => Some("macos-x86_64"),
        ("macos", "aarch64") => Some("macos-aarch64"),
        _ => None,
    }
}

/// `YOG_TARGETS` for a build: the project's own platform choice (Project
/// Properties > Build), else just the host when "host only" is on, else
/// unset (every platform).
pub fn yog_targets(settings: &Settings, project_targets: &[String]) -> Option<String> {
    if !project_targets.is_empty() {
        return Some(project_targets.join(","));
    }
    if settings.host_only {
        return host_tag().map(str::to_string);
    }
    None
}

/// Environment variables for a `yog`/`cargo` process: `PATH` with the
/// configured tool dirs in front, `YOG_TARGETS`, `YOG_API_PATH`.
pub fn tool_env(settings: &Settings, project_targets: &[String]) -> HashMap<String, String> {
    let mut env = HashMap::new();
    env.insert(
        "PATH".to_string(),
        joined_path(&extra_path_dirs(settings, &SystemProbe)),
    );
    if let Some(targets) = yog_targets(settings, project_targets) {
        env.insert("YOG_TARGETS".to_string(), targets);
    }
    if !settings.yog_api_path.trim().is_empty() {
        env.insert(
            "YOG_API_PATH".to_string(),
            settings.yog_api_path.trim().to_string(),
        );
    }
    if !settings.cargo_home.trim().is_empty() {
        env.insert(
            "CARGO_HOME".to_string(),
            settings.cargo_home.trim().to_string(),
        );
    }
    env
}

/// The `yog` program to run — the configured one, or plain `yog` (found
/// through [`tool_env`]'s `PATH`).
pub fn yog_program(settings: &Settings) -> String {
    let configured = settings.yog_path.trim();
    if configured.is_empty() {
        "yog".to_string()
    } else {
        configured.to_string()
    }
}

/// Applies the Environment options to Yog-IDLE's own process environment,
/// so processes it doesn't build through [`tool_env`] (Run/Debug's `yog
/// run`, integrated terminals) see the same tools.
///
/// Must run before any other thread exists — it's called first thing in
/// `run()`; later option changes reach [`tool_env`] callers immediately and
/// the rest on the next start.
pub fn apply_to_process_at_startup(settings: &Settings) {
    let mut vars = tool_env(settings, &[]);
    // A per-project choice; never a process-wide one.
    vars.remove("YOG_TARGETS");
    if let Some(targets) = yog_targets(settings, &[]) {
        vars.insert("YOG_TARGETS".to_string(), targets);
    }
    for (key, value) in vars {
        // SAFETY: called at the very start of `run()`, before Tauri (or
        // anything else) has spawned a thread that could read the
        // environment concurrently.
        unsafe { std::env::set_var(key, value) };
    }
}

// ── Probing ─────────────────────────────────────────────────────────────────

/// Everything detection reads from the machine — faked in tests.
pub trait Probe {
    /// stdout of `program args` if it ran and succeeded.
    fn run(&self, program: &Path, args: &[&str]) -> Option<String>;
    fn read(&self, path: &Path) -> Option<String>;
    fn is_file(&self, path: &Path) -> bool;
    fn is_dir(&self, path: &Path) -> bool;
    fn list_dir(&self, path: &Path) -> Vec<PathBuf>;
    /// The files (not directories) directly in `path`.
    fn list_files(&self, path: &Path) -> Vec<PathBuf>;
    fn env(&self, key: &str) -> Option<String>;
}

pub struct SystemProbe;

const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

impl Probe for SystemProbe {
    fn run(&self, program: &Path, args: &[&str]) -> Option<String> {
        let mut child = Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let mut stdout = child.stdout.take()?;
        let reader = std::thread::spawn(move || {
            let mut out = String::new();
            let _ = std::io::Read::read_to_string(&mut stdout, &mut out);
            out
        });
        let start = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let out = reader.join().ok()?;
                    return status.success().then_some(out);
                }
                Ok(None) if start.elapsed() > PROBE_TIMEOUT => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(20)),
                Err(_) => return None,
            }
        }
    }
    fn read(&self, path: &Path) -> Option<String> {
        std::fs::read_to_string(path).ok()
    }
    fn is_file(&self, path: &Path) -> bool {
        path.is_file()
    }
    fn is_dir(&self, path: &Path) -> bool {
        path.is_dir()
    }
    fn list_dir(&self, path: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(path)
            .map(|entries| {
                entries
                    .filter_map(|e| e.ok().map(|e| e.path()))
                    .filter(|p| p.is_dir())
                    .collect()
            })
            .unwrap_or_default()
    }
    fn list_files(&self, path: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(path)
            .map(|entries| {
                entries
                    .filter_map(|e| e.ok().map(|e| e.path()))
                    .filter(|p| p.is_file())
                    .collect()
            })
            .unwrap_or_default()
    }
    fn env(&self, key: &str) -> Option<String> {
        std::env::var(key).ok().filter(|v| !v.is_empty())
    }
}

/// `program` in `extra` dirs first, then on `PATH`.
fn which(probe: &dyn Probe, name: &str, extra: &[PathBuf]) -> Option<PathBuf> {
    let file = exe(name);
    let path_dirs: Vec<PathBuf> = probe
        .env("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    extra
        .iter()
        .chain(path_dirs.iter())
        .map(|d| d.join(&file))
        .find(|candidate| probe.is_file(candidate))
}

// ── Version parsing ─────────────────────────────────────────────────────────

/// The first `N.N[.N…]` token of a `--version` line (`"cargo 1.99.0 (5f9…)"`
/// → `1.99.0`, `"rustup 1.29.1 (…)"` → `1.29.1`, `"0.16.0"` → `0.16.0`).
pub fn parse_version(text: &str) -> Option<String> {
    text.split(|c: char| c.is_whitespace() || c == ',' || c == '(' || c == ')')
        .map(|w| w.trim_start_matches('v'))
        .find(|w| {
            let mut parts = w.split('.');
            parts
                .next()
                .is_some_and(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
                && w.contains('.')
        })
        .map(str::to_string)
}

/// Numeric, component-wise comparison (`0.10.0` > `0.9.3`); non-numeric
/// suffixes (`-beta`) are ignored.
pub fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    fn parts(v: &str) -> Vec<u64> {
        v.split(|c: char| !c.is_ascii_digit())
            .filter(|p| !p.is_empty())
            .filter_map(|p| p.parse().ok())
            .collect()
    }
    parts(a).cmp(&parts(b))
}

/// `version` from `cargo search <name> --limit 1` output
/// (`yog-cli = "0.24.0"    # Yog build tool…`).
pub fn parse_cargo_search(output: &str, name: &str) -> Option<String> {
    let line = output.lines().next()?;
    let rest = line.strip_prefix(name)?.trim_start().strip_prefix('=')?;
    rest.split('"').nth(1).map(str::to_string)
}

/// The installed version of `krate` from `cargo install --list`
/// (`yog-cli v0.23.0:` followed by its binaries).
pub fn parse_cargo_install_list(output: &str, krate: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let rest = line.strip_prefix(krate)?.strip_prefix(" v")?;
        Some(rest.split([':', ' ']).next()?.to_string())
    })
}

/// A JDK `release` file's `JAVA_VERSION` and `IMPLEMENTOR`.
pub fn parse_jdk_release(text: &str) -> Option<(String, Option<String>)> {
    let value = |key: &str| {
        text.lines().find_map(|line| {
            let rest = line.trim().strip_prefix(key)?.strip_prefix('=')?;
            Some(rest.trim().trim_matches('"').to_string())
        })
    };
    Some((value("JAVA_VERSION")?, value("IMPLEMENTOR")))
}

/// `"1.8.0_392"` → 8, `"17.0.9"` → 17, `"21"` → 21.
pub fn java_major(version: &str) -> Option<u32> {
    let mut parts = version.split(['.', '_', '+', '-']);
    let first: u32 = parts.next()?.parse().ok()?;
    if first == 1 {
        parts.next()?.parse().ok()
    } else {
        Some(first)
    }
}

/// `java_version=21` lines of the loader's `<loader>/versions/*.properties`.
fn parse_java_version_property(text: &str) -> Option<u32> {
    text.lines().find_map(|line| {
        line.trim()
            .strip_prefix("java_version")?
            .trim_start()
            .strip_prefix('=')?
            .trim()
            .parse()
            .ok()
    })
}

/// `yog doctor --json` (yog-cli 0.24+).
#[derive(Deserialize, Debug, Default)]
struct Doctor {
    rust_toolchain: String,
    #[serde(default)]
    targets: Vec<DoctorTarget>,
}

#[derive(Deserialize, Debug)]
struct DoctorTarget {
    triple: String,
    installed: bool,
}

/// The newest stable zig in ziglang.org's `download/index.json` for
/// `host` (`x86_64-linux`, ...): `(version, tarball url)`.
pub fn zig_release(index: &str, host: &str) -> Option<(String, String)> {
    let value: serde_json::Value = serde_json::from_str(index).ok()?;
    let releases = value.as_object()?;
    releases
        .iter()
        .filter(|(version, _)| version.as_str() != "master")
        .filter_map(|(version, entry)| {
            let url = entry.get(host)?.get("tarball")?.as_str()?;
            Some((version.clone(), url.to_string()))
        })
        .max_by(|a, b| compare_versions(&a.0, &b.0))
}

// ── Detection ───────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Installed,
    Missing,
    Outdated,
    /// Some of a set present (Rust targets).
    Partial,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Component {
    pub id: String,
    /// English; the frontend translates it.
    pub name: String,
    pub description: String,
    pub status: Status,
    pub version: Option<String>,
    /// A newer version available (`Outdated`).
    pub latest: Option<String>,
    /// Extra detail — where it was found, what's missing.
    pub detail: Option<String>,
    /// Can Yog-IDLE install/update it — false: `manual_url` says where to get it.
    pub installable: bool,
    pub manual_url: Option<String>,
    /// Needed for the current options (zig isn't, for a host-only build).
    pub required: bool,
    /// Another component that has to be installed first.
    pub depends_on: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Jdk {
    pub home: String,
    pub version: String,
    pub major: u32,
    pub vendor: Option<String>,
    /// Installed by Yog-IDLE into its tools dir.
    pub managed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub components: Vec<Component>,
    pub jdks: Vec<Jdk>,
    pub rust_toolchain: String,
    pub host_tag: Option<String>,
    pub tools_dir: String,
    pub loader_repo: Option<String>,
    /// The `yog` that would run, if any.
    pub yog_path: Option<String>,
}

impl Component {
    fn new(id: &str, name: &str, description: &str) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            description: description.into(),
            status: Status::Missing,
            version: None,
            latest: None,
            detail: None,
            installable: true,
            manual_url: None,
            required: true,
            depends_on: None,
        }
    }
}

/// Every place a JDK might live — `JAVA_HOME`, the distro dirs, SDKMAN,
/// macOS's and Windows' installers, and the IDE's own tools dir.
fn jdk_candidates(probe: &dyn Probe, tools: &Path) -> Vec<(PathBuf, bool)> {
    let mut dirs: Vec<(PathBuf, bool)> = Vec::new();
    let mut scan = |parent: PathBuf, managed: bool| {
        for child in probe.list_dir(&parent) {
            dirs.push((child.clone(), managed));
            // macOS bundles: <name>.jdk/Contents/Home
            dirs.push((child.join("Contents").join("Home"), managed));
        }
    };
    scan(tools.join("jdk"), true);
    scan(PathBuf::from("/usr/lib/jvm"), false);
    scan(PathBuf::from("/usr/java"), false);
    scan(PathBuf::from("/Library/Java/JavaVirtualMachines"), false);
    scan(home().join(".sdkman/candidates/java"), false);
    scan(home().join(".jdks"), false);
    for base in [
        "C:\\Program Files\\Eclipse Adoptium",
        "C:\\Program Files\\Java",
    ] {
        scan(PathBuf::from(base), false);
    }
    if let Some(java_home) = probe.env("JAVA_HOME") {
        dirs.insert(0, (PathBuf::from(java_home), false));
    }
    dirs
}

pub fn detect_jdks(probe: &dyn Probe, tools: &Path) -> Vec<Jdk> {
    let mut seen: Vec<PathBuf> = Vec::new();
    let mut jdks = Vec::new();
    for (home, managed) in jdk_candidates(probe, tools) {
        if seen.contains(&home) || !probe.is_file(&home.join("bin").join(exe("java"))) {
            continue;
        }
        let Some((version, vendor)) = probe
            .read(&home.join("release"))
            .and_then(|t| parse_jdk_release(&t))
        else {
            continue;
        };
        let Some(major) = java_major(&version) else {
            continue;
        };
        seen.push(home.clone());
        jdks.push(Jdk {
            home: home.to_string_lossy().into_owned(),
            version,
            major,
            vendor,
            managed,
        });
    }
    jdks.sort_by(|a, b| {
        b.major
            .cmp(&a.major)
            .then(compare_versions(&b.version, &a.version))
    });
    jdks
}

fn is_loader_repo(probe: &dyn Probe, dir: &Path) -> bool {
    probe.is_file(&dir.join("version.properties")) && probe.is_dir(&dir.join("fabric"))
}

/// The Yog-Mod-Loader checkout: configured, next to the project (where the
/// example mods' run targets point), or in the tools dir.
fn find_loader_repo(
    probe: &dyn Probe,
    settings: &Settings,
    project_root: Option<&Path>,
) -> Option<PathBuf> {
    let configured = settings.loader_repo.trim();
    if !configured.is_empty() {
        return Some(PathBuf::from(configured));
    }
    let mut candidates = Vec::new();
    if let Some(parent) = project_root.and_then(Path::parent) {
        candidates.push(parent.join("Yog-Mod-Loader"));
    }
    candidates.push(tools_dir(settings).join("Yog-Mod-Loader"));
    candidates.into_iter().find(|d| is_loader_repo(probe, d))
}

/// Java majors the loader's MC versions need (`java_version` in each
/// `<loader>/versions/<mc>.properties`), else 17 and 21.
fn required_java_majors(probe: &dyn Probe, loader: Option<&Path>) -> Vec<u32> {
    let mut majors: Vec<u32> = Vec::new();
    if let Some(loader) = loader {
        for platform in ["fabric", "neoforge", "forge"] {
            for dir in [loader.join(platform).join("versions")] {
                for mc in ["1.20.1", "1.21.1"] {
                    if let Some(major) = probe
                        .read(&dir.join(format!("{mc}.properties")))
                        .and_then(|t| parse_java_version_property(&t))
                        && !majors.contains(&major)
                    {
                        majors.push(major);
                    }
                }
            }
        }
    }
    if majors.is_empty() {
        majors = DEFAULT_JAVA_MAJORS.to_vec();
    }
    majors.sort_unstable();
    majors
}

/// The targets the current options build: the host only, or all five.
fn wanted_targets(settings: &Settings) -> Vec<&'static str> {
    match (settings.host_only, host_tag()) {
        (true, Some(tag)) => TARGETS
            .iter()
            .filter(|(t, _)| *t == tag)
            .map(|(_, triple)| *triple)
            .collect(),
        _ => TARGETS.iter().map(|(_, triple)| *triple).collect(),
    }
}

fn first_line(text: &str) -> String {
    text.lines().next().unwrap_or("").trim().to_string()
}

/// Inspects the machine. `check_latest` also asks crates.io for the newest
/// `yog-cli` (`cargo search`, needs the network).
pub fn detect(
    probe: &dyn Probe,
    settings: &Settings,
    project_root: Option<&Path>,
    check_latest: bool,
) -> Report {
    let extra = extra_path_dirs(settings, probe);
    let tools = tools_dir(settings);
    let mut components = Vec::new();

    // yog CLI
    let yog_path = if settings.yog_path.trim().is_empty() {
        which(probe, "yog", &extra)
    } else {
        Some(PathBuf::from(settings.yog_path.trim())).filter(|p| probe.is_file(p))
    };
    let cargo = which(probe, "cargo", &extra);
    let mut yog = Component::new(
        "yog",
        "Yog CLI",
        "yog build / run / publish — the Yog mod build tool (crates.io: yog-cli).",
    );
    yog.depends_on = Some("rust".into());
    let mut doctor: Option<Doctor> = None;
    if let Some(path) = &yog_path {
        yog.status = Status::Installed;
        yog.detail = Some(path.to_string_lossy().into_owned());
        yog.version = probe
            .run(path, &["--version"])
            .and_then(|out| parse_version(&out))
            .or_else(|| {
                let list = probe.run(cargo.as_deref()?, &["install", "--list"])?;
                parse_cargo_install_list(&list, "yog-cli")
            });
        doctor = probe
            .run(path, &["doctor", "--json"])
            .and_then(|out| serde_json::from_str(out.trim()).ok());
        if check_latest
            && let Some(cargo) = &cargo
            && let Some(latest) = probe
                .run(cargo, &["search", "yog-cli", "--limit", "1"])
                .and_then(|out| parse_cargo_search(&out, "yog-cli"))
        {
            if yog
                .version
                .as_deref()
                .is_some_and(|v| compare_versions(&latest, v).is_gt())
            {
                yog.status = Status::Outdated;
            }
            yog.latest = Some(latest);
        }
    }
    let toolchain = doctor
        .as_ref()
        .map(|d| d.rust_toolchain.clone())
        .unwrap_or_else(|| FALLBACK_TOOLCHAIN.to_string());

    // rustup + the toolchain yog wants
    let rustup = which(probe, "rustup", &extra);
    let mut rust = Component::new(
        "rust",
        "Rust (rustup)",
        "rustup, cargo and rustc — installs into ~/.cargo, no administrator rights needed.",
    );
    if let Some(path) = &rustup {
        rust.status = Status::Installed;
        rust.version = probe
            .run(path, &["--version"])
            .and_then(|out| parse_version(&out));
        rust.detail = cargo
            .as_ref()
            .and_then(|c| probe.run(c, &["--version"]))
            .map(|out| first_line(&out));
    } else if let Some(cargo) = &cargo {
        // A distro cargo without rustup can't add targets or toolchains.
        rust.status = Status::Partial;
        rust.detail = probe.run(cargo, &["--version"]).map(|out| {
            format!(
                "{} — without rustup; install rustup to add toolchains and targets",
                first_line(&out)
            )
        });
    }

    let mut chain = Component::new(
        "toolchain",
        "Rust toolchain",
        "The Rust version the yog crates are built with — mods must use the same one.",
    );
    chain.depends_on = Some("rust".into());
    chain.version = Some(toolchain.clone());
    let installed_chains = rustup
        .as_ref()
        .and_then(|r| probe.run(r, &["toolchain", "list"]))
        .unwrap_or_default();
    if installed_chains
        .lines()
        .any(|l| l.starts_with(&format!("{toolchain}-")) || l.starts_with(&format!("{toolchain}.")))
    {
        chain.status = Status::Installed;
    }

    let mut targets = Component::new(
        "targets",
        "Platform targets",
        "The Rust targets a .yog bundles natives for (Linux, Windows, macOS).",
    );
    targets.depends_on = Some("toolchain".into());
    let wanted = wanted_targets(settings);
    let installed: Vec<String> = match &doctor {
        Some(d) if !d.targets.is_empty() => d
            .targets
            .iter()
            .filter(|t| t.installed)
            .map(|t| t.triple.clone())
            .collect(),
        _ => rustup
            .as_ref()
            .and_then(|r| {
                probe.run(
                    r,
                    &["target", "list", "--installed", "--toolchain", &toolchain],
                )
            })
            .map(|out| out.lines().map(|l| l.trim().to_string()).collect())
            .unwrap_or_default(),
    };
    let missing: Vec<&str> = wanted
        .iter()
        .copied()
        .filter(|t| !installed.iter().any(|i| i == t))
        .collect();
    targets.version = Some(format!("{}/{}", wanted.len() - missing.len(), wanted.len()));
    targets.status = if missing.is_empty() {
        Status::Installed
    } else if missing.len() == wanted.len() {
        Status::Missing
    } else {
        Status::Partial
    };
    if !missing.is_empty() {
        targets.detail = Some(format!("missing: {}", missing.join(", ")));
    }

    // Cross-linking
    let cross = wanted.len() > 1;
    let mut zigbuild = Component::new(
        "cargo-zigbuild",
        "cargo-zigbuild",
        "Links the Linux, Windows and macOS natives from one machine (uses zig).",
    );
    zigbuild.required = cross;
    zigbuild.depends_on = Some("rust".into());
    if let Some(path) = which(probe, "cargo-zigbuild", &extra) {
        zigbuild.status = Status::Installed;
        zigbuild.version = probe
            .run(&path, &["--version"])
            .and_then(|out| parse_version(&out));
        zigbuild.detail = Some(path.to_string_lossy().into_owned());
    }

    let mut zig = Component::new(
        "zig",
        "Zig",
        "The cross-linker cargo-zigbuild drives — installed into Yog IDLE's tools folder.",
    );
    zig.required = cross;
    if let Some(path) = which(probe, "zig", &extra) {
        zig.status = Status::Installed;
        zig.version = probe
            .run(&path, &["version"])
            .and_then(|out| parse_version(&out).or_else(|| Some(first_line(&out))));
        zig.detail = Some(path.to_string_lossy().into_owned());
    }

    components.extend([rust, chain, targets, yog, zigbuild, zig]);

    // Java + the loader's dev runs
    let loader = find_loader_repo(probe, settings, project_root);
    let loader_ok = loader.as_ref().filter(|d| is_loader_repo(probe, d));
    let jdks = detect_jdks(probe, &tools);
    for major in required_java_majors(probe, loader_ok.map(PathBuf::as_path)) {
        let mut jdk = Component::new(
            &format!("jdk-{major}"),
            &format!("JDK {major}"),
            &format!(
                "Java {major} for Minecraft run targets that need it — Eclipse Temurin, installed into Yog IDLE's tools folder."
            ),
        );
        let configured = settings
            .jdks
            .get(&major.to_string())
            .filter(|h| !h.trim().is_empty());
        let chosen = match configured {
            Some(home) => jdks.iter().find(|j| &j.home == home),
            None => jdks.iter().find(|j| j.major == major),
        };
        if let Some(found) = chosen {
            jdk.status = Status::Installed;
            jdk.version = Some(found.version.clone());
            jdk.detail = Some(found.home.clone());
        } else if let Some(home) = configured {
            jdk.detail = Some(format!("{home} is not a JDK {major}"));
        }
        components.push(jdk);
    }

    let git = which(probe, "git", &extra);
    let mut git_c = Component::new(
        "git",
        "Git",
        "Fetches and updates the Yog Mod Loader checkout.",
    );
    git_c.installable = false;
    git_c.manual_url = Some("https://git-scm.com/downloads".into());
    if let Some(path) = &git {
        git_c.status = Status::Installed;
        git_c.version = probe
            .run(path, &["--version"])
            .and_then(|out| parse_version(&out));
    }

    let mut loader_c = Component::new(
        "loader",
        "Yog Mod Loader",
        "The loader's Gradle dev instances (Fabric, NeoForge, Forge) run targets launch — Gradle downloads Minecraft on the first run.",
    );
    loader_c.depends_on = Some("git".into());
    if let Some(dir) = loader_ok {
        loader_c.status = Status::Installed;
        loader_c.version = probe.read(&dir.join("version.properties")).and_then(|t| {
            t.lines().find_map(|l| {
                l.trim()
                    .strip_prefix("mod_version=")
                    .map(|v| v.trim().to_string())
            })
        });
        loader_c.detail = Some(dir.to_string_lossy().into_owned());
    } else if let Some(dir) = &loader {
        loader_c.detail = Some(format!(
            "{} is not a Yog-Mod-Loader checkout",
            dir.display()
        ));
    }
    components.extend([git_c, loader_c]);

    Report {
        components,
        jdks,
        rust_toolchain: toolchain,
        host_tag: host_tag().map(str::to_string),
        tools_dir: tools.to_string_lossy().into_owned(),
        loader_repo: loader_ok.map(|d| d.to_string_lossy().into_owned()),
        yog_path: yog_path.map(|p| p.to_string_lossy().into_owned()),
    }
}

// ── Installing ──────────────────────────────────────────────────────────────

/// One step of an install, run in order by [`execute`].
#[derive(Clone, Debug, PartialEq)]
pub enum Step {
    /// Fetch `url` into `dest` (with `curl`, which every supported OS ships).
    Download {
        url: String,
        dest: PathBuf,
    },
    /// Unpack an archive into `dest` (`tar -xf`; Windows' bsdtar also reads zip).
    Extract {
        archive: PathBuf,
        dest: PathBuf,
    },
    /// Run a program, its output streamed to Output.
    Run {
        program: PathBuf,
        args: Vec<String>,
    },
    /// The newest stable zig for this host, from ziglang.org's index — a
    /// download + extract decided at run time.
    Zig {
        dest: PathBuf,
    },
    MakeExecutable {
        path: PathBuf,
    },
    Remove {
        path: PathBuf,
    },
}

/// rustup-init's host triple (the toolchain host, not a mod target).
fn rustup_host() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("x86_64-unknown-linux-gnu"),
        ("linux", "aarch64") => Some("aarch64-unknown-linux-gnu"),
        ("windows", "x86_64") => Some("x86_64-pc-windows-msvc"),
        ("macos", "x86_64") => Some("x86_64-apple-darwin"),
        ("macos", "aarch64") => Some("aarch64-apple-darwin"),
        _ => None,
    }
}

/// ziglang.org's host key (`x86_64-linux`).
fn zig_host() -> String {
    format!("{}-{}", std::env::consts::ARCH, std::env::consts::OS)
}

/// Adoptium's API download for the latest Temurin `major` JDK on this host.
pub fn adoptium_url(major: u32, os: &str, arch: &str) -> Option<String> {
    let os = match os {
        "linux" => "linux",
        "macos" => "mac",
        "windows" => "windows",
        _ => return None,
    };
    let arch = match arch {
        "x86_64" => "x64",
        "aarch64" => "aarch64",
        _ => return None,
    };
    Some(format!(
        "https://api.adoptium.net/v3/binary/latest/{major}/ga/{os}/{arch}/jdk/hotspot/normal/eclipse?project=jdk"
    ))
}

/// What installing (or updating) `id` takes, given what `report` found.
pub fn plan(
    id: &str,
    report: &Report,
    settings: &Settings,
    downloads: &Path,
) -> Result<Vec<Step>, String> {
    let bin = cargo_bin(settings);
    let tools = tools_dir(settings);
    let program = |name: &str| bin.join(exe(name));
    let component = report
        .components
        .iter()
        .find(|c| c.id == id)
        .ok_or_else(|| format!("unknown component '{id}'"))?;
    if let Some(dep) = &component.depends_on
        && report
            .components
            .iter()
            .any(|c| &c.id == dep && c.status == Status::Missing)
    {
        return Err(format!("install '{dep}' first"));
    }
    let strings = |args: &[&str]| args.iter().map(|a| a.to_string()).collect::<Vec<_>>();
    Ok(match id {
        "rust" => {
            let host = rustup_host().ok_or("rustup isn't available for this platform")?;
            let file = exe("rustup-init");
            let installer = downloads.join(&file);
            vec![
                Step::Download {
                    url: format!("https://static.rust-lang.org/rustup/dist/{host}/{file}"),
                    dest: installer.clone(),
                },
                Step::MakeExecutable {
                    path: installer.clone(),
                },
                Step::Run {
                    program: installer.clone(),
                    args: strings(&["-y", "--default-toolchain", "none", "--profile", "minimal"]),
                },
                Step::Remove { path: installer },
            ]
        }
        "toolchain" => vec![Step::Run {
            program: program("rustup"),
            args: strings(&[
                "toolchain",
                "install",
                &report.rust_toolchain,
                "--profile",
                "minimal",
            ]),
        }],
        "targets" => {
            let mut args = strings(&["target", "add", "--toolchain", &report.rust_toolchain]);
            args.extend(wanted_targets(settings).into_iter().map(str::to_string));
            vec![Step::Run {
                program: program("rustup"),
                args,
            }]
        }
        "yog" => vec![Step::Run {
            program: program("cargo"),
            args: strings(&["install", "yog-cli"]),
        }],
        "cargo-zigbuild" => vec![Step::Run {
            program: program("cargo"),
            args: strings(&["install", "cargo-zigbuild"]),
        }],
        "zig" => vec![Step::Zig {
            dest: tools.join("zig"),
        }],
        "loader" => {
            let dest = report
                .loader_repo
                .clone()
                .map(PathBuf::from)
                .unwrap_or_else(|| tools.join("Yog-Mod-Loader"));
            if component.status == Status::Installed {
                vec![Step::Run {
                    program: PathBuf::from("git"),
                    args: vec![
                        "-C".into(),
                        dest.to_string_lossy().into_owned(),
                        "pull".into(),
                        "--ff-only".into(),
                    ],
                }]
            } else {
                vec![Step::Run {
                    program: PathBuf::from("git"),
                    args: vec![
                        "clone".into(),
                        "--depth".into(),
                        "1".into(),
                        LOADER_REPO_URL.into(),
                        dest.to_string_lossy().into_owned(),
                    ],
                }]
            }
        }
        jdk if jdk.starts_with("jdk-") => {
            let major: u32 = jdk["jdk-".len()..]
                .parse()
                .map_err(|_| format!("bad JDK id '{jdk}'"))?;
            let url = adoptium_url(major, std::env::consts::OS, std::env::consts::ARCH)
                .ok_or("no Temurin JDK build for this platform")?;
            let archive = downloads.join(format!(
                "temurin-{major}.{}",
                if cfg!(windows) { "zip" } else { "tar.gz" }
            ));
            vec![
                Step::Download {
                    url,
                    dest: archive.clone(),
                },
                Step::Extract {
                    archive: archive.clone(),
                    dest: tools.join("jdk"),
                },
                Step::Remove { path: archive },
            ]
        }
        other => return Err(format!("'{other}' can't be installed from Yog IDLE")),
    })
}

/// What an install reports while it runs.
pub enum Event {
    Line(String),
    Progress {
        fraction: Option<f64>,
        message: String,
    },
}

pub struct Exec<'a> {
    pub cancel: &'a AtomicBool,
    pub emit: &'a (dyn Fn(Event) + Sync),
    pub env: &'a HashMap<String, String>,
}

impl Exec<'_> {
    fn cancelled(&self) -> Result<(), String> {
        if self.cancel.load(Ordering::SeqCst) {
            Err("cancelled".into())
        } else {
            Ok(())
        }
    }

    fn line(&self, text: impl Into<String>) {
        (self.emit)(Event::Line(text.into()));
    }

    /// Runs `cmd`, streaming its output as lines, killing it on cancel.
    fn run(&self, mut cmd: Command, what: &str) -> Result<(), String> {
        self.line(format!("> {what}"));
        cmd.envs(self.env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("{what}: {e}"))?;
        std::thread::scope(|scope| {
            let out = child.stdout.take();
            let err = child.stderr.take();
            for stream in [
                out.map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
                err.map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
            ]
            .into_iter()
            .flatten()
            {
                scope.spawn(move || {
                    // cargo/rustup redraw progress with '\r' — each redraw is a line here.
                    let mut reader = BufReader::new(stream);
                    let mut buf = Vec::new();
                    while reader.read_until(b'\n', &mut buf).unwrap_or(0) > 0 {
                        for part in String::from_utf8_lossy(&buf).split('\r') {
                            let text = part.trim_end();
                            if !text.is_empty() {
                                self.line(text.to_string());
                            }
                        }
                        buf.clear();
                    }
                });
            }
            loop {
                match child.try_wait() {
                    Ok(Some(status)) if status.success() => return Ok(()),
                    Ok(Some(status)) => return Err(format!("{what} exited with {status}")),
                    Ok(None) if self.cancel.load(Ordering::SeqCst) => {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err("cancelled".into());
                    }
                    Ok(None) => std::thread::sleep(Duration::from_millis(100)),
                    Err(e) => return Err(e.to_string()),
                }
            }
        })
    }

    /// `curl` into `dest`, reporting progress from the file's growth
    /// against the size a HEAD request announced.
    fn download(&self, url: &str, dest: &Path) -> Result<(), String> {
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let total = SystemProbe
            .run(Path::new("curl"), &["-sfIL", url])
            .and_then(|headers| content_length(&headers));
        self.line(format!("> download {url}"));
        let mut child = Command::new("curl")
            .args(["-fsSL", "--retry", "2", "-o"])
            .arg(dest)
            .arg(url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("curl: {e}"))?;
        loop {
            let size = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
            (self.emit)(Event::Progress {
                fraction: total.map(|t| (size as f64 / t.max(1) as f64).min(1.0)),
                message: format!("{:.1} MB", size as f64 / 1_048_576.0),
            });
            match child.try_wait() {
                Ok(Some(status)) if status.success() => return Ok(()),
                Ok(Some(status)) => {
                    let mut err = String::new();
                    if let Some(mut stderr) = child.stderr.take() {
                        let _ = std::io::Read::read_to_string(&mut stderr, &mut err);
                    }
                    let _ = std::fs::remove_file(dest);
                    return Err(format!("download failed ({status}): {}", err.trim()));
                }
                Ok(None) if self.cancel.load(Ordering::SeqCst) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = std::fs::remove_file(dest);
                    return Err("cancelled".into());
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(250)),
                Err(e) => return Err(e.to_string()),
            }
        }
    }

    fn extract(&self, archive: &Path, dest: &Path) -> Result<(), String> {
        std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
        let mut cmd = Command::new("tar");
        cmd.arg("-xf").arg(archive).arg("-C").arg(dest);
        self.run(cmd, &format!("extract {}", archive.display()))
    }

    fn step(&self, step: &Step, downloads: &Path) -> Result<(), String> {
        self.cancelled()?;
        match step {
            Step::Download { url, dest } => self.download(url, dest),
            Step::Extract { archive, dest } => self.extract(archive, dest),
            Step::Run { program, args } => {
                let mut cmd = Command::new(program);
                cmd.args(args);
                self.run(cmd, &format!("{} {}", program.display(), args.join(" ")))
            }
            Step::MakeExecutable { path } => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
                        .map_err(|e| e.to_string())?;
                }
                let _ = path;
                Ok(())
            }
            Step::Remove { path } => {
                let _ = std::fs::remove_file(path);
                Ok(())
            }
            Step::Zig { dest } => {
                let index_file = downloads.join("zig-index.json");
                self.download("https://ziglang.org/download/index.json", &index_file)?;
                let index = std::fs::read_to_string(&index_file).map_err(|e| e.to_string())?;
                let _ = std::fs::remove_file(&index_file);
                let (version, url) =
                    zig_release(&index, &zig_host()).ok_or("no zig release for this platform")?;
                self.line(format!("zig {version}"));
                let name = url.rsplit('/').next().unwrap_or("zig-archive").to_string();
                let archive = downloads.join(name);
                self.download(&url, &archive)?;
                let result = self.extract(&archive, dest);
                let _ = std::fs::remove_file(&archive);
                result
            }
        }
    }
}

/// The last `Content-Length` of a (redirect-following) `curl -I` response.
pub fn content_length(headers: &str) -> Option<u64> {
    headers
        .lines()
        .filter_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.trim()
                .eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse().ok())?
        })
        .next_back()
}

pub fn execute(steps: &[Step], exec: &Exec, downloads: &Path) -> Result<(), String> {
    for step in steps {
        exec.step(step, downloads)?;
    }
    Ok(())
}

// ── Run target presets ──────────────────────────────────────────────────────

/// A `[run.<id>]` for one loader + Minecraft version of the loader checkout
/// (Project Properties > Debug > "Add Run Target") — the same shape as the
/// example mods' targets, with `JAVA_HOME` from the Environment options.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunPreset {
    pub id: String,
    pub name: String,
    pub export_dir: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: Vec<String>,
    pub java_major: Option<u32>,
    /// No JDK of `java_major` found — `env` has no `JAVA_HOME` then.
    pub java_missing: bool,
}

/// The JDK home for `major`: the one chosen in the options, else the newest detected.
pub fn java_home_for(settings: &Settings, jdks: &[Jdk], major: u32) -> Option<String> {
    let configured = settings
        .jdks
        .get(&major.to_string())
        .map(|h| h.trim())
        .filter(|h| !h.is_empty());
    match configured {
        Some(home) => Some(home.to_string()),
        None => jdks
            .iter()
            .find(|j| j.major == major)
            .map(|j| j.home.clone()),
    }
}

/// `dir` as the project's `yog.toml` should spell it: relative when it's a
/// sibling of the project (portable across machines, like the examples).
fn manifest_path_of(dir: &Path, project_root: &Path) -> String {
    if let (Some(base), Some(parent), Some(name)) =
        (project_root.parent(), dir.parent(), dir.file_name())
        && base == parent
    {
        return format!("../{}", name.to_string_lossy());
    }
    dir.to_string_lossy().into_owned()
}

pub fn run_presets(probe: &dyn Probe, settings: &Settings, project_root: &Path) -> Vec<RunPreset> {
    let Some(loader) =
        find_loader_repo(probe, settings, Some(project_root)).filter(|d| is_loader_repo(probe, d))
    else {
        return Vec::new();
    };
    let jdks = detect_jdks(probe, &tools_dir(settings));
    let base = manifest_path_of(&loader, project_root);
    let gradlew = if cfg!(windows) {
        "gradlew.bat"
    } else {
        "./gradlew"
    };
    let mut presets = Vec::new();
    for (platform, label) in [
        ("fabric", "Fabric"),
        ("neoforge", "NeoForge"),
        ("forge", "Forge"),
    ] {
        let mut versions: Vec<(String, Option<u32>)> = probe
            .list_files(&loader.join(platform).join("versions"))
            .into_iter()
            .filter(|p| p.extension().is_some_and(|e| e == "properties"))
            .filter_map(|p| {
                let mc = p.file_stem()?.to_string_lossy().into_owned();
                let java = probe.read(&p).and_then(|t| parse_java_version_property(&t));
                Some((mc, java))
            })
            .collect();
        versions.sort_by(|a, b| compare_versions(&b.0, &a.0));
        for (mc, java) in versions {
            let java_home = java.and_then(|major| java_home_for(settings, &jdks, major));
            presets.push(RunPreset {
                id: format!("{platform}-{mc}"),
                name: format!("{label} {mc}"),
                export_dir: format!("{base}/{platform}/run/yog-mods"),
                command: gradlew.to_string(),
                args: vec!["runClient".into(), format!("-Pminecraft_version={mc}")],
                cwd: format!("{base}/{platform}"),
                env: java_home.iter().map(|h| format!("JAVA_HOME={h}")).collect(),
                java_major: java,
                java_missing: java.is_some() && java_home.is_none(),
            });
        }
    }
    presets
}

// ── Commands ────────────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    component: String,
    fraction: Option<f64>,
    message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DonePayload {
    component: String,
    success: bool,
    cancelled: bool,
    error: Option<String>,
}

#[tauri::command]
pub async fn environment_detect(
    state: State<'_, EnvironmentState>,
    project_root: Option<String>,
    check_latest: bool,
) -> Result<Report, String> {
    let settings = state.settings();
    tauri::async_runtime::spawn_blocking(move || {
        detect(
            &SystemProbe,
            &settings,
            project_root.as_deref().map(Path::new),
            check_latest,
        )
    })
    .await
    .map_err(|e| e.to_string())
}

/// Run targets the loader checkout offers, for Project Properties > Debug.
#[tauri::command]
pub async fn environment_run_presets(
    state: State<'_, EnvironmentState>,
    project_root: String,
) -> Result<Vec<RunPreset>, String> {
    let settings = state.settings();
    tauri::async_runtime::spawn_blocking(move || {
        run_presets(&SystemProbe, &settings, Path::new(&project_root))
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn environment_settings_set(state: State<'_, EnvironmentState>, settings: Settings) {
    *state.settings.write().unwrap() = settings;
}

/// Installs `components` one after another (each planned from a fresh
/// detection, so e.g. the toolchain step finds the rustup just installed).
/// Output goes to the Environment source; `environment-progress` and
/// `environment-install-done` (per component) and
/// `environment-install-finished` (all) report the rest. One batch at a
/// time; stop it with `environment_cancel`.
#[tauri::command]
pub fn environment_install(
    app: AppHandle,
    state: State<'_, EnvironmentState>,
    components: Vec<String>,
    project_root: Option<String>,
) -> Result<(), String> {
    let cancel = {
        let mut slot = state.install.lock().unwrap();
        if slot.is_some() {
            return Err("an install is already running".into());
        }
        let flag = Arc::new(AtomicBool::new(false));
        *slot = Some(flag.clone());
        flag
    };
    let downloads = std::env::temp_dir().join(format!("yog-idle-downloads-{}", std::process::id()));
    std::thread::spawn(move || {
        let state = app.state::<EnvironmentState>();
        for id in components {
            if cancel.load(Ordering::SeqCst) {
                break;
            }
            let settings = state.settings();
            let _ = app.emit(OUTPUT_ENVIRONMENT, format!("==> {id}"));
            let report = detect(
                &SystemProbe,
                &settings,
                project_root.as_deref().map(Path::new),
                false,
            );
            let env = tool_env(&settings, &[]);
            let emit_app = app.clone();
            let emit_id = id.clone();
            let emit = move |event: Event| match event {
                Event::Line(line) => {
                    let _ = emit_app.emit(OUTPUT_ENVIRONMENT, line);
                }
                Event::Progress { fraction, message } => {
                    let _ = emit_app.emit(
                        "environment-progress",
                        ProgressPayload {
                            component: emit_id.clone(),
                            fraction,
                            message,
                        },
                    );
                }
            };
            let result = plan(&id, &report, &settings, &downloads).and_then(|steps| {
                execute(
                    &steps,
                    &Exec {
                        cancel: &cancel,
                        emit: &emit,
                        env: &env,
                    },
                    &downloads,
                )
            });
            let cancelled = cancel.load(Ordering::SeqCst);
            let line = match &result {
                Ok(()) => format!("==> {id}: done"),
                Err(_) if cancelled => format!("==> {id}: cancelled"),
                Err(e) => format!("[error] {id}: {e}"),
            };
            let _ = app.emit(OUTPUT_ENVIRONMENT, line);
            let failed = result.is_err();
            let _ = app.emit(
                "environment-install-done",
                DonePayload {
                    component: id,
                    success: !failed,
                    cancelled,
                    error: result.err(),
                },
            );
            if failed {
                break;
            }
        }
        let _ = std::fs::remove_dir_all(&downloads);
        *state.install.lock().unwrap() = None;
        let _ = app.emit("environment-install-finished", ());
    });
    Ok(())
}

#[tauri::command]
pub fn environment_cancel(state: State<'_, EnvironmentState>) {
    if let Some(flag) = state.install.lock().unwrap().as_ref() {
        flag.store(true, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct FakeProbe {
        /// `"program-file-name arg arg"` → stdout.
        outputs: HashMap<String, String>,
        files: HashMap<PathBuf, String>,
        dirs: Vec<PathBuf>,
        env: HashMap<String, String>,
        calls: RefCell<Vec<String>>,
    }

    impl FakeProbe {
        fn file(mut self, path: impl Into<PathBuf>, text: &str) -> Self {
            let path = path.into();
            let mut parent = path.parent();
            while let Some(p) = parent {
                if !self.dirs.contains(&p.to_path_buf()) {
                    self.dirs.push(p.to_path_buf());
                }
                parent = p.parent();
            }
            self.files.insert(path, text.into());
            self
        }
        fn out(mut self, cmd: &str, text: &str) -> Self {
            self.outputs.insert(cmd.into(), text.into());
            self
        }
    }

    impl Probe for FakeProbe {
        fn run(&self, program: &Path, args: &[&str]) -> Option<String> {
            let name = program.file_name()?.to_string_lossy().into_owned();
            let key = std::iter::once(name.as_str())
                .chain(args.iter().copied())
                .collect::<Vec<_>>()
                .join(" ");
            self.calls.borrow_mut().push(key.clone());
            self.outputs.get(&key).cloned()
        }
        fn read(&self, path: &Path) -> Option<String> {
            self.files.get(path).cloned()
        }
        fn is_file(&self, path: &Path) -> bool {
            self.files.contains_key(path)
        }
        fn is_dir(&self, path: &Path) -> bool {
            self.dirs.iter().any(|d| d == path)
        }
        fn list_dir(&self, path: &Path) -> Vec<PathBuf> {
            self.dirs
                .iter()
                .filter(|d| d.parent() == Some(path))
                .cloned()
                .collect()
        }
        fn list_files(&self, path: &Path) -> Vec<PathBuf> {
            self.files
                .keys()
                .filter(|f| f.parent() == Some(path))
                .cloned()
                .collect()
        }
        fn env(&self, key: &str) -> Option<String> {
            self.env.get(key).cloned()
        }
    }

    #[test]
    fn parses_versions() {
        assert_eq!(
            parse_version("cargo 1.99.0 (5f94df478 2026-08-27)").as_deref(),
            Some("1.99.0")
        );
        assert_eq!(
            parse_version("rustup 1.29.1 (d95a37b6a 2026-08-13)").as_deref(),
            Some("1.29.1")
        );
        assert_eq!(parse_version("0.16.0\n").as_deref(), Some("0.16.0"));
        assert_eq!(parse_version("yog 0.24.0").as_deref(), Some("0.24.0"));
        assert_eq!(
            parse_version("git version 2.51.0").as_deref(),
            Some("2.51.0")
        );
        assert_eq!(
            parse_version("cargo-zigbuild v0.19.8").as_deref(),
            Some("0.19.8")
        );
        assert_eq!(parse_version("no version here"), None);
        assert!(compare_versions("0.10.0", "0.9.3").is_gt());
        assert!(compare_versions("1.2.3", "1.2.3").is_eq());
        assert!(compare_versions("0.23.0", "0.24.0").is_lt());
    }

    #[test]
    fn parses_cargo_outputs() {
        assert_eq!(
            parse_cargo_search(
                "yog-cli = \"0.24.0\"    # Yog build tool\n... and 2 crates more",
                "yog-cli"
            )
            .as_deref(),
            Some("0.24.0")
        );
        assert_eq!(parse_cargo_search("yog-api = \"1.0\"", "yog-cli"), None);
        let list = "cargo-zigbuild v0.19.8:\n    cargo-zigbuild\nyog-cli v0.23.0:\n    yog\n";
        assert_eq!(
            parse_cargo_install_list(list, "yog-cli").as_deref(),
            Some("0.23.0")
        );
        assert_eq!(parse_cargo_install_list(list, "yog"), None);
        assert_eq!(
            content_length("HTTP/2 302\ncontent-length: 0\n\nHTTP/2 200\nContent-Length: 1234\n"),
            Some(1234)
        );
    }

    #[test]
    fn parses_jdk_release_files() {
        let release = "IMPLEMENTOR=\"Eclipse Adoptium\"\nJAVA_VERSION=\"21.0.5\"\n";
        assert_eq!(
            parse_jdk_release(release),
            Some(("21.0.5".into(), Some("Eclipse Adoptium".into())))
        );
        assert_eq!(java_major("1.8.0_392"), Some(8));
        assert_eq!(java_major("17.0.9"), Some(17));
        assert_eq!(java_major("21"), Some(21));
        assert_eq!(
            parse_java_version_property("loader=x\njava_version = 17\n"),
            Some(17)
        );
    }

    #[test]
    fn picks_newest_stable_zig() {
        let index = r#"{"master":{"x86_64-linux":{"tarball":"m"}},"0.15.1":{"x86_64-linux":{"tarball":"a"}},"0.16.0":{"x86_64-linux":{"tarball":"b"},"x86_64-windows":{"tarball":"w"}},"0.9.0":{"x86_64-linux":{"tarball":"c"}}}"#;
        assert_eq!(
            zig_release(index, "x86_64-linux"),
            Some(("0.16.0".into(), "b".into()))
        );
        assert_eq!(zig_release(index, "aarch64-macos"), None);
    }

    #[test]
    fn adoptium_urls() {
        assert_eq!(
            adoptium_url(21, "linux", "x86_64").unwrap(),
            "https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse?project=jdk"
        );
        assert!(
            adoptium_url(17, "macos", "aarch64")
                .unwrap()
                .contains("/mac/aarch64/")
        );
        assert!(adoptium_url(17, "freebsd", "x86_64").is_none());
    }

    fn settings_with_cargo(cargo_home: &str, tools: &str) -> Settings {
        Settings {
            cargo_home: cargo_home.into(),
            tools_dir: tools.into(),
            ..Default::default()
        }
    }

    #[test]
    fn detects_a_complete_environment_through_yog_doctor() {
        let bin = PathBuf::from("/h/.cargo/bin");
        let doctor = r#"{"cli_version":"0.24.0","rust_toolchain":"1.99","cargo":"cargo 1.99.0","rustup":"rustup 1.29.1","cargo_zigbuild":true,"zig":"0.16.0","targets":[{"tag":"linux-x86_64","triple":"x86_64-unknown-linux-gnu","installed":true},{"tag":"linux-aarch64","triple":"aarch64-unknown-linux-gnu","installed":true},{"tag":"windows-x86_64","triple":"x86_64-pc-windows-gnu","installed":true},{"tag":"macos-x86_64","triple":"x86_64-apple-darwin","installed":true},{"tag":"macos-aarch64","triple":"aarch64-apple-darwin","installed":false}]}"#;
        let probe = FakeProbe::default()
            .file(bin.join(exe("yog")), "")
            .file(bin.join(exe("cargo")), "")
            .file(bin.join(exe("rustup")), "")
            .file(bin.join(exe("cargo-zigbuild")), "")
            .file(
                "/t/zig/zig-x86_64-linux-0.16.0/".to_string() + &exe("zig"),
                "",
            )
            .file("/t/jdk/jdk-21.0.5+11/bin/".to_string() + &exe("java"), "")
            .file("/t/jdk/jdk-21.0.5+11/release", "JAVA_VERSION=\"21.0.5\"\n")
            .file(
                "/p/Yog-Mod-Loader/version.properties",
                "mod_version=0.2.0\n",
            )
            .file(
                "/p/Yog-Mod-Loader/fabric/versions/1.21.1.properties",
                "java_version=21\n",
            )
            .out("yog --version", "yog 0.24.0\n")
            .out("yog doctor --json", doctor)
            .out("cargo search yog-cli --limit 1", "yog-cli = \"0.25.0\"\n")
            .out("rustup --version", "rustup 1.29.1 (x)\n")
            .out("cargo --version", "cargo 1.99.0 (x)\n")
            .out(
                "rustup toolchain list",
                "stable-x86_64-unknown-linux-gnu\n1.99-x86_64-unknown-linux-gnu (default)\n",
            )
            .out("cargo-zigbuild --version", "cargo-zigbuild 0.19.8\n")
            .out("zig version", "0.16.0\n");
        let settings = settings_with_cargo("/h/.cargo", "/t");
        let report = detect(&probe, &settings, Some(Path::new("/p/MyMod")), true);
        let get = |id: &str| report.components.iter().find(|c| c.id == id).unwrap();

        assert_eq!(report.rust_toolchain, "1.99");
        assert_eq!(get("yog").status, Status::Outdated);
        assert_eq!(get("yog").latest.as_deref(), Some("0.25.0"));
        assert_eq!(get("rust").status, Status::Installed);
        assert_eq!(get("toolchain").status, Status::Installed);
        assert_eq!(get("targets").status, Status::Partial);
        assert!(
            get("targets")
                .detail
                .as_deref()
                .unwrap()
                .contains("aarch64-apple-darwin")
        );
        assert_eq!(get("cargo-zigbuild").version.as_deref(), Some("0.19.8"));
        assert_eq!(get("zig").status, Status::Installed);
        assert_eq!(get("jdk-21").status, Status::Installed);
        assert!(
            report.components.iter().all(|c| c.id != "jdk-17"),
            "only the loader's majors"
        );
        assert!(report.jdks[0].managed);
        assert_eq!(get("loader").version.as_deref(), Some("0.2.0"));
        assert_eq!(get("git").status, Status::Missing);
        assert!(!get("git").installable);
        // Read-only probing only.
        assert!(
            probe
                .calls
                .borrow()
                .iter()
                .all(|c| !c.contains("install ") || c == "cargo install --list")
        );
    }

    #[test]
    fn falls_back_without_yog_doctor() {
        let bin = PathBuf::from("/h/.cargo/bin");
        let probe = FakeProbe::default()
            .file(bin.join(exe("yog")), "")
            .file(bin.join(exe("cargo")), "")
            .file(bin.join(exe("rustup")), "")
            .out("cargo install --list", "yog-cli v0.23.0:\n    yog\n")
            .out("rustup toolchain list", "stable-x86_64-unknown-linux-gnu\n")
            .out(
                "rustup target list --installed --toolchain 1.99",
                "x86_64-unknown-linux-gnu\n",
            );
        let settings = Settings {
            host_only: true,
            ..settings_with_cargo("/h/.cargo", "/t")
        };
        let report = detect(&probe, &settings, None, false);
        let get = |id: &str| report.components.iter().find(|c| c.id == id).unwrap();
        assert_eq!(get("yog").version.as_deref(), Some("0.23.0"));
        assert_eq!(get("yog").status, Status::Installed);
        assert_eq!(report.rust_toolchain, FALLBACK_TOOLCHAIN);
        assert_eq!(get("toolchain").status, Status::Missing);
        assert!(!get("zig").required, "host-only builds don't cross-link");
        assert_eq!(get("jdk-17").status, Status::Missing);
        assert_eq!(get("jdk-21").status, Status::Missing);
        assert_eq!(get("loader").status, Status::Missing);
        if host_tag() == Some("linux-x86_64") {
            assert_eq!(get("targets").status, Status::Installed);
        }
    }

    #[test]
    fn plans_installs() {
        let probe = FakeProbe::default();
        let settings = settings_with_cargo("/h/.cargo", "/t");
        let report = detect(&probe, &settings, None, false);
        let downloads = Path::new("/dl");

        // The toolchain needs rustup first.
        assert!(
            plan("toolchain", &report, &settings, downloads)
                .unwrap_err()
                .contains("rust")
        );
        assert!(plan("git", &report, &settings, downloads).is_err());

        let rust = plan("rust", &report, &settings, downloads).unwrap();
        if rustup_host().is_some() {
            assert!(
                matches!(&rust[0], Step::Download { url, .. } if url.starts_with("https://static.rust-lang.org/rustup/dist/"))
            );
            assert!(matches!(&rust[2], Step::Run { args, .. } if args.contains(&"-y".to_string())));
        }

        let jdk = plan("jdk-17", &report, &settings, downloads).unwrap();
        assert!(matches!(&jdk[1], Step::Extract { dest, .. } if dest == Path::new("/t/jdk")));
        assert_eq!(
            plan("zig", &report, &settings, downloads).unwrap(),
            vec![Step::Zig {
                dest: PathBuf::from("/t/zig")
            }]
        );
    }

    #[test]
    fn tool_env_follows_options() {
        let settings = Settings {
            host_only: true,
            yog_api_path: "/src/yog-api".into(),
            yog_path: "/opt/yog/bin/yog".into(),
            ..Default::default()
        };
        let env = tool_env(&settings, &[]);
        assert_eq!(
            env.get("YOG_API_PATH").map(String::as_str),
            Some("/src/yog-api")
        );
        assert!(env["PATH"].starts_with("/opt/yog/bin"));
        assert_eq!(env.get("YOG_TARGETS").map(String::as_str), host_tag());
        let project = tool_env(&settings, &["windows-x86_64".into(), "linux-x86_64".into()]);
        assert_eq!(project["YOG_TARGETS"], "windows-x86_64,linux-x86_64");
        assert_eq!(yog_program(&settings), "/opt/yog/bin/yog");
        assert_eq!(yog_program(&Settings::default()), "yog");
    }

    #[test]
    fn loads_settings_from_state_json() {
        let dir = std::env::temp_dir().join(format!("yog-idle-env-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("state.json");
        std::fs::write(
            &file,
            r#"{"other":1,"environment.settings":{"hostOnly":true,"jdks":{"17":"/j17"}}}"#,
        )
        .unwrap();
        let settings = load_settings_from(&file);
        assert!(settings.host_only);
        assert_eq!(settings.jdks["17"], "/j17");
        assert_eq!(
            load_settings_from(&dir.join("missing.json")),
            Settings::default()
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn run_presets_follow_the_loader_checkout() {
        let probe = FakeProbe::default()
            .file("/p/Yog-Mod-Loader/version.properties", "version=0.30.0\n")
            .file(
                "/p/Yog-Mod-Loader/fabric/versions/1.20.1.properties",
                "java_version=17\n",
            )
            .file(
                "/p/Yog-Mod-Loader/fabric/versions/1.21.1.properties",
                "java_version=21\n",
            )
            .file("/jvm/temurin-21/bin/java", "")
            .file("/jvm/temurin-21/release", "JAVA_VERSION=\"21.0.4\"\n");
        let mut settings = Settings {
            tools_dir: "/tools".into(),
            ..Settings::default()
        };
        settings.jdks.insert("21".into(), "/jvm/temurin-21".into());
        let presets = run_presets(&probe, &settings, Path::new("/p/MyMod"));
        assert_eq!(presets.len(), 2);
        let newest = &presets[0];
        assert_eq!(newest.id, "fabric-1.21.1");
        assert_eq!(newest.name, "Fabric 1.21.1");
        assert_eq!(newest.export_dir, "../Yog-Mod-Loader/fabric/run/yog-mods");
        assert_eq!(newest.cwd, "../Yog-Mod-Loader/fabric");
        assert_eq!(newest.args, ["runClient", "-Pminecraft_version=1.21.1"]);
        assert_eq!(newest.env, ["JAVA_HOME=/jvm/temurin-21"]);
        assert!(!newest.java_missing);
        let older = &presets[1];
        assert_eq!(older.java_major, Some(17));
        assert!(older.java_missing && older.env.is_empty());
        assert!(run_presets(&FakeProbe::default(), &settings, Path::new("/p/MyMod")).is_empty());
    }
}
