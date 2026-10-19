// What the model editor's 3D view takes and reports.

import type { CSSProperties } from "react";
import type { TextureAnimation } from "../animation";
import type { Dir, DisplayTransform, Element, Vec3 } from "../model";

/** A texture the view can draw: a data URL, and its animation (played live, or held on image frame `pinned`). */
export interface TextureSource {
  url: string;
  animation: TextureAnimation | null;
  pinned?: number;
}

/** One model drawn in the view. */
export interface Part {
  elements: Element[];
  /** Slot → texture value, `#refs` resolved. */
  textures: Record<string, string>;
  /** Blockstate rotation (degrees, multiples of 90). */
  x?: number;
  y?: number;
  /** An item sprite: these layers' textures (layer0, layer1, ...) extruded 1px thick. */
  sprite?: { slot: string; texture: string }[];
  /** Tint preview: tint index → CSS color multiplied into faces with that `tint` (a sprite's layer N has tint index N). */
  tints?: Record<number, string>;
  /** Selectable and editable (the model being edited). */
  editable?: boolean;
  /** Drawn translucent (the arms of a connecting block, say). */
  ghost?: boolean;
}

export type GizmoMode = "move" | "resize";

/** A pixel of a texture under the pointer in paint mode. */
export interface PaintHit {
  /** The texture slot of the face (or sprite layer) hit. */
  slot: string;
  x: number;
  y: number;
  /** The element and face hit (`null` for a sprite). */
  element: number | null;
  face: Dir | null;
}
export type ViewName = "front" | "back" | "right" | "left" | "top" | "bottom";

export interface ViewportProps {
  parts: Part[];
  /** Texture value → its image (missing ones draw a checkerboard). */
  images: Record<string, TextureSource | undefined>;
  selected: number | null;
  selectedFace: Dir | null;
  onSelect: (element: number | null, face: Dir | null) => void;
  /** A finished move/resize of the editable part's element. */
  onTransform?: (element: number, from: Vec3, to: Vec3) => void;
  gizmo: GizmoMode;
  shading: boolean;
  showGrid: boolean;
  /** Cutout/translucent: how alpha is drawn. */
  renderLayer?: string;
  /** Preview a display transform (with a reference object for its slot). */
  display?: { slot: string; transform: DisplayTransform } | null;
  /** Paint mode: left press/drag/release on the editable part paints its textures (no selection, no handles). */
  onPaint?: ((hit: PaintHit | null, phase: "down" | "move" | "up", alt: boolean) => void) | null;
  /** Bumped to jump to a view. */
  viewRequest?: { view: ViewName; key: number } | null;
  style?: CSSProperties;
  className?: string;
}
