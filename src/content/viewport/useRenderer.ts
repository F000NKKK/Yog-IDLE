import { type MutableRefObject, type RefObject, useEffect } from "react";
import * as THREE from "three";
import { drawFrame } from "./draw";
import type { ThreeView } from "./threeView";

const CLEAR_COLOR = 0x262626;

/** The WebGL renderer in `hostRef`, drawing on demand (`invalidate`): on resize, focus, becoming visible, and whenever asked. */
export function useRenderer(hostRef: RefObject<HTMLDivElement | null>, three: ThreeView, ortho: boolean, invalidate: MutableRefObject<() => void>) {
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(CLEAR_COLOR);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.autoClear = false;
    host.appendChild(renderer.domElement);
    three.renderer = renderer;
    const draw = () => drawFrame(three, renderer, host, ortho, () => invalidate.current());
    invalidate.current = () => {
      if (!three.frame) three.frame = requestAnimationFrame(draw);
    };
    const ro = new ResizeObserver(() => invalidate.current());
    ro.observe(host);
    const onFocus = () => invalidate.current();
    const onVisibilityChange = () => {
      if (!document.hidden) invalidate.current();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    invalidate.current();
    return () => {
      ro.disconnect();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      cancelAnimationFrame(three.frame);
      clearTimeout(three.tick);
      three.frame = 0;
      renderer.dispose();
      renderer.domElement.remove();
      three.renderer = null;
    };
  }, [hostRef, three, ortho, invalidate]);
}
