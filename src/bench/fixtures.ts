import { yui } from "../data/yogIds.generated";
// Synthetic inputs for the vitest benches and the equivalence tests that
// keep the optimized code saying exactly what it said before. (No `Grid.Row`-style
// attributes: happy-dom's XML parser rejects dotted attribute names.)

const LABELS = ["Inventory", "Crafting grid", "Result", "Fuel", "Progress: 42%", "Click to toggle the whole thing"];

/** A `.yui` screen: `depth` levels of nested Columns/Rows/Grids, `width` widgets per level. */
export function yuiText(depth: number, width: number): string {
  const lines: string[] = ['<?xml version="1.0" encoding="utf-8"?>', '<Screen id="bench:screen" width="320" height="240" anchor="center" x:ViewModel="BenchVm">'];
  let n = 0;
  const level = (d: number, indent: string) => {
    for (let i = 0; i < width; i++) {
      const id = n++;
      if (d < depth && i === 0) {
        const kind = d % 3 === 0 ? yui.COLUMN : d % 3 === 1 ? yui.ROW : yui.GRID;
        lines.push(`${indent}<${kind} x:Name="c${id}" gap="2" padding="2" bg="#ff202020" w="${d % 2 ? "100%" : "auto"}">`);
        if (kind === yui.GRID) {
          lines.push(`${indent}    <Grid.ColumnDefinitions>`, `${indent}        <ColumnDefinition Width="Auto" />`, `${indent}        <ColumnDefinition Width="*" />`, `${indent}    </Grid.ColumnDefinitions>`);
        }
        level(d + 1, `${indent}    `);
        lines.push(`${indent}</${kind}>`);
      } else if (i % 3 === 1) {
        lines.push(`${indent}<Button x:Name="b${id}" text="${LABELS[id % LABELS.length]}" on_click="Click${id}" />`);
      } else {
        lines.push(`${indent}<Label text="${LABELS[id % LABELS.length]} ${id}" color="#ffe0e0e0" />`);
      }
    }
  };
  level(0, "    ");
  lines.push("</Screen>", "");
  return lines.join("\n");
}

/** `.yres` text with `count` entries of every kind. */
export function yresText(count: number): string {
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    switch (i % 4) {
      case 0:
        parts.push(`  "screen.label_${i}": "Label number ${i} with \\"quotes\\" and ünïcödé"`);
        break;
      case 1:
        parts.push(`  "tooltip_${i}": {\n    "value": "A tooltip ${i}",\n    "comment": "Shown on hover"\n  }`);
        break;
      case 2:
        parts.push(`  "accent_${i}": {\n    "type": "color",\n    "value": "#ff${(i % 256).toString(16).padStart(2, "0")}8040"\n  }`);
        break;
      default:
        parts.push(`  "speed_${i}": {\n    "type": "number",\n    "value": ${i / 4}\n  }`);
    }
  }
  return `{\n${parts.join(",\n")}\n}\n`;
}

/** A `.yblock` with `elements` model elements, comments and trailing commas. */
export function contentText(elements: number): string {
  const els: string[] = [];
  for (let i = 0; i < elements; i++) {
    const a = i % 16;
    els.push(`      {
        // element ${i}
        "from": [${a}, 0, ${a}],
        "to": [${a + 1}, ${(i % 7) + 1}, 16],
        "rotation": { "origin": [8, 8, 8], "axis": "y", "angle": 22.5 },
        "faces": {
          "north": { "uv": [0, 0, 16, 16], "texture": "#side" },
          "south": { "uv": [0, 0, 16, 16], "texture": "#side", "cullface": "south" },
          "up": { "uv": [0, 0, 16, 16], "texture": "#top", },
        },
      }`);
  }
  return `{
  "name": "@Strings.block.bench", // the display name
  "block": { "hardness": 2, "resistance": 6, "sound": "stone", "connect_groups": ["analog", "digital"] },
  "model": {
    "textures": { "side": "block/side.png", "top": "block/top.png", "note": "a // not a comment, ]" },
    "elements": [
${els.join(",\n")},
    ],
  },
}
`;
}
