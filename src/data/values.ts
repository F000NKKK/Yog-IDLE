// Reading values out of parsed Yog Data (plain JS from `parseDataValue`):
// what a field is, if it's what's wanted.

/** `v` if it's a string. */
export const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** `v` if it's a finite number, else `fallback`. */
export const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/** Whether `v` is an object (a map), not a list. */
export const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** `v` if it's a list, else none. */
export const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
