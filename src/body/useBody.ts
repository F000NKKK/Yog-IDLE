import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useContentRefs, type OwnRef } from "../data/contentRefs";
import { parseAnim, type Clip } from "./yanim";
import { readModel, type ModelFile } from "./ymodel";
import { useRead } from "../data/useDataFile";
import { useFileText } from "./useFileText";
import { formats } from "../yogFileTypes";

/** A `.ymodel`'s texture as a data URL, by the format's rules (`body_texture`), and why not when it can't be. */
export function useBodyTexture(path: string | null, texture: string | undefined): { url: string | null; error: string | null } {
  const [state, setState] = useState<{ url: string | null; error: string | null }>({ url: null, error: null });
  useEffect(() => {
    if (!path || !texture) return setState({ url: null, error: null });
    let live = true;
    invoke<{ url: string }>("body_texture", { path, texture })
      .then((tx) => live && setState({ url: tx.url, error: null }))
      .catch((e) => live && setState({ url: null, error: String(e) }));
    return () => {
      live = false;
    };
  }, [path, texture]);
  return state;
}

/** The mod's body file a reference names (`body/wisp`: the mod's; `mymod:body/wisp` in full). */
export function bodyFile(own: readonly OwnRef[], ref: string | undefined): OwnRef | null {
  if (!ref) return null;
  return own.find((o) => o.id === ref || (!ref.includes(":") && o.id.endsWith(`:${ref}`))) ?? null;
}

/** The mod's namespace, as its own content names it (`null` while there's none). */
export const ownNamespace = (own: readonly OwnRef[]): string | null => own[0]?.id.split(":")[0] ?? null;

export interface Body {
  /** The `.ymodel` files and `.yanim` files the mod has. */
  models: OwnRef[];
  animations: OwnRef[];
  /** The model named, read (`null`: none named, not found or not readable). */
  model: ModelFile | null;
  modelFile: string | null;
  texture: string | null;
  /** The clips of the animations named. */
  clips: Clip[];
  animFile: string | null;
}

/** The body an entity's `model` and `animations` name, for the file at `path`. */
export function useBody(path: string, modelRef: string | undefined, animRef: string | undefined): Body {
  const models = useContentRefs(path, formats.model.ext).own;
  const animations = useContentRefs(path, formats.anim.ext).own;
  const modelFile = bodyFile(models, modelRef)?.file ?? null;
  const animFile = bodyFile(animations, animRef)?.file ?? null;
  const modelText = useFileText(modelFile);
  const animText = useFileText(animFile);
  const modelRead = useRead(modelText, readModel);
  const model = modelRead?.ok ? modelRead.value : null;
  const animRead = useRead(animText, parseAnim);
  const clips = useMemo(() => (animRead?.ok ? animRead.clips : []), [animRead]);
  const texture = useBodyTexture(modelFile, model?.texture).url;
  return { models, animations, model, modelFile, texture, clips, animFile };
}
