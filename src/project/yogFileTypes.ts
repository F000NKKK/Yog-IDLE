// The IDE's names for Yog's formats (`yog_ids::Format`, generated into
// `data/yogIds.generated.ts`): a file type's id and an extension with its dot.
import { formats } from "../data/yogIds.generated";

export { formats };

/** One of Yog's formats. */
export type YogFormat = (typeof formats)[keyof typeof formats];

/** The id of a format's file type (`fileTypes.tsx`) and of its main editor: `yog.yblock`. */
export const fileTypeId = (format: YogFormat) => `yog.${format.ext}`;

/** A format's extension with its dot: `.yblock`. */
export const dotExt = (format: YogFormat) => `.${format.ext}`;
