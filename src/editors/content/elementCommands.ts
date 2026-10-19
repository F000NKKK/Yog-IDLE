// The model's elements: added, duplicated, deleted, reordered, copied and
// pasted as JSON — and a texture slot added.

import { promptDialog } from "substrate-platform-ui";
import { clone, type ContentFile, DIRS, type Element, NEW_BLOCK_TEXTURE, serializeContent, type Vec3 } from "../../content/model";
import { readData } from "../../data/yogData";
import { ensureModel } from "./contentModel";
import type { ContentModel } from "./useContentModel";

/** A new element: a half-block cube on the floor, in the middle. */
const NEW_ELEMENT_FROM: Vec3 = [4, 0, 4];
const NEW_ELEMENT_TO: Vec3 = [12, 8, 12];
/** The slot a model with no textures gets for its first element. */
const FIRST_SLOT = "0";
const COPY_SUFFIX = "_copy";
const SLOT_NAME = /^[a-z0-9_]+$/;

function isElement(v: unknown): v is Element {
  const e = v as Element;
  return !!v && typeof v === "object" && Array.isArray(e.from) && Array.isArray(e.to) && typeof e.faces === "object";
}

/** Commands on the model's elements (the selected one, where they act on one). */
export function elementCommands(m: ContentModel) {
  const { t, setSelected, setFace, resolved, elements, sel, selEl, update, editElements, effectiveKey } = m;
  const firstSlot = resolved.slots[0];

  const addElement = () => {
    const slot = firstSlot ?? FIRST_SLOT;
    editElements((els, model) => {
      if (!firstSlot) model.textures = { ...(model.textures ?? {}), [slot]: NEW_BLOCK_TEXTURE };
      els.push({ name: `cube${els.length + 1}`, from: [...NEW_ELEMENT_FROM], to: [...NEW_ELEMENT_TO], faces: Object.fromEntries(DIRS.map((d) => [d, { texture: `#${slot}` }])) });
      setSelected(els.length - 1);
      setFace(null);
    });
  };
  const duplicateElement = () => {
    if (sel === null) return;
    editElements((els) => {
      els.splice(sel + 1, 0, { ...clone(els[sel]), name: els[sel].name ? `${els[sel].name}${COPY_SUFFIX}` : undefined });
      setSelected(sel + 1);
    });
  };
  const deleteElement = () => {
    if (sel === null) return;
    editElements((els) => {
      els.splice(sel, 1);
      setSelected(els.length ? Math.min(sel, els.length - 1) : null);
      setFace(null);
    });
  };
  const moveElement = (by: -1 | 1) => {
    if (sel === null || sel + by < 0 || sel + by >= elements.length) return;
    editElements((els) => {
      const [el] = els.splice(sel, 1);
      els.splice(sel + by, 0, el);
      setSelected(sel + by);
    });
  };
  const addSlot = async () => {
    const slot = await promptDialog({
      title: t("Add Texture Slot"),
      label: t("Slot"),
      confirmLabel: t("Add"),
      validate: (v) => (SLOT_NAME.test(v) ? (resolved.slots.includes(v) ? t("This slot already exists.") : null) : t("Lowercase letters, digits and _.")),
    });
    if (slot) update((d) => void (ensureModel(d, effectiveKey).textures = { ...(ensureModel(d, effectiveKey).textures ?? {}), [slot]: NEW_BLOCK_TEXTURE }));
  };
  /** Copies the selected element as JSON (pasteable into another model, or Blockbench-style text). */
  const copyElement = async () => {
    if (!selEl) return false;
    await navigator.clipboard.writeText(await serializeContent(selEl as unknown as ContentFile));
    return true;
  };
  const pasteElement = async () => {
    const read = await readData(await navigator.clipboard.readText().catch(() => ""));
    if (!read.ok) return;
    const list = (Array.isArray(read.value) ? read.value : [read.value]).filter(isElement);
    if (!list.length) return;
    editElements((els) => {
      const at = sel === null ? els.length : sel + 1;
      els.splice(at, 0, ...list);
      setSelected(at);
      setFace(null);
    });
  };
  return { firstSlot, addElement, duplicateElement, deleteElement, moveElement, addSlot, copyElement, pasteElement };
}

export type ElementCommands = ReturnType<typeof elementCommands>;
