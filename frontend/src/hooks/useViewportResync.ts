import { useEffect } from "react";

// iOS Safari (seen on iOS 26, bug report #13) can leave the visual viewport offset from the layout
// viewport after the on-screen keyboard closes. Everything pinned with position:fixed/sticky is laid
// out against the layout viewport, so the bottom nav then floats a keyboard-height up the screen and
// the sticky header disappears above it, until a reload. A same-position scrollTo makes Safari
// re-sync the two viewports; it is a no-op everywhere the viewports already agree.
export function needsViewportResync(offsetTop: number, scale: number, editing: boolean): boolean {
  // While a field is focused the offset is the keyboard doing its job; while pinch-zoomed it's the
  // user panning. Only an offset left behind with neither is the stale state worth correcting.
  return !editing && Math.abs(scale - 1) < 0.01 && offsetTop > 1;
}

function isEditing(): boolean {
  return document.activeElement?.closest("input, textarea, select, [contenteditable='true']") != null;
}

export function useViewportResync() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let frame = 0;
    const check = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (needsViewportResync(viewport.offsetTop, viewport.scale, isEditing())) window.scrollTo(window.scrollX, window.scrollY);
      });
    };
    // Deliberately not on viewport "scroll": a scrollTo during a flick would stop momentum scrolling.
    // The keyboard closing always resizes the visual viewport; focusout fires before it has animated
    // away, so also re-check once it has settled.
    const afterBlur = () => window.setTimeout(check, 350);
    viewport.addEventListener("resize", check);
    window.addEventListener("focusout", afterBlur);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", check);
      window.removeEventListener("focusout", afterBlur);
    };
  }, []);
}
