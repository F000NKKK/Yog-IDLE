import { describe, expect, it } from "vitest";
import { expressionAt, identifiers } from "./variables";

const at = (line: string, marker: string) => expressionAt(line.replace(marker, ""), line.indexOf(marker))?.expr ?? null;

describe("debugger expressions", () => {
  it("lists a line's locals: no keywords, strings, comments, fields or path segments", () => {
    expect(identifiers('let mut x = self.y + foo::bar(x, "z w") // q')).toEqual(["x", "self", "foo"]);
  });

  it("finds the hovered member path, like Visual Studio", () => {
    expect(at("let v = a.b|.c;", "|")).toBe("a.b");
    expect(at("let v = a.b.|c;", "|")).toBe("a.b.c");
    expect(at("x = self.items.0.|len;", "|")).toBe("self.items.0.len");
    expect(at("Foo::BA|R", "|")).toBe("Foo::BAR");
    expect(at("se|lf", "|")).toBe("self");
  });

  it("shows nothing for calls, macros, keywords, numbers and blanks", () => {
    expect(at("a.le|n()", "|")).toBeNull();
    expect(at("printl|n!(x)", "|")).toBeNull();
    expect(at("if a != b {}", "")).toBeNull();
    expect(at("le|t a = 1;", "|")).toBeNull();
    expect(at("a = 4|2;", "|")).toBeNull();
    expect(at("a |= 1;", "|")).toBeNull();
    // `!=` after a name isn't a macro.
    expect(at("if fla|g != 0 {}", "|")).toBe("flag");
  });
});
