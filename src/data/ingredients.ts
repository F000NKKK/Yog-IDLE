// An ingredient as the IDE's item pickers show and edit it: an id
// (`minecraft:paper`), a tag (`#c:dusts`) or alternatives joined by ` | `;
// and as Yog Data writes it — a reference (`@item:minecraft:paper`), a tag
// reference (`@tag:item:c:dusts`) or a list of them.

import { classify } from "./typed";
import { formatRef, formatTag, KINDS, TYPED, TYPED_WORDS } from "./yogFormat";
import { str } from "./values";

/** What marks a tag where an ingredient is shown: `#c:dusts`. */
export const TAG_MARK = "#";
/** What joins an ingredient's alternatives where it's shown. */
export const ALTERNATIVES = "|";
const ALTERNATIVES_SHOWN = ` ${ALTERNATIVES} `;

/** Whether a shown ingredient part is a tag. */
export const isTag = (part: string) => part.startsWith(TAG_MARK);

/** A shown ingredient's alternatives, each an id or a `#tag`. */
export const alternativesOf = (shown: string): string[] => shown.split(ALTERNATIVES).map((p) => p.trim()).filter(Boolean);

/** A reference as shown: `@item:x` → `x`, `@tag:item:x` → `#x`; anything else as written. */
export function shownOf(ref: string): string {
  try {
    const v = classify(ref);
    if (v.t === TYPED_WORDS.TAG) return `${TAG_MARK}${v.id}`;
    if (v.t === "ref") return v.id;
  } catch {
    // Not a reference: shown as written.
  }
  return ref;
}

/** A shown id as a reference: `x` → `@item:x`, `#x` → `@tag:item:x`; a reference as it is. */
export function refOf(shown: string): string {
  if (isTag(shown)) return formatTag(KINDS.ITEM, shown.slice(TAG_MARK.length));
  return shown.startsWith(TYPED) ? shown : formatRef(KINDS.ITEM, shown);
}

/** An ingredient as written (a reference or a list of them) as shown; `null` for none. */
export function showIngredient(v: unknown): string | null {
  const refs = (Array.isArray(v) ? v : [v]).map(str).filter((s): s is string => !!s);
  return refs.length ? refs.map(shownOf).join(ALTERNATIVES_SHOWN) : null;
}

/** A shown ingredient as written: one reference, or a list of alternatives. */
export function writeIngredient(shown: string): string | string[] {
  const refs = alternativesOf(shown).map(refOf);
  return refs.length === 1 ? refs[0] : refs;
}
