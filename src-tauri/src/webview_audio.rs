//! The webview's sound on Linux: WebKitGTK plays it through GStreamer,
//! whose first choice of sink (pulsesink, through PipeWire's PulseAudio
//! server) hands Bluetooth outputs nothing but silence — the designers'
//! sounds were never heard on Bluetooth headphones. PipeWire's own sink
//! plays them; it's put first, unless the user ranks the sinks themselves.
//! Where PipeWire doesn't run, GStreamer falls back to the next sink.

/// GStreamer's list of element ranks, and PipeWire's sink put above all.
const RANKS: &str = "GST_PLUGIN_FEATURE_RANK";
const PIPEWIRE_FIRST: &str = "pipewiresink:MAX";

/// Puts PipeWire's sink first for the webview's GStreamer; before any
/// thread exists (the start of `run()`).
pub fn prefer_pipewire() {
    if cfg!(target_os = "linux") && std::env::var_os(RANKS).is_none() {
        // SAFETY: called at the very start of `run()`, before any thread
        // that could read the environment concurrently.
        unsafe { std::env::set_var(RANKS, PIPEWIRE_FIRST) };
    }
}
