//! Source control — Visual Studio's Git Changes and Git Repository windows,
//! backend half. Everything goes through the `git` executable rather than a
//! library, so the user's own configuration applies as is: identity, hooks,
//! `pull.rebase`, credential helpers, SSH keys.
//!
//! Git never gets a terminal here: `GIT_TERMINAL_PROMPT=0` makes a remote
//! that needs a password fail instead of waiting for input nobody can type
//! (a credential helper still answers), and `GIT_EDITOR=true` keeps
//! `rebase --continue` and friends from opening an editor. Fetch, pull,
//! push, merge and rebase stream what git prints to the Output window's
//! Source Control source ([`OUTPUT_GIT`]); everything else answers with
//! parsed, machine-readable output (`--porcelain=v2 -z` and friends).

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::AppState;
use crate::events::OUTPUT_GIT;

/// Files larger than this aren't shown in a diff.
const MAX_DIFF_BYTES: usize = 8 * 1024 * 1024;

const GIT_MISSING: &str = "Git isn't installed, or isn't on PATH.";
const AUTH_FAILED: &str = "The remote asked for credentials, and Yog IDLE can't prompt for them. Set up a Git credential helper (such as Git Credential Manager) or an SSH key, then try again.";
const NO_IDENTITY: &str = "Git doesn't know who you are yet — set your name and email in Tools > Options > Source Control, then commit again.";

/// Held by every command that writes to the repository, so two of them (a
/// commit while a fetch runs) never race for `index.lock`.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn write_lock() -> std::sync::MutexGuard<'static, ()> {
    WRITE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A `git` invocation in `dir`, set up for a GUI host: no prompts, no
