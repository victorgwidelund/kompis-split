import { useId } from "react";
import { brandMarkSvg } from "./brandMarkSvg";

export function BrandMark({ className = "brand-mark" }: { className?: string }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return <span className={className} aria-hidden="true">
    <svg viewBox="0 0 140 140" width="100%" height="100%" dangerouslySetInnerHTML={{ __html: brandMarkSvg(`bm${id}`) }} />
  </span>;
}
