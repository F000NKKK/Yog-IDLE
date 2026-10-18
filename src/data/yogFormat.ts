// Yog Data's typed-value syntax and its kinds of content — the IDE's one
// copy of what `yog_data` defines (`schema::kinds`, `typed`): every reference
// the IDE reads or writes goes through here.

/** What starts a typed value (`@item:…`); `@@` escapes it. */
export const TYPED = "@";

/** The kinds of content a reference names (`yog_data::kinds`). */
export const KINDS = {
  item: "item",
  block: "block",
  entity: "entity",
  recipe: "recipe",
  entry: "entry",
  category: "category",
  fluid: "fluid",
  biome: "biome",
  dimension: "dimension",
} as const;
export type ContentKind = (typeof KINDS)[keyof typeof KINDS];

/** Typed values that aren't references to content. */
export const TYPED_WORDS = { tag: "tag", lang: "lang", image: "image" } as const;

/** The most items a stack holds — what a recipe can make at once. */
export const MAX_STACK_SIZE = 64;

/** The game's namespace: ids without one are its. */
export const GAME_NAMESPACE = "minecraft";

/** `@<kind>:<id>` — a reference to content. */
export const formatRef = (kind: string, id: string) => `${TYPED}${kind}:${id}`;

/** `@tag:<kind>:<id>` — a tag of content of a kind. */
export const formatTag = (kind: string, id: string) => `${TYPED}${TYPED_WORDS.tag}:${kind}:${id}`;
