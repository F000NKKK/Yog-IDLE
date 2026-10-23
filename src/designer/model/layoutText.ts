// Minecraft's font as the designer measures it: character widths, wrapping,
// ellipsis, line heights.

import type { Style } from "./layoutWidget";

export const LINE_H = 9;
export const LINE_GAP = 1;
export const F32_MAX = 3.4028235e38;

export function charWidth(c: string): number {
  switch (c) {
    case " ":
      return 4;
    case "!":
    case ",":
    case ".":
    case ":":
    case ";":
    case "|":
    case "'":
    case "i":
      return 2;
    case "l":
    case "`":
      return 3;
    case "(":
    case ")":
    case "*":
    case "<":
    case ">":
    case "{":
    case "}":
    case "f":
    case "k":
    case '"':
      return 5;
    case "t":
    case "[":
    case "]":
    case "I":
      return 4;
    case "@":
    case "~":
      return 7;
    default:
      return 6;
  }
}

export function strWidth(s: string, scale: number): number {
  let w = 0;
  for (const c of s) w += charWidth(c);
  return w * scale;
}

export function wrapText(text: string, maxW: number, scale: number): string[] {
  if (scale <= 0 || maxW <= 0) return [text];
  const spaceW = charWidth(" ") * scale;
  const lines: string[] = [];
  let cur = "";
  let curW = 0;
  const append = (word: string, wordW: number) => {
    if (wordW <= maxW) {
      cur = word;
      curW = wordW;
      return;
    }
    let line = "";
    let w = 0;
    for (const ch of word) {
      const cw = charWidth(ch) * scale;
      if (w + cw > maxW && line !== "") {
        lines.push(line);
        line = "";
        w = 0;
      }
      line += ch;
      w += cw;
    }
    cur = line;
    curW = w;
  };
  for (const word of text.split(" ")) {
    if (word === "") continue;
    const wordW = strWidth(word, scale);
    if (curW === 0) append(word, wordW);
    else if (curW + spaceW + wordW <= maxW) {
      cur += " " + word;
      curW += spaceW + wordW;
    } else {
      lines.push(cur);
      cur = "";
      curW = 0;
      append(word, wordW);
    }
  }
  if (curW > 0 || lines.length === 0) lines.push(cur);
  return lines;
}

/** `line` cut with `...` to fit `maxW` — `render.rs`'s `ellipsize`. */
export function ellipsize(line: string, maxW: number, scale: number): string {
  if (strWidth(line, scale) <= maxW) return line;
  const budget = maxW - strWidth("...", scale);
  let out = "";
  let w = 0;
  for (const c of line) {
    const cw = charWidth(c) * scale;
    if (w + cw > budget) break;
    out += c;
    w += cw;
  }
  return out.trimEnd() + "...";
}

/** The lines a label/button draws in `availW` — `render.rs`'s `text_lines`. */
export function textLines(text: string, s: Style, availW: number): string[] {
  if (s.ellipsis) return [ellipsize(text, availW, s.fontScale)];
  return s.noWrap ? [text] : wrapText(text, availW, s.fontScale);
}

/** Width of the strip a ScrollView reserves for its scrollbar (`layout::SCROLLBAR_W`). */
export const SCROLLBAR_W = 6;

export function textHeight(text: string, maxW: number, scale: number): number {
  const n = Math.max(1, wrapText(text, maxW, scale).length);
  return n * LINE_H * scale + Math.max(0, n - 1) * LINE_GAP;
}
