import { useEffect, useState } from "react";
import { initials } from "../utils/format";

const colors = ["#c7e6d2", "#f6ca67", "#bfc6fb", "#ffc6b7", "#d5c2e8", "#b9dcdf"];

export function Avatar({ name, index = 0, userId, refreshKey, onPhotoStatus }: { name: string; index?: number; userId?: number | null; refreshKey?: number; onPhotoStatus?: (hasPhoto: boolean) => void }) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => { setImageFailed(false); }, [userId, refreshKey]);
  if (userId && !imageFailed) {
    return <img className="avatar" src={`/api/users/${userId}/avatar${refreshKey ? `?v=${refreshKey}` : ""}`} alt={name} onLoad={() => onPhotoStatus?.(true)} onError={() => { setImageFailed(true); onPhotoStatus?.(false); }} />;
  }
  return <span className="avatar" style={{ background: colors[index % colors.length] }}>{initials(name)}</span>;
}
