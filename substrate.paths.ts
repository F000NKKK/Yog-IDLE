import path from "node:path";

/**
 * Substrate Data's TypeScript port, from its sibling checkout (as
 * `substrate-platform-ui` is): `~/Projects/Substrate-Data` beside
 * `~/Projects/yog`. Imported as `substrate-data` until it's on npm
 * (tsconfig.json's `paths` says the same for the type checker).
 */
export const substrateData = path.resolve(__dirname, "../../Substrate-Data/ports/typescript/src/index.ts");
