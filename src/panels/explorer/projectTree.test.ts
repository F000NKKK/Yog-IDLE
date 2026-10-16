import { describe, expect, it } from "vitest";
import { fileTreeFromEntries, filterFileTree, nestFiles, type DirEntry, type FileTreeNode } from "substrate-platform-ui";
import { explorerMatch, nestParent, pathTo, placeholderId, withChangeMarks, withFaded, withPlaceholder, withProjectItems } from "./projectTree";
import { boundCommands, EXPLORER_COMMANDS } from "./commands";

const file = (path: string): DirEntry => ({ name: path.split("/").pop()!, path, kind: "file" });
const dir = (path: string): DirEntry => ({ name: path.split("/").pop()!, path, kind: "dir" });

const ENTRIES = [
  file("/m/yog.toml"),
  file("/m/yog.lock"),
  dir("/m/src"),
  file("/m/src/lib.rs"),
  dir("/m/src/ui"),
  file("/m/src/ui/menu.yui"),
  file("/m/src/ui/menu.rs"),
  dir("/m/target"),
  file("/m/target/out.o"),
];
const TREE = nestFiles(fileTreeFromEntries("/m", "m", ENTRIES), nestParent);

const names = (nodes: FileTreeNode[]): unknown =>
  nodes.map((n) => {
    const inner = n.children ?? n.nested;
    const label = `${n.name}${n.faded ? "~" : ""}`;
    return inner ? { [label]: names(inner) } : label;
  });

describe("Project Explorer's tree", () => {
  it("nests a screen's code-behind and the lock file", () => {
    expect(names(TREE)).toEqual([
      { m: [{ src: [{ ui: [{ "menu.yui": ["menu.rs"] }] }, "lib.rs"] }, { target: ["out.o"] }, { "yog.toml": ["yog.lock"] }] },
    ]);
  });

  it("Show All Files: hides what isn't part of the project, or dims it", () => {
    const raw = fileTreeFromEntries("/m", "m", ENTRIES);
    const items = new Set(ENTRIES.map((e) => e.path).filter((p) => !p.startsWith("/m/target")));
    const hidden = names(withProjectItems(raw, "/m", items, false)) as { m: unknown[] }[];
    expect(JSON.stringify(hidden)).not.toContain("target");
    expect(JSON.stringify(names(withProjectItems(raw, "/m", items, true)))).toContain('{"target~":["out.o~"]}');
    expect(withProjectItems(raw, "/m", null, false)).toBe(raw);
  });

  it("marks changed files and the folders they're in", () => {
    const marked = withChangeMarks(TREE, new Map([["/m/src/ui/menu.rs", "modified"]]), (kind) => kind, "dot");
    const ui = marked[0].children![0].children![0];
    expect(ui.decoration).toBe("dot");
    expect(marked[0].decoration).toBe("dot");
    expect(ui.children![0].nested![0].decoration).toBe("modified");
    expect(marked[0].children![2].decoration).toBeUndefined();
  });

  it("dims cut items and everything in them", () => {
    const cut = withFaded(TREE, ["/m/src/ui"]);
    expect(JSON.stringify(names(cut))).toContain('{"ui~":[{"menu.yui~":["menu.rs~"]}]}');
  });

  it("puts a new folder's row first and a new file's after the folders", () => {
    const folderRow = withPlaceholder(TREE, "/m/src", "folder")[0].children![0].children!;
    expect(folderRow[0].id).toBe(placeholderId("/m/src"));
    const fileRow = withPlaceholder(TREE, "/m/src", "file")[0].children![0].children!;
    expect(fileRow.map((n) => n.id)).toEqual(["/m/src/ui", placeholderId("/m/src"), "/m/src/lib.rs"]);
  });

  it("finds the rows to open to show a nested file", () => {
    expect(pathTo(TREE, "/m/src/ui/menu.rs")).toEqual(["/m", "/m/src", "/m/src/ui", "/m/src/ui/menu.yui"]);
    expect(pathTo(TREE, "/m/nope")).toBeNull();
  });
});

describe("explorerMatch", () => {
  it("searches names, marking the hits, and keeps the way to them", () => {
    const result = filterFileTree(TREE, explorerMatch({ query: "menu", contentHits: null, only: null }));
    expect(names(result.nodes)).toEqual([{ m: [{ src: [{ ui: [{ "menu.yui": ["menu.rs"] }] }] }] }]);
    expect(result.highlights.get("/m/src/ui/menu.rs")).toEqual([[0, 4]]);
  });

  it("adds files whose contents match", () => {
    const result = filterFileTree(TREE, explorerMatch({ query: "needle", contentHits: new Set(["/m/src/lib.rs"]), only: null }));
    expect(names(result.nodes)).toEqual([{ m: [{ src: ["lib.rs"] }] }]);
  });

  it("Open Files / Pending Changes keep only their files, and narrow a search", () => {
    const only = new Set(["/m/yog.lock", "/m/src/lib.rs"]);
    expect(names(filterFileTree(TREE, explorerMatch({ query: "", contentHits: null, only })).nodes)).toEqual([
      { m: [{ src: ["lib.rs"] }, { "yog.toml": ["yog.lock"] }] },
    ]);
    expect(names(filterFileTree(TREE, explorerMatch({ query: "lock", contentHits: null, only })).nodes)).toEqual([{ m: [{ "yog.toml": ["yog.lock"] }] }]);
  });
});

describe("explorer commands", () => {
  it("binds each shortcut once", () => {
    const keys = [...boundCommands(false), ...boundCommands(true)].map(([, c]) => c.shortcut.toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
    expect(boundCommands(true).map(([id]) => id)).toEqual(["syncActive", "filterOpenFiles", "filterPendingChanges", "search"]);
    expect(Object.values(EXPLORER_COMMANDS).every((c) => c.label.trim() !== "")).toBe(true);
  });
});
