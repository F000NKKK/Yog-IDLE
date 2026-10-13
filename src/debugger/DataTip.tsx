import type { ContextMenuItem, EditorHoverProvider, EditorPointRequest } from "substrate-platform-ui";
import { t } from "substrate-platform-ui";
import { evaluate, expressionAt } from "./variables";
import { VariablesTree } from "./VariablesTree";

/** The expression at an editor point: the selection when the point is in it, else the variable path under it. */
function expressionAtPoint(request: EditorPointRequest): { expr: string; from: number; to: number } | null {
  if (request.selection) {
    const expr = request.selection.text.trim();
    return expr && !expr.includes("\n") ? { expr, from: request.selection.from, to: request.selection.to } : null;
  }
  const found = expressionAt(request.lineText, request.pos - request.lineStart);
  return found && { expr: found.expr, from: request.lineStart + found.from, to: request.lineStart + found.to };
}

/**
 * Visual Studio's DataTips for a paused debugger: hovering a variable in
 * the source shows its value, expandable in place. Evaluated in `frame`
 * (the selected stack frame's id); nothing shows for what doesn't evaluate.
 */
export function dataTipProvider(frame: number): EditorHoverProvider {
  return async (request) => {
    const target = expressionAtPoint(request);
    if (!target) return null;
    const [result] = await evaluate(frame, [target.expr]);
    if (!result?.value) return null;
    return {
      from: target.from,
      to: target.to,
      content: <VariablesTree compact roots={[{ key: target.expr, name: target.expr, variable: result.value }]} />,
    };
  };
}

/** The editor's "Add Watch" item, for the expression at the right-clicked point. */
export function addWatchItem(request: EditorPointRequest, addWatch: (expr: string) => void): ContextMenuItem {
  const target = expressionAtPoint(request);
  return { label: t("Add Watch"), disabled: !target, onSelect: () => target && addWatch(target.expr) };
}
