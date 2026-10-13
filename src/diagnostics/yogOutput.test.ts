import { describe, expect, it } from "vitest";
import { createYogParser, normalizePath } from "./yogOutput";

const parse = (text: string) => {
  const p = createYogParser({ root: "/p", project: "demo" });
  return text.split("\n").flatMap((l) => p.push(l));
};

describe("createYogParser", () => {
  it("reads .yui errors with an absolute path", () => {
    expect(parse("[error] yog: error: /p/src/main.yui: line 3: <Button> has no attribute `x`")).toEqual([
      { severity: "error", message: "<Button> has no attribute `x`", file: "/p/src/main.yui", line: 3, project: "demo", tool: "yog", origin: "build" },
    ]);
  });

  it("reads a listed block of resource errors and indented warnings", () => {
    const out = parse(
      [
        "    warning: resources/Colors.yres:4: unused color",
        "yog: error: invalid .yres resources:",
        "  resources/Strings.yres:12: duplicate name \"title\"",
        "  resources/Icons.yres: no such file",
        "==> done",
        "  resources/Other.yres:1: not part of the list",
      ].join("\n")
    );
    expect(out.map((d) => [d.severity, d.file, d.line, d.message])).toEqual([
      ["warning", "/p/resources/Colors.yres", 4, "unused color"],
      ["error", "/p/resources/Strings.yres", 12, 'duplicate name "title"'],
      ["error", "/p/resources/Icons.yres", undefined, "no such file"],
    ]);
  });

  it("leaves rustc's lines and cargo's summary alone", () => {
    expect(parse("warning: unused variable: `x`\nyog: error: cargo build failed (exit status: 101)")).toEqual([]);
  });

  it("keeps file-less errors", () => {
    const [d, ...rest] = parse("yog: error: no yog.toml found in the current directory");
    expect(rest).toEqual([]);
    expect(d).toMatchObject({ severity: "error", message: "no yog.toml found in the current directory" });
    expect(d.file).toBeUndefined();
  });
});

describe("normalizePath", () => {
  it("folds .. and .", () => {
    expect(normalizePath("/p/.yog-build/../src/./lib.rs")).toBe("/p/src/lib.rs");
    expect(normalizePath("C:\\p\\.yog-build\\..\\src\\lib.rs")).toBe("C:\\p\\src\\lib.rs");
  });
});
