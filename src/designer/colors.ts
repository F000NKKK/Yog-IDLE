// ARGB colors as yog-ui draws them (`widget.rs`), named once for the
// designer's port of its layout and picture.

/** The alpha byte of an opaque color, in place. */
export const OPAQUE = 0xff000000;
/** Where the alpha byte starts. */
export const ALPHA_SHIFT = 24;

/** A label's text, unless it says otherwise. */
export const DEFAULT_TEXT = 0xffccccaa;
/** A text box: black, with light text. */
export const TEXT_BOX_BG = OPAQUE;
export const TEXT_BOX_TEXT = 0xffe0e0e0;
/** A slot's stack count. */
export const SLOT_COUNT = 0xffffffff;
