import { useState } from "react";
import type { InvitationPreview } from "../../types/models";
import { shortVersion } from "../../utils/format";

export type AuthMode = "setup" | "login" | "register" | "quick-guest";

interface AuthScreenProps {
  mode: AuthMode;
  needsSetup: boolean;
  invitation: InvitationPreview | null;
  version: string;
  onModeChange: (mode: AuthMode) => void;
  onSubmit: (mode: AuthMode, values: Record<string, string>) => Promise<void>;
}

export function AuthScreen({ mode, needsSetup, invitation, version, onModeChange, onSubmit }: AuthScreenProps) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError(""); setBusy(true);
    try { await onSubmit(mode, Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Något gick fel"); }
    finally { setBusy(false); }
  };
  const subtitle = needsSetup ? "Skapa det första administratörskontot. Dina befintliga grupper bevaras."
    : mode === "quick-guest" ? "Ange bara namn och nummer för att bocka av din del."
    : mode === "register" ? invitation?.kind === "friend" ? "Skapa ditt konto för att lägga till vännen." : "Skapa ditt eget konto för att gå med."
    : invitation?.kind === "friend" ? "Logga in så sparas ni som vänner." : invitation?.kind === "trip" ? "Logga in så läggs gruppen till på ditt konto." : "Logga in för att se dina grupper.";
  const summary = invitation?.kind === "friend"
    ? <><strong>{invitation.inviterName}</strong> vill lägga till dig som vän i Kompis Split.</>
    : invitation?.kind === "quick_tab"
      ? <><strong>{invitation.inviterName}</strong> vill att du bockar av din del av <strong>{invitation.quickTabName}</strong>.</>
      : invitation ? <><strong>{invitation.inviterName}</strong> har bjudit in dig till <strong>{invitation.tripName}</strong>.</> : null;
  return (
    <section className="login-screen" aria-labelledby="auth-title">
      <div className="login-art" aria-hidden="true"><span className="orbit orbit-one" /><span className="orbit orbit-two" /><div className="receipt-card"><p>Helg i Sälen</p><strong>4 286 kr</strong><small>Allt uträknat.</small></div></div>
      <div className="login-card">
        <div className="brand-mark">KS</div><p className="eyebrow">Kompis Split</p><h1 id="auth-title">Pengarna lösta.<br />Vänskapen kvar.</h1><p className="muted">{subtitle}</p>
        {summary && <div className="invite-summary">{summary}</div>}
        <form className="auth-form" onSubmit={submit}>
          {mode === "setup" && <label>Installationslösenord<input name="setupPassword" type="password" autoComplete="one-time-code" required /></label>}
          {mode !== "login" && <label>Ditt namn<input name="name" maxLength={60} autoComplete="name" required /></label>}
          {mode !== "quick-guest" && <label>E-post<input name="email" type="email" maxLength={180} autoComplete="email" required /></label>}
          {mode !== "login" && <label>{mode === "quick-guest" ? "Mobil- eller Swish-nummer" : "Swish-nummer"}<input name="swishPhone" inputMode="tel" autoComplete="tel" placeholder="070 123 45 67" required={mode === "quick-guest"} /></label>}
          {mode !== "quick-guest" && <label>{mode === "login" ? "Lösenord" : "Nytt lösenord"}<input name="password" type="password" minLength={mode === "login" ? undefined : 10} autoComplete={mode === "login" ? "current-password" : "new-password"} required />{mode !== "login" && <small>Minst 10 tecken.</small>}</label>}
          <button className="button primary wide" type="submit" disabled={busy}>{busy ? "Arbetar…" : mode === "setup" ? "Skapa administratör" : mode === "login" ? "Logga in" : mode === "quick-guest" ? "Öppna snabbnotan" : "Skapa konto och gå med"} <span>→</span></button>
          <p className="form-error" role="alert">{error}</p>
          {mode === "login" && invitation && invitation.kind !== "quick_tab" && <button className="text-button" type="button" onClick={() => onModeChange("register")}>Ny här? Skapa konto med inbjudan</button>}
          {mode === "register" && <button className="text-button" type="button" onClick={() => onModeChange("login")}>Har du redan konto? Logga in</button>}
          {mode === "quick-guest" && <small className="muted">Inget konto eller lösenord behövs. Åtkomsten gäller bara den här snabbnotan.</small>}
        </form>
        <small className="app-version auth-version" title={`Installerad appversion: ${version}`}>Version {shortVersion(version)}</small>
      </div>
    </section>
  );
}
