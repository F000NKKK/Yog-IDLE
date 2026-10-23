//! The tools the IDE runs: the `yog` CLI and its service, the environment
//! they start in, formatting, the diagnostics feed.

pub(crate) mod cli;
pub(crate) mod diagnostics_feed;
pub(crate) mod format;
pub(crate) mod tools;
