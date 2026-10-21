//! Publish profiles and publishing the mod.

use super::*;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PublishProfile {
    pub(super) id: String,
    pub(super) name: String,
    /// "package" — `yog build` (produces `artifacts/<id>.yog`); "exports" — `yog publish exports`.
    pub(super) mode: String,
    /// Only meaningful for `mode: "exports"`.
    pub(super) dry_run: bool,
}

/// Publish profiles: local developer configuration (as Visual Studio's own
/// PublishProfiles are), in IDLE's private folder of the project.
const PROFILES_DIR: &str = "publish-profiles";

pub(super) fn publish_profiles_dir(project_root: &Path) -> PathBuf {
    project_root.join(manifest::IDLE_DIR).join(PROFILES_DIR)
}

#[tauri::command]
pub(super) fn publish_profiles_list(
    state: State<Workspace>,
    project_root: String,
) -> Result<Vec<PublishProfile>, String> {
    validate_within_roots(&state, Path::new(&project_root))?;
    let dir = publish_profiles_dir(&PathBuf::from(project_root));
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut profiles = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path().extension().is_some_and(|ext| ext == "json") {
            let contents = std::fs::read_to_string(entry.path()).map_err(|e| e.to_string())?;
            if let Ok(profile) = serde_json::from_str::<PublishProfile>(&contents) {
                profiles.push(profile);
            }
        }
    }
    profiles.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(profiles)
}

#[tauri::command]
pub(super) fn publish_profile_save(
    state: State<Workspace>,
    project_root: String,
    profile: PublishProfile,
) -> Result<(), String> {
    let root = PathBuf::from(&project_root);
    validate_within_roots(&state, &root)?;
    substrate_platform::state::private_dir(&root.join(manifest::IDLE_DIR))
        .map_err(|m| m.to_string())?;
    let dir = publish_profiles_dir(&root);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.json", profile.id));
    // `id` is caller-supplied — a `../` in it must not escape the project.
    validate_within_roots(&state, &path)?;
    let json = serde_json::to_string_pretty(&profile).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub(super) fn publish_profile_delete(
    state: State<Workspace>,
    project_root: String,
    id: String,
) -> Result<(), String> {
    validate_within_roots(&state, Path::new(&project_root))?;
    let path = publish_profiles_dir(&PathBuf::from(project_root)).join(format!("{id}.json"));
    validate_within_roots(&state, &path)?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub(super) fn publish_run(
    app: AppHandle,
    state: State<Workspace>,
    project_root: String,
    profile: PublishProfile,
) -> Result<(), String> {
    let root = PathBuf::from(project_root);
    validate_within_roots(&state, &root)?;
    let args = match profile.mode.as_str() {
        "exports" => {
            let mut args = vec!["publish".to_string(), "exports".to_string()];
            if profile.dry_run {
                args.push("--dry-run".to_string());
            }
            args
        }
        "package" => vec!["build".to_string()],
        other => return Err(format!("unknown publish mode '{other}'")),
    };
    let file = yog_workflow(&app, &root, args);
    run_and_stream(app, file, "run".to_string(), HashMap::new(), root);
    Ok(())
}
