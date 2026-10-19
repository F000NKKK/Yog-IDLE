// Paint mode's state: the textures' pixels decoded, painted and saved, animations edited, the frame painted.

import { useEffect, useRef, useState } from "react";
import type { EditorProps } from "substrate-platform-ui";
import { usePaintState } from "../../../content/paint/PaintTools";
import type { PixelImage } from "../../../content/paint/pixels";
import type { AnimationEdit, Edited } from "../contentModel";

/** Paint mode's state: the textures' pixels decoded, painted and saved, animations edited, the frame painted. */
export function usePaintBuffers(props: EditorProps) {
  const { path } = props;
  // Paint mode: the textures' pixels, decoded from disk (`decoded`), painted
  // (`edited`), and as last saved (`saved`).
  const [paintMode, setPaintMode] = useState(false);
  const { state: paint, set: setPaint, used: usedColor } = usePaintState("yog.content.paint");
  const [paintSlot, setPaintSlot] = useState<string | null>(null);
  useEffect(() => setPaintSlot(null), [path]);
  const [tints, setTints] = useState<Record<number, string>>({});
  const [decoded, setDecoded] = useState<Record<string, { url: string; img: PixelImage }>>({});
  const [edited, setEdited] = useState<Record<string, Edited>>({});
  const [saved, setSaved] = useState<Record<string, PixelImage>>({});
  const editedRef = useRef(edited);
  editedRef.current = edited;
  // Animations edited here (frames added, times changed), over the loaded
  // ones; which step of each is painted, and whether they play.
  const [animEdits, setAnimEdits] = useState<Record<string, AnimationEdit>>({});
  const animEditsRef = useRef(animEdits);
  animEditsRef.current = animEdits;
  const [paintEntry, setPaintEntry] = useState<Record<string, number>>({});
  const [playing, setPlaying] = useState(false);

  return { paintMode, setPaintMode, paint, setPaint, usedColor, paintSlot, setPaintSlot, tints, setTints, decoded, setDecoded, edited, setEdited, saved, setSaved, editedRef, animEdits, setAnimEdits, animEditsRef, paintEntry, setPaintEntry, playing, setPlaying };
}

/** What `usePaintBuffers` gives. */
export type PaintBuffers = ReturnType<typeof usePaintBuffers>;
