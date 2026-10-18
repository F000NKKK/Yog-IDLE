// Reading and editing Yog Data in tests, through the CLI as the editors do.
import { patchData, readObject } from "../data/yogData";

/** The object in `text`; throws what's wrong with it. */
export async function readFile<T = Record<string, unknown>>(text: string, opts: { ordered?: boolean } = {}): Promise<T> {
  const r = await readObject<T>(text, opts);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

/** `text` with `change` made to its object, as an editor writes it. */
export async function editData<T = Record<string, unknown>>(text: string, change: (file: T) => void, opts: { ordered?: boolean } = {}): Promise<string> {
  const file = await readFile<T>(text, opts);
  change(file);
  return patchData(text, file);
}
