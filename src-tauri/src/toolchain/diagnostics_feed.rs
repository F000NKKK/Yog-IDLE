//! What a `yog` run finds, as it finds it: the run writes each diagnostic
//! as a Yog Data frame to the file `YOG_DIAGNOSTICS` names, and a feed
//! passes every frame on to the front end (`BUILD_DIAGNOSTIC`, the frame's
//! bytes) for the Error List — no reading of the run's text.

use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread::JoinHandle;
use std::time::Duration;

use tauri::{AppHandle, Emitter};

/// How often the file is looked at for new frames.
const POLL: Duration = Duration::from_millis(100);
/// What the feeds' files are named from.
const FILE_PREFIX: &str = "yog-idle-diagnostics-";
/// A frame's length prefix.
const LEN_BYTES: usize = size_of::<yog_data::io::Len>();

/// One run's feed: its file, and what reads it. Dropped when the run is
/// over — what's left is passed on, and the file goes.
pub(crate) struct Feed {
    path: PathBuf,
    done: Arc<AtomicBool>,
    reader: Option<JoinHandle<()>>,
}

impl Feed {
    /// A new feed passing what a run reports on to `app`.
    pub(crate) fn open(app: &AppHandle) -> Self {
        static FEEDS: AtomicUsize = AtomicUsize::new(0);
        let n = FEEDS.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("{FILE_PREFIX}{}-{n}", std::process::id()));
        let done = Arc::new(AtomicBool::new(false));
        let reader = {
            let (app, path, done) = (app.clone(), path.clone(), done.clone());
            std::thread::spawn(move || follow(&app, &path, &done))
        };
        Feed {
            path,
            done,
            reader: Some(reader),
        }
    }

    /// The variable a `yog` run is given: where it reports.
    pub(crate) fn env(&self) -> (&'static str, String) {
        (
            yog_ids::env::DIAGNOSTICS,
            self.path.to_string_lossy().into_owned(),
        )
    }
}

impl Drop for Feed {
    fn drop(&mut self) {
        self.done.store(true, Ordering::Relaxed);
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Passes on each whole frame added to the file at `path` until `done`,
/// then what's left.
fn follow(app: &AppHandle, path: &std::path::Path, done: &AtomicBool) {
    let mut pending: Vec<u8> = Vec::new();
    let mut read_to: u64 = 0;
    loop {
        let finished = done.load(Ordering::Relaxed);
        if let Ok(mut file) = std::fs::File::open(path)
            && file.seek(SeekFrom::Start(read_to)).is_ok()
            && let Ok(n) = file.read_to_end(&mut pending)
        {
            read_to += n as u64;
            pass_on(app, &mut pending);
        }
        if finished {
            return;
        }
        std::thread::sleep(POLL);
    }
}

/// Each whole frame at the start of `pending`, passed on and taken off.
fn pass_on(app: &AppHandle, pending: &mut Vec<u8>) {
    let mut at = 0;
    while let Some(len) = pending
        .get(at..at + LEN_BYTES)
        .and_then(|b| b.try_into().ok())
        .map(|b| yog_data::io::Len::from_le_bytes(b) as usize)
        && pending.len() >= at + LEN_BYTES + len
    {
        let end = at + LEN_BYTES + len;
        let _ = app.emit(
            crate::app::events::BUILD_DIAGNOSTIC,
            pending[at..end].to_vec(),
        );
        at = end;
    }
    pending.drain(..at);
}
