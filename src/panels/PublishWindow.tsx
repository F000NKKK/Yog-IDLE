import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button, IconButton, TextField, Icon, useDraggable, confirmDialog } from "substrate-platform-ui";
import { reportError } from "../reportError";
import "./PublishWindow.css";

interface PublishProfile {
  id: string;
  name: string;
  mode: "package" | "exports";
  dryRun: boolean;
}

const MODES: Record<PublishProfile["mode"], { title: string; detail: string }> = {
  package: { title: "Package as .yog", detail: "yog build — the mod archive, ready to drop into yog-mods/" },
  exports: { title: "Publish exports", detail: "yog publish exports — the generated exports crate, to crates.io" },
};

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
 * Any failure is shown inline (and reported to Output), never swallowed.
 */
export function PublishWindow({ projectRoot, onClose }: { projectRoot: string; onClose: () => void }) {
  const { pos, handlers } = useDraggable({ x: 260, y: 120 });
  const [profiles, setProfiles] = useState<PublishProfile[]>([]);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"package" | "exports">("package");
  const [dryRun, setDryRun] = useState(false);
  /** The profile the form is editing — `null` while it's creating a new one. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function fail(what: string, err: unknown) {
    const message = `${what}: ${err}`;
    setError(message);
    reportError(message);
  }

  function reload() {
    invoke<PublishProfile[]>("publish_profiles_list", { projectRoot })
      .then(setProfiles)
      .catch((err) => {
        setProfiles([]);
        fail("Failed to load publish profiles", err);
      });
  }

  useEffect(reload, [projectRoot]);

  function resetForm() {
    setEditingId(null);
    setName("");
    setMode("package");
    setDryRun(false);
  }

  function editProfile(profile: PublishProfile) {
    setEditingId(profile.id);
    setName(profile.name);
    setMode(profile.mode);
    setDryRun(profile.dryRun);
    setError(null);
  }

  async function saveProfile() {
    if (!name.trim()) return;
    // Editing keeps the profile's id, so the save overwrites its file.
    const profile: PublishProfile = { id: editingId ?? randomId(), name: name.trim(), mode, dryRun: mode === "exports" && dryRun };
    try {
      await invoke("publish_profile_save", { projectRoot, profile });
    } catch (err) {
      fail(`Failed to save profile "${profile.name}"`, err);
      return;
    }
    setError(null);
    resetForm();
    reload();
  }

  async function deleteProfile(profile: PublishProfile) {
    if (!(await confirmDialog({ title: "Delete Profile", message: `Delete publish profile "${profile.name}"?`, confirmLabel: "Delete" }))) return;
    try {
      await invoke("publish_profile_delete", { projectRoot, id: profile.id });
      if (editingId === profile.id) resetForm();
      setError(null);
    } catch (err) {
      fail(`Failed to delete profile "${profile.name}"`, err);
    }
    reload();
  }

  async function runProfile(profile: PublishProfile) {
    try {
      await invoke("publish_run", { projectRoot, profile });
      setError(null);
    } catch (err) {
      fail(`Failed to run profile "${profile.name}"`, err);
    }
  }

  return (
    <div className="yi-publish-window" style={{ left: pos.x, top: pos.y }}>
      <div className="yi-publish-header" {...handlers}>
        <span className="yi-publish-title">Publish</span>
        <IconButton size={24} aria-label="Close" onClick={onClose}>
          <Icon name="close" size={18} />
        </IconButton>
      </div>

      <div className="yi-publish-body">
        {error && <p className="yi-publish-error">{error}</p>}

        <section className="yi-publish-section">
          <div className="yi-publish-label">Profiles</div>
          <div className="yi-publish-list">
            {profiles.length === 0 && <p className="yi-publish-empty">No publish profiles yet — create one below.</p>}
            {profiles.map((p) => (
              <div key={p.id} className={`yi-publish-profile-row${editingId === p.id ? " is-editing" : ""}`}>
                <div className="yi-publish-profile-info">
                  <span className="yi-publish-profile-name">{p.name}</span>
                  <span className="yi-publish-profile-mode">{MODES[p.mode].title}{p.mode === "exports" && p.dryRun ? " (dry run)" : ""}</span>
                </div>
                <div className="yi-publish-profile-buttons">
                  <Button variant="primary" onClick={() => runProfile(p)}>
                    Run
                  </Button>
                  <Button variant="ghost" onClick={() => editProfile(p)}>
                    Edit
                  </Button>
                  <Button variant="ghost" onClick={() => deleteProfile(p)}>
                    Delete
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="yi-publish-section">
          <div className="yi-publish-label">{editingId ? "Edit Profile" : "New Profile"}</div>
          <label className="yi-publish-field">
            <span className="yi-publish-field-label">Name</span>
            <TextField
              placeholder="e.g. Release package"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveProfile()}
            />
          </label>
          <div className="yi-publish-field">
            <span className="yi-publish-field-label">Action</span>
            {(Object.keys(MODES) as PublishProfile["mode"][]).map((m) => (
              <label key={m} className={`yi-publish-option${mode === m ? " is-selected" : ""}`}>
                <input type="radio" name="yi-publish-mode" checked={mode === m} onChange={() => setMode(m)} />
                <span className="yi-publish-option-text">
                  <span className="yi-publish-option-title">{MODES[m].title}</span>
                  <span className="yi-publish-option-detail">{MODES[m].detail}</span>
                </span>
              </label>
            ))}
            {mode === "exports" && (
              <label className="yi-publish-check">
                <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
                Dry run (don't upload)
              </label>
            )}
          </div>
        </section>
      </div>

      <div className="yi-publish-footer">
        {editingId && (
          <Button variant="ghost" onClick={resetForm}>
            Cancel
          </Button>
        )}
        <Button variant="primary" disabled={!name.trim()} onClick={saveProfile}>
          {editingId ? "Save Changes" : "Save Profile"}
        </Button>
      </div>
    </div>
  );
}
