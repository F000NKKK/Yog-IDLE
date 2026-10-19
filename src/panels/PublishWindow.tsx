import { useEffect, useState } from "react";
import { Button, CheckField, confirmDialog, Icon, IconButton, invokeCommand, pt, reportError, TextField, useDraggable, useT } from "substrate-platform-ui";
import "./PublishWindow.css";
import { yog } from "../plugins.generated";

interface PublishProfile {
  id: string;
  name: string;
  mode: "package" | "exports";
  dryRun: boolean;
}

/** English; shown through `t`. */
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
  const t = useT();
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
    invokeCommand<PublishProfile[]>(yog.run.publishProfilesList, { projectRoot })
      .then(setProfiles)
      .catch((err) => {
        setProfiles([]);
        fail(t("Failed to load publish profiles"), err);
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
      await invokeCommand(yog.run.publishProfileSave, { projectRoot, profile });
    } catch (err) {
      fail(t('Failed to save profile "{name}"', { name: profile.name }), err);
      return;
    }
    setError(null);
    resetForm();
    reload();
  }

  async function deleteProfile(profile: PublishProfile) {
    if (!(await confirmDialog({ title: t("Delete Profile"), message: t('Delete publish profile "{name}"?', { name: profile.name }), confirmLabel: t("Delete") }))) return;
    try {
      await invokeCommand(yog.run.publishProfileDelete, { projectRoot, id: profile.id });
      if (editingId === profile.id) resetForm();
      setError(null);
    } catch (err) {
      fail(t('Failed to delete profile "{name}"', { name: profile.name }), err);
    }
    reload();
  }

  async function runProfile(profile: PublishProfile) {
    try {
      await invokeCommand(yog.run.publishRun, { projectRoot, profile });
      setError(null);
    } catch (err) {
      fail(t('Failed to run profile "{name}"', { name: profile.name }), err);
    }
  }

  return (
    <div className="yi-publish-window" style={{ left: pos.x, top: pos.y }}>
      <div className="yi-publish-header" {...handlers}>
        <span className="yi-publish-title">{t("Publish")}</span>
        <IconButton aria-label={t("Close")} onClick={onClose}>
          <Icon name="close" />
        </IconButton>
      </div>

      <div className="yi-publish-body">
        {error && <p className="yi-publish-error">{error}</p>}

        <section className="yi-publish-section">
          <div className="yi-publish-label">{t("Profiles")}</div>
          <div className="yi-publish-list">
            {profiles.length === 0 && <p className="yi-publish-empty">{t("No publish profiles yet — create one below.")}</p>}
            {profiles.map((p) => (
              <div key={p.id} className={`yi-publish-profile-row${editingId === p.id ? " is-editing" : ""}`}>
                <div className="yi-publish-profile-info">
                  <span className="yi-publish-profile-name">{p.name}</span>
                  <span className="yi-publish-profile-mode">{t(MODES[p.mode].title)}{p.mode === "exports" && p.dryRun ? ` ${t("(dry run)")}` : ""}</span>
                </div>
                <div className="yi-publish-profile-buttons">
                  <Button variant="primary" onClick={() => runProfile(p)}>
                    {t("Run")}
                  </Button>
                  <Button variant="ghost" onClick={() => editProfile(p)}>
                    {pt("profile", "Edit")}
                  </Button>
                  <Button variant="ghost" onClick={() => deleteProfile(p)}>
                    {t("Delete")}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="yi-publish-section">
          <div className="yi-publish-label">{editingId ? t("Edit Profile") : t("New Profile")}</div>
          <label className="yi-publish-field">
            <span className="yi-publish-field-label">{t("Name")}</span>
            <TextField
              placeholder={t("e.g. Release package")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveProfile()}
            />
          </label>
          <div className="yi-publish-field">
            <span className="yi-publish-field-label">{t("Action")}</span>
            {(Object.keys(MODES) as PublishProfile["mode"][]).map((m) => (
              <label key={m} className={`yi-publish-option${mode === m ? " is-selected" : ""}`}>
                <input type="radio" name="yi-publish-mode" checked={mode === m} onChange={() => setMode(m)} />
                <span className="yi-publish-option-text">
                  <span className="yi-publish-option-title">{t(MODES[m].title)}</span>
                  <span className="yi-publish-option-detail">{t(MODES[m].detail)}</span>
                </span>
              </label>
            ))}
            {mode === "exports" && (
              <CheckField checked={dryRun} onChange={setDryRun} label={t("Dry run (don't upload)")} />
            )}
          </div>
        </section>
      </div>

      <div className="yi-publish-footer">
        {editingId && (
          <Button variant="ghost" onClick={resetForm}>
            {t("Cancel")}
          </Button>
        )}
        <Button variant="primary" disabled={!name.trim()} onClick={saveProfile}>
          {editingId ? t("Save Changes") : t("Save Profile")}
        </Button>
      </div>
    </div>
  );
}
