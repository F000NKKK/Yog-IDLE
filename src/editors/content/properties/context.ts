// What the Properties rows of a .yblock/.yitem are built from: the editor's
// state, the edits it offers, and the row helpers.

import type { Dispatch, SetStateAction } from "react";
import type { ContentFile, Dir, DisplaySlot, Element, Kind, Model } from "../../../content/model";
import type { BlockState, StateProperty, States } from "../../../content/states";
import type { RefChoices } from "../../../data/contentRefs";
import type { BuiltInBlockKind, Choices, LoadedTexture, ModelKey, Resolved, StateSel } from "../contentModel";
import type { PropertyRows } from "./rows";

/** The editor's state and edits the rows read and call. */
export interface PropertiesContext extends PropertyRows {
  /** The file, as last read. */
  file: ContentFile;
  kind: Kind;
  /** Edits the file (its text patched). */
  update: (edit: (draft: ContentFile) => void) => Promise<void>;
  /** What the pickers offer. */
  choices: Choices;
  blockKinds: BuiltInBlockKind[];
  blockRefs: RefChoices;
  effectRefs: RefChoices;
  entityRefs: RefChoices;
  readOnly: boolean | undefined;
  editStates: (edit: (st: States, d: ContentFile) => void) => Promise<void>;
  /** The model edited. */
  effectiveKey: ModelKey;
  modelKey: ModelKey;
  mainResolved: Resolved;
  resolved: Resolved;
  /** What's picked in the outliner's States. */
  pickedState: StateSel | null;
  setModelKey: Dispatch<SetStateAction<ModelKey>>;
  setPreviewState: Dispatch<SetStateAction<BlockState | null>>;
  setStateSel: Dispatch<SetStateAction<StateSel | null>>;
  stateModelNames: string[];
  stateProps: StateProperty[];
  states: States | undefined;
  displaySlot: DisplaySlot | "";
  editElements: (edit: (els: Element[], m: Model) => void) => Promise<void>;
  /** The selected face. */
  face: Dir | null;
  model: Model | undefined;
  /** Whether the edited model is a block's or an item's. */
  modelKind: Kind;
  /** The selected element's index. */
  sel: number | null;
  /** The selected element. */
  selEl: Element | undefined;
  /** The textures shown, by key. */
  shownImages: Record<string, LoadedTexture | undefined>;
}
