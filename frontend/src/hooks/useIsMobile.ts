import { useEffect, useState } from "react";

// Same breakpoint public/styles.css already uses to hide .sidebar and show .mobile-header --
// keeping this in sync with that value (rather than introducing a second one) is what lets
// JS-driven layout branches (which sections render, not just how they look) agree with the CSS.
const mobileQuery = "(max-width: 720px)";

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(mobileQuery).matches);
  useEffect(() => {
    const media = window.matchMedia(mobileQuery);
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return isMobile;
}
