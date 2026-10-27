//! Yog IDLE's commands by domain (Substrate's `Domain`) — each domain's own
//! list (`project.rs`, `run.rs`…), gathered here. The app registers them as a plugin per domain
//! (`plugins/`), `build.rs` reads the same lists for their permissions and the
//! front end's copy (`src/plugins.generated.ts`).

pub mod app;
pub mod code;
pub mod debug;
pub mod project;
pub mod run;

use substrate_host_contract::commands::Domain;

/// Every domain.
pub const ALL: &[&Domain] = &[
    &project::DOMAIN,
    &run::DOMAIN,
    &debug::DOMAIN,
    &code::DOMAIN,
    &app::DOMAIN,
];
