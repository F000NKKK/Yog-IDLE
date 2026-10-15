import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Icon, SettingsWindow, useLocale, useT, type CommitResult, type SettingsSection } from "substrate-platform-ui";
import { useOpenFiles } from "../OpenFilesContext";
import { openFile } from "../fileOpenBus";
import { errorText, projectApi, type ProjectProps } from "./api";
import type { ProjectPropertiesPage } from "./bus";
import { ApplicationPage, BuildPage } from "./ApplicationPages";
import { DebugPage } from "./DebugPage";
import { DependenciesPage } from "./DependenciesPage";
import { PublishPage } from "./PublishPage";
import { editManifest } from "./manifestHistory";
import "./ProjectProperties.css";

/** What every page gets: the project as last read, and a way to write to it. */
export interface PageProps {
  root: string;
  props: ProjectProps;
  /**
   * Runs a write (each returns the re-read project) — the window shows the
   * result, open editors of yog.toml reload; a rejected value comes back
   * as its message, translated, for the field to show.
   */
  apply: (write: () => Promise<ProjectProps>) => Promise<CommitResult>;
}

/**
 * Project > Properties (Alt+Enter) — Visual Studio's project property
 * pages for a Yog mod: every `yog.toml` setting through forms instead of
 * hand-edited TOML, validated as you type and written straight back (with
 * comments and layout kept). "View Code" opens the file itself.
 */
export function ProjectPropertiesWindow({
  root,
  name,
  initialPage,
  onClose,
  onOpenPublish,
}: {
  root: string;
  name: string;
  initialPage?: ProjectPropertiesPage;
  onClose: () => void;
  onOpenPublish: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const { recheckDisk } = useOpenFiles();
  const [props, setProps] = useState<ProjectProps | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const undoScope = `project-properties:${root}`;

  useEffect(() => {
    let cancelled = false;
    projectApi
      .read(root)
      .then((p) => !cancelled && setProps(p))
      .catch((err) => !cancelled && setLoadError(errorText(err)));
    return () => {
      cancelled = true;
    };
  }, [root]);

  // Every write is a step of the window's history (`editManifest`).
  const reread = useCallback(() => {
    void projectApi.read(root).then(setProps);
    void recheckDisk();
  }, [root, recheckDisk]);
  const apply = useCallback(
    async (write: () => Promise<ProjectProps>): Promise<CommitResult> => {
      try {
        setProps(await editManifest(undoScope, root, write, reread));
        // An open yog.toml tab picks up the edit (or asks, if it has unsaved changes).
        void recheckDisk();
        return null;
      } catch (err) {
        return errorText(err);
      }
    },
    [undoScope, root, reread, recheckDisk]
  );

  const sections = useMemo<SettingsSection[]>(() => {
    if (!props) {
      const message = loadError ? t("Couldn't read yog.toml: {error}", { error: loadError }) : t("Loading…");
      return [{ id: "application", label: t("Application"), content: <p className="project-props-note">{message}</p> }];
    }
    const page = { root, props, apply };
    return [
      { id: "application", label: t("Application"), content: <ApplicationPage {...page} /> },
      { id: "build", label: t("Build"), content: <BuildPage {...page} /> },
      { id: "debug", label: t("Debug"), content: <DebugPage {...page} /> },
      { id: "dependencies", label: t("Dependencies"), content: <DependenciesPage {...page} /> },
      { id: "publish", label: t("Publish"), content: <PublishPage {...page} onOpenPublish={onOpenPublish} /> },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props, loadError, root, apply, onOpenPublish, locale]);

  return (
    <SettingsWindow
      undoScope={undoScope}
      title={t("{name} Properties", { name })}
      sections={sections}
      initialSectionId={initialPage}
      sectionStateKey="projectProperties.page"
      hideSearch
      onClose={onClose}
      headerExtra={
        <Button
          variant="ghost"
          title={t("Open yog.toml in the editor")}
          onClick={() => openFile({ path: `${root.replace(/[/\\]+$/, "")}/yog.toml`, name: "yog.toml" })}
        >
          <Icon name="code" size={12} /> {t("View Code")}
        </Button>
      }
    />
  );
}
