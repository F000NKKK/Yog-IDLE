// Yog Data's typed-value syntax, over the names Yog shares (`yog-ids`,
// generated into `yogIds.generated.ts`): every reference the IDE reads or
// writes goes through here.
import { kind, ns, sep, typed } from "./yogIds.generated";

/** What starts a typed value (`@item:…`); `@@` escapes it. */
export const TYPED = sep.TYPED;

/** The kinds of content (`yog_ids::kind`). */
export const KINDS = kind;
export type ContentKind = (typeof kind)[keyof typeof kind];

/** Typed values that aren't references to content. */
export const TYPED_WORDS = typed;

/** The most items a stack holds — what a recipe can make at once. */
export const MAX_STACK_SIZE = 64;

/** The game's namespace: ids without one are its. */
export const GAME_NAMESPACE = ns.MINECRAFT;

/** `@<kind>:<id>` — a reference to content. */
export const formatRef = (k: string, id: string) => `${TYPED}${k}${sep.NAMESPACE}${id}`;

/** `@tag:<kind>:<id>` — a tag of content of a kind. */
export const formatTag = (k: string, id: string) => `${TYPED}${typed.TAG}${sep.NAMESPACE}${k}${sep.NAMESPACE}${id}`;
