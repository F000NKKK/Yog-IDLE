import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button, IconButton, TextField, Icon, useDraggable } from "substrate-platform-ui";
import "./PublishWindow.css";

interface PublishProfile {
  id: string;
  name: string;
  mode: "package" | "exports";
  dryRun: boolean;
}

function randomId(): string {
  return `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Visual Studio-style publish profiles: named, saved configurations for
 * either of `yog-cli`'s two publish modes — packaging the mod as `.yog`
 * (`yog build`) or publishing its generated exports crate (`yog publish
 * exports`, optionally `--dry-run`). Profiles are saved into the project's
 * `.yog-idle/publish-profiles/` (auto-gitignored on first save — see
 * `publish_profile_save` on the Rust side), not this window's own state.
 */
export function PublishWindow({ projectRoot, onClose }: { projectRoot: string; onClose: () => void }) {
  const { pos, handlers } = useDraggable({ x: 260, y: 120 });
  const [profiles, setProfiles] = useState<PublishProfile[]>([]);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"package" | "exports">("package");
  const [dryRun, setDryRun] = useState(false);

  function reload() {
    invoke<PublishProfile[]>("publish_profiles_list", { projectRoot })
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }

  useEffect(reload, [projectRoot]);

  async function saveProfile() {
    if (!name.trim()) return;
    const profile: PublishProfile = { id: randomId(), name: name.trim(), mode, dryRun };
    await invoke("publish_profile_save", { projectRoot, profile }).catch(() => {});
    setName("");
    reload();
  }

  async function deleteProfile(id: string) {
    await invoke("publish_profile_delete", { projectRoot, id }).catch(() => {});
    reload();
  }

  async function runProfile(profile: PublishProfile) {
    await invoke("publish_run", { projectRoot, profile }).catch(() => {});
  }

  return (
    <div className="sp-publish-window" style={{ left: pos.x, top: pos.y }}>
      <div className="sp-publish-header" {...handlers}>
        <span className="sp-publish-title">Publish</span>
        <IconButton size={24} aria-label="Close" onClick={onClose}>
          <Icon name="close" size={18} />
        </IconButton>
      </div>

      <div className="sp-publish-body">
        <div className="sp-publish-section">
          <div className="sp-publish-label">Profiles</div>
          {profiles.length === 0 && <p className="sp-publish-empty">No publish profiles yet — create one below.</p>}
          {profiles.map((p) => (
            <div key={p.id} className="sp-publish-profile-row">
              <div className="sp-publish-profile-info">
                <span className="sp-publish-profile-name">{p.name}</span>
                <span className="sp-publish-profile-mode">
                  {p.mode === "package" ? "Package as .yog" : `Publish exports${p.dryRun ? " (dry run)" : ""}`}
                </span>
              </div>
              <Button variant="ghost" onClick={() => runProfile(p)}>
                Run
              </Button>
              <Button variant="ghost" onClick={() => deleteProfile(p.id)}>
                Delete
              </Button>
            </div>
          ))}
        </div>

        <div className="sp-publish-divider" />

        <div className="sp-publish-section">
          <div className="sp-publish-label">New Profile</div>
          <TextField placeholder="Profile name" value={name} onChange={(e) => setName(e.target.value)} />
          <div className="sp-publish-mode-row">
            <label className="sp-publish-radio">
              <input type="radio" checked={mode === "package"} onChange={() => setMode("package")} />
              Package mod as .yog
            </label>
            <label className="sp-publish-radio">
              <input type="radio" checked={mode === "exports"} onChange={() => setMode("exports")} />
              Publish exports
            </label>
          </div>
          {mode === "exports" && (
            <label className="sp-publish-radio">
              <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
              Dry run
            </label>
          )}
          <Button variant="subtle" onClick={saveProfile}>
            Save Profile
          </Button>
        </div>
      </div>
    </div>
  );
}