/// editor, no colors or quoted paths, pathspecs taken literally, no console
/// window on Windows. Its messages are always English (`LC_MESSAGES=C`, the
/// rest of the locale kept) — what failed is recognized by them.
fn git(dir: &Path) -> Command {
    let mut cmd = substrate_platform::process::command("git");
    cmd.current_dir(dir)
        .args(["-c", "core.quotepath=false", "-c", "color.ui=false"])
        .env_remove("LC_ALL")
        .env("LC_MESSAGES", "C")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        .env("GIT_MERGE_AUTOEDIT", "no")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn spawn_error(err: std::io::Error) -> String {
    if err.kind() == std::io::ErrorKind::NotFound {
        GIT_MISSING.to_string()
    } else {
        format!("couldn't start git: {err}")
    }
}

/// What git said about a failure — its stderr, else its stdout (a merge
/// reports conflicts there), mapped to something actionable where we can.
fn failure_text(stderr: &str, stdout: &str) -> String {
    let text = if stderr.trim().is_empty() {
        stdout
    } else {
        stderr
    };
    friendly_error(text.trim())
}

fn friendly_error(text: &str) -> String {
    let lower = text.to_lowercase();
    let auth = [
        "terminal prompts disabled",
        "could not read username",
        "could not read password",
        "authentication failed",
        "permission denied (publickey",
    ];
    if auth.iter().any(|needle| lower.contains(needle)) {
        return AUTH_FAILED.to_string();
    }
    if lower.contains("please tell me who you are") || lower.contains("empty ident name") {
        return NO_IDENTITY.to_string();
    }
    text.to_string()
}

/// Runs `cmd` to completion — its stdout when it succeeded, else what it said went wrong.
fn run(cmd: &mut Command) -> Result<String, String> {
    let out = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(spawn_error)?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if out.status.success() {
        Ok(stdout)
    } else {
        Err(failure_text(&String::from_utf8_lossy(&out.stderr), &stdout))
    }
}

/// Like [`run`], feeding `input` to the command's stdin.
fn run_with_input(cmd: &mut Command, input: &str) -> Result<String, String> {
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(spawn_error)?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(input.as_bytes())
            .map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if out.status.success() {
        Ok(stdout)
    } else {
        Err(failure_text(&String::from_utf8_lossy(&out.stderr), &stdout))
    }
}

/// Runs `cmd` with its output streamed line by line to Output (Source
/// Control), headed by the command line itself. Progress meters (`\r`
/// rewrites) only show their final state.
fn stream(app: &AppHandle, cmd: &mut Command, shown: &str) -> Result<(), String> {
    let _ = app.emit(OUTPUT_GIT, format!("> git {shown}"));
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            let err = spawn_error(e);
            let _ = app.emit(OUTPUT_GIT, format!("[error] {err}"));
            err
        })?;
    let forward = |reader: Box<dyn Read + Send>, app: AppHandle| {
        std::thread::spawn(move || {
            let mut lines = Vec::new();
            for line in BufReader::new(reader).split(b'\n').map_while(Result::ok) {
                let line = String::from_utf8_lossy(&line);
                let line = line.trim_end_matches('\r');
                let line = line.rsplit('\r').next().unwrap_or("").to_string();
                if line.is_empty() {
                    continue;
                }
                let _ = app.emit(OUTPUT_GIT, line.clone());
                lines.push(line);
            }
            lines.join("\n")
        })
    };
    let stdout = forward(Box::new(child.stdout.take().expect("piped")), app.clone());
    let stderr = forward(Box::new(child.stderr.take().expect("piped")), app.clone());
    let status = child.wait().map_err(|e| e.to_string())?;
    let stdout = stdout.join().unwrap_or_default();
    let stderr = stderr.join().unwrap_or_default();
    if status.success() {
        Ok(())
    } else {
        let err = failure_text(&stderr, &stdout);
        let code = status
            .code()
            .map_or_else(|| "a signal".to_string(), |c| c.to_string());
        let _ = app.emit(
            OUTPUT_GIT,
            format!("[error] git {shown} failed (exit code {code})"),
        );
        Err(err)
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

/// The repository `root` (a project folder) belongs to: its working tree's
/// top folder — canonical, like the project roots, so paths built on it
/// match the ones in open tabs — and its `.git` directory. `None` when it
/// isn't in a repository at all.
fn repo_of(root: &Path) -> Result<Option<(PathBuf, PathBuf)>, String> {
    let out = git(root)
        .args(["rev-parse", "--show-toplevel", "--absolute-git-dir"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(spawn_error)?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        // A bare repository or the inside of `.git` has no working tree to show either.
        if err.contains("not a git repository") || err.contains("must be run in a work tree") {
            return Ok(None);
        }
        return Err(friendly_error(err.trim()));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut lines = text.lines();
    let (Some(top), Some(git_dir)) = (lines.next(), lines.next()) else {
        return Ok(None);
    };
    let top = PathBuf::from(top);
    Ok(Some((
        top.canonicalize().unwrap_or(top),
        PathBuf::from(git_dir),
    )))
}

fn require_repo(root: &Path) -> Result<PathBuf, String> {
    repo_of(root)?
        .map(|(top, _)| top)
        .ok_or_else(|| "This folder isn't in a Git repository.".to_string())
}

/// `path` (repo-relative, `/`-separated as git prints it) as a file path under `top`.
pub(crate) fn absolute(top: &Path, path: &str) -> String {
    let mut full = top.to_path_buf();
    full.extend(path.split('/').filter(|s| !s.is_empty()));
    full.to_string_lossy().into_owned()
}

// ── Status ───────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Modified,
    Added,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Untracked,
    Conflicted,
}

impl ChangeKind {
    fn from_code(code: char) -> Option<Self> {
        Some(match code {
            'M' => Self::Modified,
            'A' => Self::Added,
            'D' => Self::Deleted,
            'R' => Self::Renamed,
            'C' => Self::Copied,
            'T' => Self::TypeChanged,
            'U' => Self::Conflicted,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// Repo-relative, `/`-separated.
    pub path: String,
    /// The path before a rename or copy.
    pub orig_path: Option<String>,
    pub kind: ChangeKind,
    /// The file on disk (filled in once the repository root is known).
    pub abs_path: String,
}

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub repo_root: String,
    /// `None` on a detached HEAD.
    pub branch: Option<String>,
    /// The commit checked out — `None` before the first commit.
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub staged: Vec<FileChange>,
    pub unstaged: Vec<FileChange>,
    pub conflicted: Vec<FileChange>,
    pub stashes: u32,
    /// A merge, rebase, cherry-pick or revert waiting to be finished (or aborted).
    pub operation: Option<&'static str>,
}

fn change(path: &str, orig_path: Option<&str>, kind: ChangeKind) -> FileChange {
    FileChange {
        path: path.to_string(),
        orig_path: orig_path.map(str::to_string),
        kind,
        abs_path: String::new(),
    }
}

/// Parses `git status --porcelain=v2 --branch --show-stash -z`.
pub(crate) fn parse_status(raw: &str) -> RepoStatus {
    let mut status = RepoStatus::default();
    let mut records = raw.split('\0');
    while let Some(record) = records.next() {
        if let Some(header) = record.strip_prefix("# ") {
            let (key, value) = header.split_once(' ').unwrap_or((header, ""));
            match key {
                "branch.oid" if value != "(initial)" => status.head = Some(value.to_string()),
                "branch.head" if value != "(detached)" => status.branch = Some(value.to_string()),
                "branch.upstream" => status.upstream = Some(value.to_string()),
                "branch.ab" => {
                    for part in value.split(' ') {
                        if let Some(n) = part.strip_prefix('+') {
                            status.ahead = n.parse().unwrap_or(0);
                        } else if let Some(n) = part.strip_prefix('-') {
                            status.behind = n.parse().unwrap_or(0);
                        }
                    }
                }
                "stash" => status.stashes = value.parse().unwrap_or(0),
                _ => {}
            }
            continue;
        }
        let mut chars = record.chars();
        match chars.next() {
            Some('1') | Some('2') => {
                let renamed = record.starts_with('2');
                // `1 XY sub mH mI mW hH hI path`; `2` adds `Xscore` before the path.
                let fields: Vec<&str> = record.splitn(if renamed { 10 } else { 9 }, ' ').collect();
                let Some(&path) = fields.last() else { continue };
                let xy: Vec<char> = fields
                    .get(1)
                    .map(|s| s.chars().collect())
                    .unwrap_or_default();
                let orig = if renamed { records.next() } else { None };
                if let Some(kind) = xy.first().copied().and_then(ChangeKind::from_code) {
                    let orig = matches!(kind, ChangeKind::Renamed | ChangeKind::Copied)
                        .then_some(orig)
                        .flatten();
                    status.staged.push(change(path, orig, kind));
                }
                if let Some(kind) = xy.get(1).copied().and_then(ChangeKind::from_code) {
                    status.unstaged.push(change(path, None, kind));
                }
            }
            Some('u') => {
                if let Some(path) = record.splitn(11, ' ').nth(10) {
                    status
                        .conflicted
                        .push(change(path, None, ChangeKind::Conflicted));
                }
            }
            Some('?') => {
                if let Some(path) = record.get(2..) {
                    status
                        .unstaged
                        .push(change(path, None, ChangeKind::Untracked));
                }
            }
            _ => {}
        }
    }
    status
}

fn operation_in_progress(git_dir: &Path) -> Option<&'static str> {
    if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
        Some("rebase")
    } else if git_dir.join("MERGE_HEAD").exists() {
        Some("merge")
    } else if git_dir.join("CHERRY_PICK_HEAD").exists() {
        Some("cherryPick")
    } else if git_dir.join("REVERT_HEAD").exists() {
        Some("revert")
    } else {
        None
    }
}

fn status_of(root: &Path) -> Result<Option<RepoStatus>, String> {
    let Some((top, git_dir)) = repo_of(root)? else {
        return Ok(None);
    };
    // `--no-optional-locks`: a refresh never takes `index.lock` from under a commit.
    let raw = run(git(&top).args([
        "--no-optional-locks",
        "status",
        "--porcelain=v2",
        "--branch",
        "--show-stash",
        "--untracked-files=all",
        "-z",
    ]))?;
    let mut status = parse_status(&raw);
    for file in status
        .staged
        .iter_mut()
        .chain(&mut status.unstaged)
        .chain(&mut status.conflicted)
    {
        file.abs_path = absolute(&top, &file.path);
    }
    status.repo_root = top.to_string_lossy().into_owned();
    status.operation = operation_in_progress(&git_dir);
    Ok(Some(status))
}

/// The repository's state for Git Changes and the status bar — `None` when
/// `root` isn't in a repository.
#[tauri::command]
pub async fn git_status(
    state: State<'_, AppState>,
    root: String,
) -> Result<Option<RepoStatus>, String> {
    crate::validate_within_roots(&state, Path::new(&root))?;
    blocking(move || status_of(Path::new(&root))).await
}

// ── Staging, undo, commit ───────────────────────────────────────────────────

/// Stages `paths` (repo-relative) — every change when empty. Deletions too.
#[tauri::command]
pub async fn git_stage(
    state: State<'_, AppState>,
    root: String,
    paths: Vec<String>,
) -> Result<(), String> {
    crate::validate_within_roots(&state, Path::new(&root))?;
    blocking(move || {
        let top = require_repo(Path::new(&root))?;
        let _lock = write_lock();
        run(git(&top).args(["add", "--all", "--"]).args(&paths)).map(drop)
    })
    .await
}

fn has_head(top: &Path) -> bool {
    run(git(top).args(["rev-parse", "--verify", "--quiet", "HEAD"])).is_ok()
}

/// Unstages `paths` — everything when empty. Before the first commit there's
/// no HEAD to reset to, so files simply leave the index.
#[tauri::command]
pub async fn git_unstage(
    state: State<'_, AppState>,
    root: String,
    paths: Vec<String>,
) -> Result<(), String> {
    crate::validate_within_roots(&state, Path::new(&root))?;
    blocking(move || {
        let top = require_repo(Path::new(&root))?;
        let _lock = write_lock();
        if !has_head(&top) {
            let mut cmd = git(&top);
            cmd.args(["rm", "--cached", "-r", "-q", "--"]);
            if paths.is_empty() {
                cmd.arg(".");
            } else {
                cmd.args(&paths);
            }
            return run(&mut cmd).map(drop);
        }
        if paths.is_empty() {
            run(git(&top).args(["reset", "-q"])).map(drop)
        } else {
            run(git(&top).args(["reset", "-q", "--"]).args(&paths)).map(drop)
        }
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscardItem {
    path: String,
    orig_path: Option<String>,
    kind: ChangeKind,
    staged: bool,
}

/// Undo Changes: an unstaged change goes back to what's staged (an untracked
/// file is deleted), a staged one back to the last commit — index and disk
/// both (a newly added file is deleted).
#[tauri::command]
pub async fn git_discard(
    state: State<'_, AppState>,
    root: String,
    items: Vec<DiscardItem>,
) -> Result<(), String> {
    crate::validate_within_roots(&state, Path::new(&root))?;
    blocking(move || {
        let top = require_repo(Path::new(&root))?;
        let _lock = write_lock();
        let head = has_head(&top);
        let mut untracked = Vec::new();
        let mut worktree = Vec::new();
        let mut added = Vec::new();
        let mut to_head = Vec::new();
        for item in items {
            match (item.staged, item.kind) {
                (false, ChangeKind::Untracked) => untracked.push(item.path),
                (false, _) => worktree.push(item.path),
                (true, ChangeKind::Added | ChangeKind::Copied) => added.push(item.path),
                (true, _) if !head => added.push(item.path),
                (true, ChangeKind::Renamed) => {
                    added.push(item.path);
                    to_head.extend(item.orig_path);
                }
                (true, _) => to_head.push(item.path),
            }
        }
        if !untracked.is_empty() {
            run(git(&top).args(["clean", "-f", "-q", "--"]).args(&untracked))?;
        }
        if !worktree.is_empty() {
            run(git(&top).args(["checkout", "-q", "--"]).args(&worktree))?;
        }
        if !added.is_empty() {
            run(git(&top).args(["rm", "-f", "-q", "-r", "--"]).args(&added))?;
        }
        if !to_head.is_empty() {
            run(git(&top)
                .args(["checkout", "-q", "HEAD", "--"])
                .args(&to_head))?;
        }
        Ok(())
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    pub hash: String,
    pub subject: String,
}

/// Commits what's staged — or, with `stage_all`, every change (Commit All).
/// `amend` with an empty message keeps the last commit's.
#[tauri::command]
pub async fn git_commit(
    state: State<'_, AppState>,
    root: String,
    message: String,
    amend: bool,
    stage_all: bool,
) -> Result<CommitResult, String> {
    crate::validate_within_roots(&state, Path::new(&root))?;
    blocking(move || {
        let top = require_repo(Path::new(&root))?;
        let _lock = write_lock();
        if stage_all {
            run(git(&top).args(["add", "--all"]))?;
        }
        let mut cmd = git(&top);
        cmd.args(["commit", "-q", "--cleanup=strip"]);
        if amend {
            cmd.arg("--amend");
        }
        if amend && message.trim().is_empty() {
            run(cmd.arg("--no-edit"))?;
        } else {
            run_with_input(cmd.args(["-F", "-"]), &message)?;
        }
        let out = run(git(&top).args(["log", "-1", "--format=%h%x1f%s"]))?;
        let (hash, subject) = out
            .trim_end()
            .split_once('\x1f')
            .unwrap_or((out.trim_end(), ""));
        Ok(CommitResult {
            hash: hash.to_string(),
            subject: subject.to_string(),
        })
    })
    .await
}

/// The last commit's full message — what Amend starts from.
#[tauri::command]
pub async fn git_last_message(state: State<'_, AppState>, root: String) -> Result<String, String> {
    crate::validate_within_roots(&state, Path::new(&root))?;
    blocking(move || {
        let top = require_repo(Path::new(&root))?;
        run(git(&top).args(["log", "-1", "--format=%B"])).map(|m| m.trim_end().to_string())
    })
    .await
}

// ── Diffs ───────────────────────────────────────────────────────────────────

/// One side of a diff: `rev` is a commit (anything `git rev-parse` takes),
/// `"INDEX"` for what's staged, `"WORKTREE"` for the file on disk, or empty
/// for nothing (the file didn't exist there).
#[derive(Deserialize)]
pub struct DiffSide {
    rev: String,
    /// Repo-relative.
    path: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiffTexts {
    pub left: Option<String>,
    pub right: Option<String>,
    /// Either side isn't text (or is too large to show).
    pub binary: bool,
}

/// A blob's text, `None` if it doesn't exist there; `Err` only for binary content.
fn side_text(top: &Path, side: &DiffSide) -> Result<Option<String>, ()> {
    let bytes = match side.rev.as_str() {
        "" => return Ok(None),
        "WORKTREE" => match std::fs::read(absolute(top, &side.path)) {
            Ok(bytes) => bytes,
            Err(_) => return Ok(None),
        },
        rev => {
            let spec = if rev == "INDEX" {
                format!(":{}", side.path)
            } else {
                format!("{rev}:{}", side.path)
            };
            match git(top)
                .args(["cat-file", "blob", &spec])
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .output()
            {
                Ok(out) if out.status.success() => out.stdout,
                _ => return Ok(None),
            }
        }
    };
    if bytes.len() > MAX_DIFF_BYTES || bytes.iter().take(8000).any(|&b| b == 0) {
        return Err(());
    }
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

/// Both sides of a file's diff, for the diff view.
#[tauri::command]
pub async fn git_diff_texts(
    state: State<'_, AppState>,
    root: String,
    left: DiffSide,
    right: DiffSide,
) -> Result<DiffTexts, String> {
    crate::validate_within_roots(&state, Path::new(&root))?;
    blocking(move || {
        let top = require_repo(Path::new(&root))?;
        match (side_text(&top, &left), side_text(&top, &right)) {
            (Ok(left), Ok(right)) => Ok(DiffTexts {
                left,
                right,
                binary: false,
            }),
            _ => Ok(DiffTexts {
                binary: true,
                ..DiffTexts::default()
            }),
        }
    })
    .await
}

/// What `path` (absolute) holds in the last commit — the editor's change
/// markers compare against it. `None` for a file outside the repository,
/// not committed yet, or binary.
#[tauri::command]
pub async fn git_head_text(
    state: State<'_, AppState>,
    root: String,
    path: String,
) -> Result<Option<String>, String> {
    crate::validate_within_roots(&state, Path::new(&root))?;
    blocking(move || {
        let Some((top, _)) = repo_of(Path::new(&root))? else {
            return Ok(None);
        };
        let file = Path::new(&path);
        let file = file.canonicalize().unwrap_or_else(|_| file.to_path_buf());
        let Ok(rel) = file.strip_prefix(&top) else {
            return Ok(None);
        };
        let rel: Vec<String> = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect();
        let side = DiffSide {
            rev: "HEAD".into(),
            path: rel.join("/"),
        };
        Ok(side_text(&top, &side).unwrap_or(None))
    })
    .await
}

// ── History ─────────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub hash: String,
    pub short_hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    /// Unix seconds.
    pub date: i64,
    /// Branch and tag names pointing here (`%D`).
    pub refs: Vec<String>,
    pub subject: String,
}

const LOG_FORMAT: &str = "--format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1e";

fn parse_log(raw: &str) -> Vec<CommitInfo> {
    raw.split('\x1e')
        .filter_map(|record| {
            let record = record.trim_start_matches('\n');
            let fields: Vec<&str> = record.split('\x1f').collect();
            let [hash, short, parents, author, email, date, refs, subject] = fields[..] else {
                return None;
            };
            Some(CommitInfo {
                hash: hash.to_string(),
                short_hash: short.to_string(),
                parents: parents.split_whitespace().map(str::to_string).collect(),
                author: author.to_string(),
                email: email.to_string(),
                date: date.parse().unwrap_or(0),
                refs: refs
                    .split(", ")
                    .filter(|r| !r.is_empty())
                    .map(str::to_string)
                    .collect(),
                subject: subject.to_string(),
            })
        })
        .collect()
}

/// A page of `rev`'s history (HEAD when empty), newest first.
#[tauri::command]
pub async fn git_log(
    state: State<'_, AppState>,
    root: String,
    rev: String,
    skip: u32,
    max: u32,
) -> Result<Vec<CommitInfo>, String> {
    crate::validate_within_roots(&state, Path::new(&root))?;
    blocking(move || {
        let top = require_repo(Path::new(&root))?;
        if rev.is_empty() && !has_head(&top) {
            return Ok(Vec::new());
        }
        let rev = if rev.is_empty() {
            "HEAD".to_string()
        } else {
            rev
        };
        let raw = run(git(&top)
            .args(["log", LOG_FORMAT])
            .arg(format!("--skip={skip}"))
            .arg(format!("--max-count={max}"))
            .args([rev.as_str(), "--"]))?;
        Ok(parse_log(&raw))
    })
    .await
}

/// Parses `git diff --name-status -z` (also `diff-tree`'s): `M\0path\0`,
/// `R100\0old\0new\0`.
fn parse_name_status(raw: &str) -> Vec<FileChange> {
    let mut files = Vec::new();
    let mut fields = raw.split('\0').filter(|f| !f.is_empty());
    while let Some(code) = fields.next() {
        let Some(kind) = code.chars().next().and_then(ChangeKind::from_code) else {
            continue;
        };
        let Some(first) = fields.next() else { break };
        if matches!(kind, ChangeKind::Renamed | ChangeKind::Copied) {
            let Some(second) = fields.next() else { break };
            files.push(change(second, Some(first), kind));
        } else {
            files.push(change(first, None, kind));
        }
    }
    files
}

/// The files a commit changed, compared with its first parent.
#[tauri::command]
pub async fn git_commit_files(
    state: State<'_, AppState>,
    root: String,
    hash: String,
) -> Result<Vec<FileChange>, String> {
    crate::validate_within_roots(&state, Path::new(&root))?;
    blocking(move || {
        let top = require_repo(Path::new(&root))?;
        let parents = run(git(&top).args(["rev-list", "--parents", "-n", "1", &hash]))?;
        let raw = match parents.split_whitespace().nth(1) {
            Some(parent) => {
                run(git(&top).args(["diff", "--name-status", "-z", "-M", parent, &hash, "--"]))?
            }
            None => run(git(&top).args([
                "diff-tree",
                "--root",
                "--no-commit-id",
                "-r",
                "-z",
                "--name-status",
                "-M",
                &hash,
            ]))?,
        };
        let mut files = parse_name_status(&raw);
        for file in &mut files {
            file.abs_path = absolute(&top, &file.path);
        }
        Ok(files)
    })
    .await
}

// ── Branches ────────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    /// `main`, `origin/main`.
    pub name: String,
    pub remote: bool,
    pub current: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// The upstream was deleted on the remote.
    pub gone: bool,
    pub hash: String,
    /// The tip commit's date (unix seconds) and subject.
    pub date: i64,
    pub subject: String,
}

const BRANCH_FORMAT: &str = "--format=%(refname)%1f%(refname:short)%1f%(objectname:short)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(HEAD)%1f%(committerdate:unix)%1f%(contents:subject)";

/// `ahead 1, behind 2` / `gone` / empty → (ahead, behind, gone).
fn parse_track(track: &str) -> (u32, u32, bool) {
    let mut result = (0, 0, track.trim() == "gone");
    for part in track.split(", ") {
        if let Some(n) = part.strip_prefix("ahead ") {
            result.0 = n.trim().parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            result.1 = n.trim().parse().unwrap_or(0);
        }
    }
    result
}

fn parse_branches(raw: &str) -> Vec<BranchInfo> {
    raw.lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split('\x1f').collect();
            let [refname, name, hash, upstream, track, head, date, subject] = fields[..] else {
                return None;
            };
            // `origin/HEAD` is just a pointer to the remote's default branch.
            if refname.ends_with("/HEAD") {
                return None;
            }
            let (ahead, behind, gone) = parse_track(track);
            Some(BranchInfo {
                name: name.to_string(),
                remote: refname.starts_with("refs/remotes/"),
                current: head == "*",
                upstream: (!upstream.is_empty()).then(|| upstream.to_string()),
                ahead,
                behind,
                gone,
                hash: hash.to_string(),
                date: date.parse().unwrap_or(0),
                subject: subject.to_string(),
            })
        })
        .collect()
}

/// Every local and remote-tracking branch.
#[tauri::command]
pub async fn git_branches(
    state: State<'_, AppState>,
    root: String,
) -> Result<Vec<BranchInfo>, String> {
    crate::validate_within_roots(&state, Path::new(&root))?;
    blocking(move || {
        let top = require_repo(Path::new(&root))?;
        let raw =
            run(git(&top).args(["for-each-ref", BRANCH_FORMAT, "refs/heads", "refs/remotes"]))?;
        Ok(parse_branches(&raw))
    })
    .await
}

/// Checks out a branch. A remote one (`origin/feature`) gets a local branch
/// tracking it, as Visual Studio does.
#[tauri::command]
pub async fn git_switch(
    state: State<'_, AppState>,
    root: String,
    name: String,
    remote: bool,
) -> Result<(), String> {
    crate::validate_within_roots(&state, Path::new(&root))?;
    blocking(move || {
        let top = require_repo(Path::new(&root))?;
        let _lock = write_lock();
        if remote {
            run(git(&top).args(["switch", "--track", &name])).map(drop)
        } else {
            run(git(&top).args(["switch", &name])).map(drop)
        }
    })
    .await
}

/// New Branch: from `start` (the current commit when empty), checked out or not.
#[tauri::command]
pub async fn git_branch_create(
    state: State<'_, AppState>,
    root: String,
    name: String,
    start: String,
    checkout: bool,
) -> Result<(), String> {
    crate::validate_within_roots(&state, Path::new(&root))?;
    blocking(move || {
        let top = require_repo(Path::new(&root))?;
        let _lock = write_lock();
        let mut cmd = git(&top);
        if checkout {
            cmd.args(["switch", "-c", &name]);
        } else {
            cmd.args(["branch", &name]);
        }
        if !start.is_empty() {
            cmd.arg(&start);
        }
        run(&mut cmd).map(drop)
    })
    .await
}

/// Deletes a local branch — `force` even when it isn't merged anywhere.
#[tauri::command]
pub async fn git_branch_delete(
    state: State<'_, AppState>,
    root: String,
    name: String,
    force: bool,
) -> Result<(), String> {
    crate::validate_within_roots(&state, Path::new(&root))?;
    blocking(move || {
        let top = require_repo(Path::new(&root))?;
        let _lock = write_lock();
        run(git(&top).args(["branch", if force { "-D" } else { "-d" }, &name])).map(drop)
    })
    .await
}

// ── Remotes and long-running operations ─────────────────────────────────────

fn current_branch(top: &Path) -> Option<String> {
    run(git(top).args(["symbolic-ref", "--quiet", "--short", "HEAD"]))
        .ok()
        .map(|b| b.trim().to_string())
}

fn has_upstream(top: &Path) -> bool {
    run(git(top).args(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).is_ok()
}

/// Where a branch without an upstream gets pushed: its own `pushRemote`,
/// the repository's `remote.pushDefault`, `origin`, else the only remote.
fn push_remote(top: &Path, branch: &str) -> Result<String, String> {
    let config = |key: &str| {
        run(git(top).args(["config", "--get", key]))
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    if let Some(remote) =
        config(&format!("branch.{branch}.pushRemote")).or_else(|| config("remote.pushDefault"))
    {
        return Ok(remote);
    }
    let remotes = run(git(top).arg("remote"))?;
    let remotes: Vec<&str> = remotes
        .lines()
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .collect();
    if remotes.contains(&"origin") {
        return Ok("origin".to_string());
    }
    match remotes[..] {
        [only] => Ok(only.to_string()),
        [] => Err("This repository has no remote to push to.".to_string()),
        _ => Err(
            "This branch has no upstream, and there's no \"origin\" remote to push it to."
                .to_string(),
        ),
    }
}

/// Streams a `git` run to Output (see [`stream`]).
fn stream_git(app: &AppHandle, top: &Path, args: &[&str]) -> Result<(), String> {
    stream(app, git(top).args(args), &args.join(" "))
}

fn push(app: &AppHandle, top: &Path) -> Result<(), String> {
    if has_upstream(top) {
        return stream_git(app, top, &["push", "--progress"]);
    }
    // Push and create the upstream, as Visual Studio does for a new branch.
    let branch =
        current_branch(top).ok_or("A detached HEAD can't be pushed — check out a branch first.")?;
    let remote = push_remote(top, &branch)?;
    stream_git(
        app,
        top,
        &["push", "--progress", "--set-upstream", &remote, &branch],
    )
}

fn pull(app: &AppHandle, top: &Path) -> Result<(), String> {
    if !has_upstream(top) {
        return Err(
            "The current branch has no upstream branch to pull from. Push it first.".to_string(),
        );
    }
    stream_git(app, top, &["pull", "--progress"])
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum RemoteOp {
    Fetch,
    Pull,
    Push,
    /// Pull, then push.
    Sync,
}

/// Fetch / Pull / Push / Sync, output streamed to Output (Source Control).
#[tauri::command]
pub async fn git_remote(
    app: AppHandle,
    state: State<'_, AppState>,
    root: String,
    op: RemoteOp,
) -> Result<(), String> {
    crate::validate_within_roots(&state, Path::new(&root))?;
    blocking(move || {
        let top = require_repo(Path::new(&root))?;
        let _lock = write_lock();
        match op {
            RemoteOp::Fetch => stream_git(&app, &top, &["fetch", "--all", "--progress"]),
            RemoteOp::Pull => pull(&app, &top),
            RemoteOp::Push => push(&app, &top),
            RemoteOp::Sync => {
                pull(&app, &top)?;
                push(&app, &top)
            }
        }
    })
    .await
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum BranchOp {
    /// Merge the branch into the current one.
    Merge,
    /// Rebase the current branch onto it.
    Rebase,
}

/// Merge into Current / Rebase onto — streamed, since either can stop on conflicts.
#[tauri::command]
pub async fn git_integrate(
    app: AppHandle,
    state: State<'_, AppState>,
    root: String,
    op: BranchOp,
    branch: String,
) -> Result<(), String> {
    crate::validate_within_roots(&state, Path::new(&root))?;
    blocking(move || {
        let top = require_repo(Path::new(&root))?;
        let _lock = write_lock();
        match op {
            BranchOp::Merge => stream_git(&app, &top, &["merge", "--no-edit", &branch]),
            BranchOp::Rebase => stream_git(&app, &top, &["rebase", &branch]),
        }
    })
    .await
}

/// Aborts (or, `continue_`, continues) the merge/rebase/cherry-pick/revert in progress.
#[tauri::command]
pub async fn git_operation(
    app: AppHandle,
    state: State<'_, AppState>,
    root: String,
    continue_: bool,
) -> Result<(), String> {
    crate::validate_within_roots(&state, Path::new(&root))?;
    blocking(move || {
        let Some((top, git_dir)) = repo_of(Path::new(&root))? else {
            return Err("This folder isn't in a Git repository.".to_string());
        };
        let _lock = write_lock();
        let command = match operation_in_progress(&git_dir) {
            Some("rebase") => "rebase",
            Some("merge") => "merge",
            Some("cherryPick") => "cherry-pick",
            Some("revert") => "revert",
            _ => return Err("No merge or rebase is in progress.".to_string()),
        };
        // A merge is continued by committing it.
        if continue_ && command == "merge" {
            return stream_git(&app, &top, &["commit", "--no-edit"]);
        }
        stream_git(
            &app,
            &top,
            &[command, if continue_ { "--continue" } else { "--abort" }],
        )
    })
    .await
}

/// The folder a clone of `url` goes into by default — its last path segment, minus `.git`.
fn clone_dir_name(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches(['/', '\\']);
    let last = trimmed.rsplit(['/', '\\', ':']).next().unwrap_or(trimmed);
    let name = last.strip_suffix(".git").unwrap_or(last);
    if name.is_empty() {
        "repository".to_string()
    } else {
        name.to_string()
    }
}

/// Clone a Repository: into `parent/<name>` — a folder the user picked in
/// the native dialog, so it becomes an allowed path the way Open Folder's
/// does. Resolves with the new working tree's path, to open.
#[tauri::command]
pub async fn git_clone(
    app: AppHandle,
    url: String,
    parent: String,
    name: String,
) -> Result<String, String> {
    blocking(move || {
        let name = if name.trim().is_empty() {
            clone_dir_name(&url)
        } else {
            name.trim().to_string()
        };
        let dest = Path::new(&parent).join(&name);
        if dest.exists()
            && std::fs::read_dir(&dest)
                .map(|mut d| d.next().is_some())
                .unwrap_or(true)
        {
            return Err(format!(
                "{} already exists and isn't empty.",
                dest.display()
            ));
        }
        let dest_text = dest.to_string_lossy().into_owned();
        stream(
            &app,
            git(Path::new(&parent)).args(["clone", "--progress", "--", &url, &dest_text]),
            &format!("clone {url} {dest_text}"),
        )?;
        Ok(dest_text)
    })
    .await
}

/// Create Git Repository: `git init` in the project folder, on `branch` (git's own default when empty).
#[tauri::command]
pub async fn git_init(
    app: AppHandle,
    state: State<'_, AppState>,
    root: String,
    branch: String,
) -> Result<(), String> {
    crate::validate_within_roots(&state, Path::new(&root))?;
    blocking(move || {
        let mut args = vec!["init"];
        if !branch.trim().is_empty() {
            args.extend(["--initial-branch", branch.trim()]);
        }
        stream_git(&app, Path::new(&root), &args)
    })
    .await
}

// ── Stashes ─────────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashInfo {
    pub index: u32,
    pub message: String,
    pub date: i64,
}

fn parse_stashes(raw: &str) -> Vec<StashInfo> {
    raw.lines()
        .filter_map(|line| {
            let (selector, rest) = line.split_once('\x1f')?;
            let (message, date) = rest.split_once('\x1f')?;
            let index = selector
                .strip_prefix("stash@{")?
                .strip_suffix('}')?
                .parse()
                .ok()?;
            Some(StashInfo {
                index,
                message: message.to_string(),
                date: date.parse().unwrap_or(0),
            })
        })
        .collect()
}

#[tauri::command]
pub async fn git_stash_list(
    state: State<'_, AppState>,
    root: String,
) -> Result<Vec<StashInfo>, String> {
    crate::validate_within_roots(&state, Path::new(&root))?;
    blocking(move || {
        let top = require_repo(Path::new(&root))?;
        let raw = run(git(&top).args(["stash", "list", "--format=%gd%x1f%gs%x1f%at"]))?;
        Ok(parse_stashes(&raw))
    })
    .await
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum StashMode {
    /// Stash All — untracked files included.
    All,
    /// Stash All and Keep Staged.
    KeepIndex,
    /// Stash Staged.
    Staged,
}

#[tauri::command]
pub async fn git_stash_push(
    state: State<'_, AppState>,
    root: String,
    message: String,
    mode: StashMode,
) -> Result<(), String> {
    crate::validate_within_roots(&state, Path::new(&root))?;
    blocking(move || {
        let top = require_repo(Path::new(&root))?;
        let _lock = write_lock();
        let mut cmd = git(&top);
        cmd.args(["stash", "push", "--quiet"]);
        match mode {
            StashMode::All => cmd.arg("--include-untracked"),
            StashMode::KeepIndex => cmd.args(["--include-untracked", "--keep-index"]),
            StashMode::Staged => cmd.arg("--staged"),
        };
        if !message.trim().is_empty() {
            cmd.args(["--message", message.trim()]);
        }
        run(&mut cmd).map(drop)
    })
    .await
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum StashOp {
    Apply,
    Pop,
    Drop,
}

#[tauri::command]
pub async fn git_stash_op(
    state: State<'_, AppState>,
    root: String,
    index: u32,
    op: StashOp,
) -> Result<(), String> {
    crate::validate_within_roots(&state, Path::new(&root))?;
    blocking(move || {
        let top = require_repo(Path::new(&root))?;
        let _lock = write_lock();
        let verb = match op {
            StashOp::Apply => "apply",
            StashOp::Pop => "pop",
            StashOp::Drop => "drop",
        };
        run(git(&top).args(["stash", verb, "--quiet", &format!("stash@{{{index}}}")])).map(drop)
    })
    .await
}

// ── Global settings ─────────────────────────────────────────────────────────

/// Git's own global settings that Tools > Options > Source Control edits —
/// nothing else may be written through `git_config_set`.
const GLOBAL_KEYS: &[&str] = &[
    "user.name",
    "user.email",
    "init.defaultBranch",
    "fetch.prune",
    "pull.rebase",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalConfig {
    /// `git --version`'s output — `None` when git can't be run.
    pub version: Option<String>,
    /// Key → value, for the keys that are set.
    pub values: std::collections::HashMap<String, String>,
}

#[tauri::command]
pub async fn git_config_get() -> Result<GlobalConfig, String> {
    blocking(|| {
        let home = dirs::home_dir().unwrap_or_else(std::env::temp_dir);
        let Ok(version) = run(git(&home).arg("--version")) else {
            return Ok(GlobalConfig {
                version: None,
                values: Default::default(),
            });
        };
        let values = GLOBAL_KEYS
            .iter()
            .filter_map(|key| {
                let value = run(git(&home).args(["config", "--global", "--get", key])).ok()?;
                Some((key.to_string(), value.trim_end().to_string()))
            })
            .collect();
        Ok(GlobalConfig {
            version: Some(version.trim().to_string()),
            values,
        })
    })
    .await
}

/// Sets one of [`GLOBAL_KEYS`] in `~/.gitconfig` — removes it when `value` is empty.
#[tauri::command]
pub async fn git_config_set(key: String, value: String) -> Result<(), String> {
    if !GLOBAL_KEYS.contains(&key.as_str()) {
        return Err(format!("{key} can't be set from here"));
    }
    blocking(move || {
        let home = dirs::home_dir().unwrap_or_else(std::env::temp_dir);
        if value.trim().is_empty() {
            // Exit code 5: it wasn't set to begin with.
            let _ = run(git(&home).args(["config", "--global", "--unset-all", &key]));
            return Ok(());
        }
        run(git(&home).args(["config", "--global", &key, value.trim()])).map(drop)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_headers() {
        let raw = "# branch.oid 1234abcd\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -3\0# stash 4\0";
        let status = parse_status(raw);
        assert_eq!(status.head.as_deref(), Some("1234abcd"));
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
        assert_eq!((status.ahead, status.behind, status.stashes), (2, 3, 4));
    }

    #[test]
    fn parses_initial_and_detached() {
        let status = parse_status("# branch.oid (initial)\0# branch.head (detached)\0");
        assert_eq!(status.head, None);
        assert_eq!(status.branch, None);
        assert_eq!(status.upstream, None);
    }

    #[test]
    fn splits_staged_and_unstaged() {
        let raw = concat!(
            "1 M. N... 100644 100644 100644 aaa bbb src/lib.rs\0",
            "1 .M N... 100644 100644 100644 aaa aaa README.md\0",
            "1 MD N... 100644 100644 000000 aaa bbb both ways.txt\0",
            "1 A. N... 000000 100644 100644 000 bbb new file.rs\0",
            "? untracked dir/file with spaces.txt\0",
        );
        let status = parse_status(raw);
        let staged: Vec<_> = status
            .staged
            .iter()
            .map(|f| (f.path.as_str(), f.kind))
            .collect();
        let unstaged: Vec<_> = status
            .unstaged
            .iter()
            .map(|f| (f.path.as_str(), f.kind))
            .collect();
        assert_eq!(
            staged,
            [
                ("src/lib.rs", ChangeKind::Modified),
                ("both ways.txt", ChangeKind::Modified),
                ("new file.rs", ChangeKind::Added),
            ]
        );
        assert_eq!(
            unstaged,
            [
                ("README.md", ChangeKind::Modified),
                ("both ways.txt", ChangeKind::Deleted),
                ("untracked dir/file with spaces.txt", ChangeKind::Untracked),
            ]
        );
    }

    #[test]
    fn parses_renames_with_their_origin() {
        let raw = concat!(
            "2 R. N... 100644 100644 100644 aaa aaa R100 new name.rs\0old name.rs\0",
            "1 .M N... 100644 100644 100644 a a after.rs\0",
        );
        let status = parse_status(raw);
        assert_eq!(
            status.staged,
            [change(
                "new name.rs",
                Some("old name.rs"),
                ChangeKind::Renamed
            )]
        );
        // The record after the rename's extra field still parses.
        assert_eq!(
            status.unstaged,
            [change("after.rs", None, ChangeKind::Modified)]
        );
    }

    #[test]
    fn parses_conflicts() {
        let raw = "u UU N... 100644 100644 100644 100644 a b c conflicted file.rs\0";
        let status = parse_status(raw);
        assert_eq!(
            status.conflicted,
            [change("conflicted file.rs", None, ChangeKind::Conflicted)]
        );
        assert!(status.staged.is_empty() && status.unstaged.is_empty());
    }

    #[test]
    fn parses_name_status() {
        let raw = "M\0src/a.rs\0R087\0old.rs\0new.rs\0A\0added file.txt\0D\0gone.rs\0";
        assert_eq!(
            parse_name_status(raw),
            [
                change("src/a.rs", None, ChangeKind::Modified),
                change("new.rs", Some("old.rs"), ChangeKind::Renamed),
                change("added file.txt", None, ChangeKind::Added),
                change("gone.rs", None, ChangeKind::Deleted),
            ]
        );
    }

    #[test]
    fn parses_log_records() {
        let raw = "abc123\x1fabc\x1fp1 p2\x1fAda\x1fada@example.com\x1f1700000000\x1fHEAD -> main, origin/main\x1fMerge it\x1e\n\
                   def456\x1fdef\x1f\x1fBob\x1fbob@example.com\x1f1600000000\x1f\x1fInitial commit\x1e\n";
        let log = parse_log(raw);
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].parents, ["p1", "p2"]);
        assert_eq!(log[0].refs, ["HEAD -> main", "origin/main"]);
        assert_eq!(log[0].subject, "Merge it");
        assert!(log[1].parents.is_empty() && log[1].refs.is_empty());
        assert_eq!(log[1].date, 1_600_000_000);
    }

    #[test]
    fn parses_branches_and_tracking() {
        let raw = "refs/heads/main\x1fmain\x1fabc\x1forigin/main\x1fahead 1, behind 2\x1f*\x1f1700000000\x1fTip\n\
                   refs/heads/old\x1fold\x1fdef\x1forigin/old\x1fgone\x1f \x1f1600000000\x1fOld\n\
                   refs/remotes/origin/HEAD\x1forigin\x1fabc\x1f\x1f\x1f \x1f1700000000\x1fTip\n\
                   refs/remotes/origin/main\x1forigin/main\x1fabc\x1f\x1f\x1f \x1f1700000000\x1fTip\n";
        let branches = parse_branches(raw);
        assert_eq!(branches.len(), 3);
        assert!(branches[0].current && !branches[0].remote);
        assert_eq!((branches[0].ahead, branches[0].behind), (1, 2));
        assert!(branches[1].gone && !branches[1].current);
        assert!(branches[2].remote && branches[2].upstream.is_none());
        assert_eq!(branches[2].name, "origin/main");
    }

    #[test]
    fn parses_stash_list() {
        let raw = "stash@{0}\x1fOn main: wip\x1f1700000000\nstash@{1}\x1fWIP on dev: abc fix\x1f1600000000\n";
        let stashes = parse_stashes(raw);
        assert_eq!(stashes.len(), 2);
        assert_eq!(stashes[1].index, 1);
        assert_eq!(stashes[0].message, "On main: wip");
    }

    #[test]
    fn names_clone_folders() {
        assert_eq!(
            clone_dir_name("https://github.com/F000NKKK/Yog-IDLE.git"),
            "Yog-IDLE"
        );
        assert_eq!(
            clone_dir_name("git@github.com:F000NKKK/Yog-Pipes.git"),
            "Yog-Pipes"
        );
        assert_eq!(clone_dir_name("git@host:repo"), "repo");
        assert_eq!(clone_dir_name("C:\\repos\\local\\"), "local");
    }

    #[test]
    fn explains_auth_and_identity_failures() {
        assert_eq!(
            friendly_error(
                "fatal: could not read Username for 'https://github.com': terminal prompts disabled"
            ),
            AUTH_FAILED
        );
        assert_eq!(
            friendly_error("Author identity unknown\n\n*** Please tell me who you are."),
            NO_IDENTITY
        );
        assert_eq!(
            friendly_error("error: pathspec 'x' did not match"),
            "error: pathspec 'x' did not match"
        );
    }

    /// End to end against a scratch repository — skipped where git isn't installed.
    #[test]
    fn status_of_a_scratch_repository() {
        let dir = std::env::temp_dir().join(format!("yog-idle-git-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        if run(git(&dir).args(["init", "-q", "--initial-branch", "main"])).is_err() {
            return;
        }
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        let status = status_of(&dir).unwrap().expect("a repository");
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.head, None);
        assert_eq!(
            status.unstaged,
            [FileChange {
                abs_path: absolute(&dir.canonicalize().unwrap(), "a.txt"),
                ..change("a.txt", None, ChangeKind::Untracked)
            }]
        );
        run(git(&dir).args(["add", "a.txt"])).unwrap();
        let staged = status_of(&dir).unwrap().unwrap().staged;
        assert_eq!(staged.len(), 1);
        assert_eq!(staged[0].kind, ChangeKind::Added);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(status_of(&std::env::temp_dir()).is_ok());
    }
}
