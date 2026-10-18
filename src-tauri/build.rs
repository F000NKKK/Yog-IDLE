//! Tauri's build, and the front end's copy of the names Yog shares
//! (`yog-ids`), written where the TypeScript imports it.

/// Where the generated names go, from this crate.
const YOG_IDS_TS: &str = "../src/data/yogIds.generated.ts";

fn main() {
    let ts = yog_ids::export::typescript();
    if std::fs::read_to_string(YOG_IDS_TS).ok().as_deref() != Some(ts.as_str()) {
        std::fs::write(YOG_IDS_TS, ts).expect("src/data/ is writable");
    }
    tauri_build::build()
}
