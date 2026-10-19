import { useCallback, useEffect, useState } from "react";
import { formatShortcut, Icon, IconButton, pt, SelectField, TextField, useT, withShortcut, Spacer, Divider } from "substrate-platform-ui";
import { hexToRgba, rgbaToCss, rgbaToHex, type PaintSettings, type PaintTool, type Rgba } from "./pixels";

// The paint tools panel: tool buttons, brush size, mirror, fill mode, the
// color (RGB + alpha + hex), a palette and recent colors. Product-agnostic;
// settings persist in localStorage under the host's key.

export interface PaintState extends PaintSettings {
  grid: boolean;
  palette: Rgba[];
  recent: Rgba[];
}

const DEFAULT_PALETTE: Rgba[] = [
  "#000000", "#1d2b53", "#7e2553", "#008751", "#ab5236", "#5f574f", "#c2c3c7", "#fff1e8",
  "#ff004d", "#ffa300", "#ffec27", "#00e436", "#29adff", "#83769c", "#ff77a8", "#ffccaa",
].map((h) => hexToRgba(h)!);

const DEFAULTS: PaintState = {
  tool: "pencil",
  color: [255, 255, 255, 255],
  size: 1,
  mirrorX: false,
  fillGlobal: false,
  rectFilled: false,
  grid: true,
  palette: DEFAULT_PALETTE,
  recent: [],
};

const isRgba = (v: unknown): v is Rgba => Array.isArray(v) && v.length === 4 && v.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);

/** Paint settings, remembered under `storageKey`. */
export function usePaintState(storageKey: string) {
  const [state, setState] = useState<PaintState>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "{}") as Partial<PaintState>;
      return {
        ...DEFAULTS,
        ...saved,
        color: isRgba(saved.color) ? saved.color : DEFAULTS.color,
        palette: Array.isArray(saved.palette) ? saved.palette.filter(isRgba) : DEFAULTS.palette,
        recent: Array.isArray(saved.recent) ? saved.recent.filter(isRgba) : [],
        size: Math.min(MAX_BRUSH, Math.max(1, Number(saved.size) || 1)),
      };
    } catch {
      return DEFAULTS;
    }
  });
  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(state));
  }, [storageKey, state]);
  const set = useCallback((patch: Partial<PaintState>) => setState((s) => ({ ...s, ...patch })), []);
  /** Puts a used color first among the recent ones. */
  const used = useCallback(
    (c: Rgba) => setState((s) => ({ ...s, recent: [c, ...s.recent.filter((r) => rgbaToHex(r) !== rgbaToHex(c))].slice(0, 12) })),
    []
  );
  return { state, set, used };
}

/** The brush sizes: 1 to this many pixels. */
export const MAX_BRUSH = 4;

/** The tools, with their buttons' icons and labels and their keys. */
export const PAINT_TOOLS: { tool: PaintTool; icon: string; label: string; key: string }[] = [
  { tool: "pencil", icon: "paintPencil", label: "Pencil", key: "B" },
  { tool: "eraser", icon: "paintEraser", label: "Eraser", key: "E" },
  { tool: "fill", icon: "paintFill", label: "Fill", key: "F" },
  { tool: "picker", icon: "paintPicker", label: "Color Picker", key: "I" },
  { tool: "line", icon: "paintLine", label: "Line", key: "L" },
  { tool: "rect", icon: "paintRect", label: "Rectangle", key: "R" },
];

/** `tool`'s key. */
export function toolKey(tool: PaintTool): string {
  return PAINT_TOOLS.find((p) => p.tool === tool)?.key ?? "";
}

function ColorChip({ color, active, title, onClick, onContextMenu }: { color: Rgba; active?: boolean; title: string; onClick: () => void; onContextMenu?: (e: React.MouseEvent) => void }) {
  return (
    <button
      type="button"
      className={`paint-chip${active ? " active" : ""}`}
      title={title}
      aria-label={title}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <span style={{ background: rgbaToCss(color) }} />
    </button>
  );
}

