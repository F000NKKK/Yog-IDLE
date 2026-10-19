// The view's keys, as Blender's numpad: 1/3/7 front/right/top (Ctrl: the
// opposite), 5 perspective/orthographic, 4/6/8/2 orbit by 15°, 0/Home/. back
// to the start.

import { clampPhi, DEFAULT_DISTANCE, NUMPAD_STEP } from "./camera";
import { CENTER, VIEWS } from "./scene";
import type { ThreeView } from "./threeView";
import type { ViewName } from "./viewportTypes";

const NUMPAD = "Numpad";
const DIGIT = "Digit";
/** Keys that bring the camera home besides 0. */
const HOME_CODES = new Set(["Home", "NumpadDecimal", "Period"]);
/** 1/3/7 and the view each shows (and with Ctrl). */
const VIEW_KEYS: Record<string, [ViewName, ViewName]> = { "1": ["front", "back"], "3": ["right", "left"], "7": ["top", "bottom"] };

/** The digit a numpad or number-row key is, or "". */
function digitOf(code: string): string {
  return code.startsWith(NUMPAD) ? code.slice(NUMPAD.length) : code.startsWith(DIGIT) ? code.slice(DIGIT.length) : "";
}

/** Handles a view key — `true` if it was one (the camera has moved: redraw). */
export function viewKey(e: KeyboardEvent, three: ThreeView, toggleOrtho: () => void): boolean {
  const key = digitOf(e.code);
  const cam = three.cam;
  const view = VIEW_KEYS[key];
  if (view) {
    const v = VIEWS[e.ctrlKey ? view[1] : view[0]];
    cam.theta = v.theta;
    cam.phi = v.phi;
  } else if (key === "5") toggleOrtho();
  else if (key === "0" || HOME_CODES.has(e.code)) {
    cam.target.copy(CENTER);
    cam.dist = DEFAULT_DISTANCE;
  } else if (key === "4" || key === "6") cam.theta += (key === "4" ? -1 : 1) * NUMPAD_STEP;
  else if (key === "8" || key === "2") cam.phi = clampPhi(cam.phi + (key === "8" ? -1 : 1) * NUMPAD_STEP);
  else return false;
  return true;
}
