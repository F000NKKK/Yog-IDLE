// What the designer draws over the real picture: container outlines and
// Minecraft-style text.

import type { CSSProperties, ReactNode } from "react";
import type { DesignRect } from "substrate-platform-ui";
import { yui } from "../../data/yogIds.generated";
import { charWidth, LINE_GAP, LINE_H, strWidth, textLines } from "../layoutText";
import type { LNode, LWidget } from "../layoutWidget";
import { cssColor, isContainer, type YuiNode } from "../yui";
import type { Geo } from "./designerModel";
import { ALPHA_SHIFT, OPAQUE, SLOT_COUNT } from "../colors";

/** Designer-only dashed outlines of containers and spacers — invisible in game, so drawn over the real picture. */
export function DesignOutlines({ root, geo, zoom }: { root: YuiNode; geo: Map<string, Geo>; zoom: number }) {
  const out: ReactNode[] = [];
  const visit = (n: YuiNode) => {
    const g = geo.get(n.uid);
    if (g && (isContainer(n) || n.kind === yui.SPACER)) out.push(<div key={n.uid} className="yui-box yui-outline" style={box(g.rect, zoom)} />);
    if (isContainer(n)) n.children.forEach(visit);
  };
  visit(root);
  return <>{out}</>;
}

// ── Fallback: Minecraft-like rendering in TypeScript (mirrors `render.rs`) ────

export const box = (r: DesignRect, zoom: number): CSSProperties => ({ left: r.x * zoom, top: r.y * zoom, width: r.w * zoom, height: r.h * zoom });

/** Minecraft's drop shadow: the text color at a quarter brightness. */
export function shadowOf(argb: number): string {
  const q = (v: number) => Math.floor(v / 4);
  return `rgb(${q((argb >>> 16) & 0xff)}, ${q((argb >>> 8) & 0xff)}, ${q(argb & 0xff)})`;
}

export function McText({ text, x, y, scale, color, shadow, zoom }: { text: string; x: number; y: number; scale: number; color: number; shadow: boolean; zoom: number }) {
  const spans: ReactNode[] = [];
  let cx = x;
  let i = 0;
  const opaque = (color >>> ALPHA_SHIFT) === 0 ? (color | OPAQUE) >>> 0 : color;
  for (const ch of text) {
    const w = charWidth(ch) * scale;
    if (ch !== " ")
      spans.push(
        <span
          key={i}
          className="yui-char"
          style={{
            left: cx * zoom,
            top: y * zoom,
            width: w * zoom,
            height: LINE_H * scale * zoom,
            fontSize: 8 * scale * zoom,
            color: cssColor(opaque),
            textShadow: shadow ? `${zoom}px ${zoom}px 0 ${shadowOf(opaque)}` : undefined,
          }}
        >
          {ch}
        </span>
      );
    cx += w;
    i++;
  }
  return <>{spans}</>;
}

export function McWidget({ widget, node, zoom }: { widget: LWidget; node: LNode; zoom: number }) {
  if (!widget.visible) return null;
  const r = node.rect;
  const s = widget.style;
  const parts: ReactNode[] = [];
  if (widget.uid !== "" && (s.bg >>> 24) !== 0) parts.push(<div key="bg" className="yui-box" style={{ ...box(r, zoom), background: cssColor(s.bg) }} />);
  const outline = widget.uid !== "" && (widget.kind === "panel" || widget.kind === "spacer");
  if (outline) parts.push(<div key="outline" className="yui-box yui-outline" style={box(r, zoom)} />);

  if (widget.kind === "label" || widget.kind === "button") {
    const availW = Math.max(0, r.w - s.pad[1] - s.pad[3]);
    const lines = textLines(widget.text, s, availW);
    const lineH = LINE_H * s.fontScale + LINE_GAP;
    const totalH = lines.length * lineH - LINE_GAP;
    const contentH = r.h - s.pad[0] - s.pad[2];
    const startY = r.y + s.pad[0] + Math.max(0, (contentH - totalH) / 2);
    lines.forEach((line, i) => {
      const lineW = strWidth(line, s.fontScale);
      let tx = r.x + s.pad[3];
      if (widget.kind === "button") tx += Math.max(0, (availW - lineW) / 2);
      else if (s.align === "center") tx += (availW - lineW) / 2;
      else if (s.align === "end") tx += Math.max(0, availW - lineW);
      parts.push(<McText key={`t${i}`} text={line} x={tx} y={startY + i * lineH} scale={s.fontScale} color={s.color} shadow={s.shadow} zoom={zoom} />);
    });
  } else if (widget.kind === "text_box") {
    // Vanilla EditBox: 1 px grey border, the text (or the greyed placeholder) on one clipped line.
    parts.push(<div key="border" className="yui-box" style={{ ...box(r, zoom), boxShadow: `inset 0 0 0 ${zoom}px #A0A0A0`, overflow: "hidden" }} />);
    const shown = widget.text || widget.placeholder;
    const color = widget.text ? s.color : 0xff707070;
    const ty = r.y + s.pad[0] + Math.max(0, (r.h - s.pad[0] - s.pad[2] - LINE_H * s.fontScale) / 2);
    const inner = { x: r.x + s.pad[3], y: r.y, w: Math.max(0, r.w - s.pad[1] - s.pad[3]), h: r.h };
    parts.push(
      <div key="text" className="yui-box" style={{ ...box(inner, zoom), overflow: "hidden" }}>
        <McText text={shown} x={0} y={ty - r.y} scale={s.fontScale} color={color} shadow={s.shadow} zoom={zoom} />
      </div>
    );
  } else if (widget.kind === "item_slot" || widget.kind === "inv_slot") {
    const slot = { x: r.x + s.pad[3], y: r.y + s.pad[0], w: 18, h: 18 };
    const name = widget.item.split(":").pop() ?? "";
    parts.push(
      <div key="slot" className={`yui-box ${widget.kind === "inv_slot" ? "yui-inv-slot" : "yui-item-slot"}`} style={{ ...box(slot, zoom), borderWidth: zoom }} title={widget.item}>
        <span className="yui-item" style={{ fontSize: 6 * zoom }}>
          {name.slice(0, 2)}
        </span>
      </div>
    );
    if (widget.kind === "inv_slot" && widget.count > 1)
      parts.push(<McText key="count" text={String(widget.count)} x={slot.x + 17 - strWidth(String(widget.count), 1)} y={slot.y + 9} scale={1} color={SLOT_COUNT} shadow zoom={zoom} />);
  } else if (widget.kind === "image") {
    parts.push(
      <div key="img" className="yui-box yui-image" style={box({ x: r.x + s.pad[3], y: r.y + s.pad[0], w: Math.max(0, r.w - s.pad[1] - s.pad[3]), h: Math.max(0, r.h - s.pad[0] - s.pad[2]) }, zoom)} title={widget.source}>
        <span style={{ fontSize: 6 * zoom }}>{widget.source.split("/").pop()}</span>
      </div>
    );
  }
  widget.children.forEach((c, i) => node.children[i] && parts.push(<McWidget key={c.uid || i} widget={c} node={node.children[i]} zoom={zoom} />));
  return <>{parts}</>;
}