export function PaintTools({ paint, onChange, disabled }: { paint: PaintState; onChange: (patch: Partial<PaintState>) => void; disabled?: boolean }) {
  const t = useT();
  const hex = rgbaToHex(paint.color);
  const [hexText, setHexText] = useState(hex);
  useEffect(() => setHexText(hex), [hex]);
  const rgbHex = hex.slice(0, 7);
  const same = (c: Rgba) => rgbaToHex(c) === hex;

  return (
    <div className="paint-tools">
      <div className="paint-tool-row">
        {PAINT_TOOLS.map((x) => (
          <IconButton
            key={x.tool}
            title={`${pt("paint tool", x.label)} (${formatShortcut(x.key.toLowerCase())})`}
            aria-pressed={paint.tool === x.tool}
            className={paint.tool === x.tool ? "paint-on" : undefined}
            disabled={disabled}
            onClick={() => onChange({ tool: x.tool })}
          >
            <Icon name={x.icon} />
          </IconButton>
        ))}
        <Divider />
        <IconButton
          title={withShortcut("Mirror X", "m")}
          aria-pressed={paint.mirrorX}
          className={paint.mirrorX ? "paint-on" : undefined}
          disabled={disabled}
          onClick={() => onChange({ mirrorX: !paint.mirrorX })}
        >
          <Icon name="paintMirror" />
        </IconButton>
        <IconButton title={t("Pixel Grid")} aria-pressed={paint.grid} className={paint.grid ? "paint-on" : undefined} onClick={() => onChange({ grid: !paint.grid })}>
          <Icon name="grid" />
        </IconButton>
      </div>
      <div className="paint-field">
        <span>{t("Brush Size")}</span>
        <SelectField
          aria-label={t("Brush Size")}
          value={String(paint.size)}
          options={Array.from({ length: MAX_BRUSH }, (_, i) => i + 1).map((n) => ({ value: String(n), label: `${n} px` }))}
          onChange={(v) => onChange({ size: Number(v) })}
        />
      </div>
      {paint.tool === "fill" && (
        <div className="paint-field">
          <span>{t("Fill")}</span>
          <SelectField
            aria-label={t("Fill")}
            value={paint.fillGlobal ? "global" : "contiguous"}
            options={[
              { value: "contiguous", label: t("Contiguous") },
              { value: "global", label: t("All of this color") },
            ]}
            onChange={(v) => onChange({ fillGlobal: v === "global" })}
          />
        </div>
      )}
      {paint.tool === "rect" && (
        <div className="paint-field">
          <span>{t("Rectangle")}</span>
          <SelectField
            aria-label={t("Rectangle")}
            value={paint.rectFilled ? "filled" : "outline"}
            options={[
              { value: "outline", label: t("Outline") },
              { value: "filled", label: t("Filled") },
            ]}
            onChange={(v) => onChange({ rectFilled: v === "filled" })}
          />
        </div>
      )}
      <div className="paint-color">
        <label className="paint-color-swatch" title={t("Color")}>
          <span style={{ background: rgbaToCss(paint.color) }} />
          <input
            type="color"
            value={rgbHex}
            onChange={(e) => {
              const c = hexToRgba(e.target.value);
              if (c) onChange({ color: [c[0], c[1], c[2], paint.color[3]] });
            }}
          />
        </label>
        <TextField
          aria-label={t("Hex Color")}
          className="paint-hex"
          value={hexText}
          spellCheck={false}
          onChange={(e) => {
            setHexText(e.target.value);
            const c = hexToRgba(e.target.value);
            if (c) onChange({ color: c });
          }}
          onBlur={() => setHexText(hex)}
        />
      </div>
      <div className="paint-field">
        <span>{t("Alpha")}</span>
        <input
          type="range"
          min={0}
          max={255}
          value={paint.color[3]}
          aria-label={t("Alpha")}
          onChange={(e) => onChange({ color: [paint.color[0], paint.color[1], paint.color[2], Number(e.target.value)] })}
        />
        <span className="paint-alpha">{paint.color[3]}</span>
      </div>
      <div className="content-pane-subheader">
        <span>{t("Palette")}</span>
        <Spacer />
        <IconButton size="sm" title={t("Add the Color to the Palette")} onClick={() => !paint.palette.some(same) && onChange({ palette: [...paint.palette, paint.color] })}>
          <Icon name="plus" />
        </IconButton>
      </div>
      <div className="paint-chips">
        {paint.palette.map((c, i) => (
          <ColorChip
            key={i}
            color={c}
            active={same(c)}
            title={`${rgbaToHex(c)} — ${t("right-click to remove")}`}
            onClick={() => onChange({ color: c })}
            onContextMenu={(e) => {
              e.preventDefault();
              onChange({ palette: paint.palette.filter((_, k) => k !== i) });
            }}
          />
        ))}
      </div>
      {paint.recent.length > 0 && (
        <>
          <div className="content-pane-subheader">
            <span>{t("Recent Colors")}</span>
          </div>
          <div className="paint-chips">
            {paint.recent.map((c, i) => (
              <ColorChip key={i} color={c} active={same(c)} title={rgbaToHex(c)} onClick={() => onChange({ color: c })} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
