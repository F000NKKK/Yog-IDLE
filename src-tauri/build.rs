//! Tauri's build with Yog IDLE's own plugins — a plugin per domain, its
//! commands and default permission from the domain's list
//! (`src/plugins/commands/`) — and the front end's copies of the names it
//! shares: Yog's (`yog-ids`), the plugins' commands and the events.

use std::path::Path;

use tauri_build::{Attributes, DefaultPermissionRule, InlinedPlugin};
use yog_codegen::{Header, Regenerate};
use yog_codegen_typescript::TypeScript;

#[path = "src/plugins/commands/mod.rs"]
mod commands;
#[path = "src/app/events.rs"]
mod events;

/// Where the generated copies go, from this crate.
const YOG_IDS_TS: &str = "../src/data/yogIds.generated.ts";
const HOST_TS: &str = "../src/host.generated.ts";

/// Writes `text` to `path` unless it's there already (no rebuild loop).
fn write(path: &str, text: &str) {
    yog_codegen::write_if_changed(Path::new(path), text).expect("src/ is writable");
}

fn main() {
    write(YOG_IDS_TS, &yog_ids::export::typescript());
    let header = Header {
        tool: "src-tauri/build.rs",
        source: "src-tauri/src/plugins/commands/ and src/app/events.rs",
        regenerate: Regenerate::EveryBuild,
    }
    .comment::<TypeScript>();
    let commands_ts = substrate_host_contract::commands::typescript(
        "yog",
        "Yog IDLE's commands by domain: `yog.<domain>.<command>`, for `invokeCommand`.",
        commands::ALL,
    );
    let events_ts = substrate_host_contract::events::typescript(
        "yogEvents",
        "The events Yog IDLE's backend sends its front end.",
        events::ALL,
    );
    write(HOST_TS, &format!("{header}\n{commands_ts}\n{events_ts}"));
    let attributes = commands::ALL
        .iter()
        .fold(Attributes::new(), |attributes, domain| {
            attributes.plugin(
                domain.plugin,
                InlinedPlugin::new()
                    .commands(domain.commands)
                    .default_permission(DefaultPermissionRule::AllowAllCommands),
            )
        });
    tauri_build::try_build(attributes).expect("tauri build");
}
