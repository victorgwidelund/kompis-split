import { useRef, useState } from "react";
import { api, upload } from "../../api/client";
import { Avatar } from "../../components/Avatar";
import { AdminIcon, BugIcon, ChevronRightIcon, GroupsIcon, GuideIcon, LogoutIcon } from "../../components/icons";
import type { User, View } from "../../types/models";
import { shortVersion } from "../../utils/format";
import { isHeicFile, maxOriginalReceiptBytes, prepareReceiptFile } from "../receipts/imagePrep";
import { disablePush, enablePush, pushSupported } from "../../pushNotifications";

interface Props {
  user: User;
  version: string;
  vapidPublicKey: string | null;
  onUserUpdate: (user: User) => void;
  onNavigate: (view: View) => void;
  onReportBug: () => void;
  onLogout: () => void;
  notify: (message: string) => void;
}

function MoreRow({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button className="more-row" onClick={onClick}>
      <span className="more-row-icon">{icon}</span>
      <span className="more-row-label">{label}</span>
      <ChevronRightIcon />
    </button>
  );
}

export function MorePage({ user, version, vapidPublicKey, onUserUpdate, onNavigate, onReportBug, onLogout, notify }: Props) {
  const [avatarVersion, setAvatarVersion] = useState(0);
  const [hasPhoto, setHasPhoto] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [notificationsBusy, setNotificationsBusy] = useState(false);
  const avatarInput = useRef<HTMLInputElement>(null);
  const changeAvatar = async (file?: File) => {
    if (!file) return;
    if (isHeicFile(file)) return notify("HEIC-bilder stöds inte direkt. Byt kamerans bildformat till \"Mest kompatibelt\" eller spara bilden som JPEG först.");
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) return notify("Välj en JPG-, PNG- eller WebP-bild.");
    if (file.size > maxOriginalReceiptBytes) return notify(`Bilden är för stor (max ${Math.round(maxOriginalReceiptBytes / 1024 / 1024)} MB)`);
    setAvatarBusy(true);
    try {
      const prepared = await prepareReceiptFile(file);
      await upload("/api/users/me/avatar", prepared);
      setAvatarVersion((current) => current + 1);
      notify("Profilbilden sparades");
    } catch (error) { notify(error instanceof Error ? error.message : "Kunde inte spara profilbilden"); }
    finally { setAvatarBusy(false); }
  };
  const removeAvatar = async () => {
    setAvatarBusy(true);
    try { await api("/api/users/me/avatar", { method: "DELETE" }); setAvatarVersion((current) => current + 1); setHasPhoto(false); notify("Profilbilden togs bort"); }
    catch (error) { notify(error instanceof Error ? error.message : "Kunde inte ta bort profilbilden"); }
    finally { setAvatarBusy(false); }
  };
  const browserPermission = pushSupported() ? Notification.permission : "unsupported";
  const toggleNotifications = async (enabled: boolean) => {
    setNotificationsBusy(true);
    try {
      if (enabled) {
        if (!vapidPublicKey) return notify("Push-notiser är inte konfigurerat på den här servern.");
        if (!pushSupported()) return notify("Push-notiser stöds inte i den här webbläsaren.");
        if (Notification.permission === "denied") return notify("Notiser är blockerade för sidan i webbläsaren. Ändra det i webbläsarens inställningar för att aktivera.");
        if (!(await enablePush(vapidPublicKey))) return notify("Kunde inte aktivera push-notiser.");
      } else {
        await disablePush();
      }
      const result = await api<{ user: User }>("/api/notifications/settings", { method: "POST", body: { enabled } });
      onUserUpdate(result.user);
      notify(enabled ? "Push-notiser aktiverade" : "Push-notiser inaktiverade");
    } catch (error) { notify(error instanceof Error ? error.message : "Kunde inte uppdatera notisinställningen"); }
    finally { setNotificationsBusy(false); }
  };
  return (
    <section className="page-view more-view">
      <header className="page-heading"><div><p className="eyebrow">Konto och mer</p><h1>Mer</h1></div></header>
      <div className="more-identity">
        <input ref={avatarInput} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(event) => { void changeAvatar(event.target.files?.[0]); event.currentTarget.value = ""; }} />
        <button type="button" className="more-avatar-button" aria-label="Ändra profilbild" disabled={avatarBusy} onClick={() => avatarInput.current?.click()}>
          <Avatar name={user.name} userId={user.id} refreshKey={avatarVersion} onPhotoStatus={setHasPhoto} />
        </button>
        <div>
          <strong>{user.name}</strong><small>{user.email}</small>
          <div className="more-avatar-actions">
            <button type="button" className="text-button" disabled={avatarBusy} onClick={() => avatarInput.current?.click()}>{avatarBusy ? "Sparar…" : hasPhoto ? "Byt bild" : "Lägg till bild"}</button>
            {hasPhoto && <button type="button" className="text-button" disabled={avatarBusy} onClick={() => void removeAvatar()}>Ta bort</button>}
          </div>
        </div>
      </div>
      <section className="more-notifications">
        <p className="eyebrow">Notiser</p>
        <label className="more-notification-toggle">
          <input type="checkbox" checked={user.notificationsEnabled} disabled={notificationsBusy || !vapidPublicKey} onChange={(event) => void toggleNotifications(event.target.checked)} />
          <span>Push-notiser</span>
        </label>
        <small className="muted">
          {!vapidPublicKey ? "Inte konfigurerat på den här servern."
            : browserPermission === "denied" ? "Blockerat i webbläsaren — ändra det i webbläsarens inställningar för att aktivera."
              : "Få en notis när du läggs till i en grupp, någon lägger till en utgift du är med i, en betalning markeras, eller du blir påmind om obetalt."}
        </small>
      </section>
      <nav className="more-menu" aria-label="Fler funktioner">
        <MoreRow icon={<GroupsIcon />} label="Vänner" onClick={() => onNavigate({ page: "friends" })} />
        <MoreRow icon={<GuideIcon />} label="Användarguide" onClick={() => onNavigate({ page: "guide" })} />
        <MoreRow icon={<BugIcon />} label="Rapportera en bugg" onClick={onReportBug} />
        {user.isAdmin && <MoreRow icon={<AdminIcon />} label="Administration" onClick={() => onNavigate({ page: "admin" })} />}
      </nav>
      <button className="more-row logout-row" onClick={onLogout}><span className="more-row-icon"><LogoutIcon /></span><span className="more-row-label">Logga ut</span></button>
      <small className="app-version more-version" title={`Installerad appversion: ${version}`}>Version {shortVersion(version)}</small>
    </section>
  );
}
