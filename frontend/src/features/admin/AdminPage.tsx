import { useEffect, useState } from "react";
import { Avatar } from "../../components/Avatar";
import { DialogHeader, Modal } from "../../components/Modal";
import { EmptyState } from "../../components/EmptyState";
import type { AdminResponse, BugReport, EmailSettings, OcrBenchmarkJob } from "../../types/models";
import { copyText } from "../../utils/browser";
import { formatDate, formatMoney } from "../../utils/format";

const activityLabels: Record<string, string> = {
  "account.bootstrap": "Administratörskonto skapades", "trip.created": "Grupp skapades", "trip.archived": "Grupp arkiverades", "trip.restored": "Grupp återställdes", "trip.deleted": "Grupp flyttades till papperskorgen", "trip.undeleted": "Grupp återställdes från papperskorgen", "participant.added": "Person lades till", "expense.created": "Utgift skapades", "expense.updated": "Utgift redigerades", "expense.voided": "Utgift togs bort från beräkningen", "receipt.created": "Kvitto laddades upp", "receipt.deleted": "Kvitto togs bort", "category.created": "Kategori skapades", "category.updated": "Kategori uppdaterades", "payment.created": "Betalning registrerades", "payment.voided": "Betalning togs bort från beräkningen", "invitation.created": "Inbjudan skapades", "invitation.joined": "Inbjudan användes", "friend_invitation.created": "Väninbjudan skapades", "friend_invitation.joined": "Väninbjudan användes", "admin.user.updated": "Användarkonto uppdaterades", "quick_tab.deleted": "Snabbnota togs bort", "bug_report.created": "Buggrapport skickades", "admin.email_settings.updated": "E-postinställningar uppdaterades", "reminders.sent": "Betalningspåminnelser skickades", "user.password_reset": "Lösenord återställdes",
};

function bugReportText(report: BugReport): string {
  const lines = [
    `Buggrapport #${report.id} · ${report.resolvedAt ? "Löst" : "Olöst"}`,
    `Rapporterad av: ${report.reporterName || "Okänd"} · ${formatDate(report.createdAt)}`,
    "",
    "Beskrivning:",
    report.description,
    "",
    "Teknisk information:",
    `Sida: ${report.pageUrl || "Okänd"}`,
    `Appversion: ${report.appVersion || "Okänd"}`,
    `Webbläsare: ${report.userAgent || "Okänd"}`,
    report.hasScreenshot
      ? `Skärmbild: ${location.origin}/api/admin/bug-reports/${report.id}/screenshot (öppnas inloggad som admin)`
      : "Ingen skärmbild bifogad",
  ];
  if (report.breadcrumbs.length) lines.push("", "Senaste API-anrop:", ...report.breadcrumbs.map((entry) => `- ${entry}`));
  return lines.join("\n");
}

interface EmailSettingsPanelProps {
  settings: EmailSettings;
  onSave: (values: { tenantId: string; clientId: string; clientSecret: string; senderEmail: string }) => Promise<void>;
  onTest: (recipientEmail: string) => Promise<string>;
}

function EmailSettingsPanel({ settings, onSave, onTest }: EmailSettingsPanelProps) {
  const [tenantId, setTenantId] = useState(settings.tenantId);
  const [clientId, setClientId] = useState(settings.clientId);
  const [clientSecret, setClientSecret] = useState("");
  const [senderEmail, setSenderEmail] = useState(settings.senderEmail);
  const [testRecipient, setTestRecipient] = useState(settings.senderEmail);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");
  const [testStatus, setTestStatus] = useState("");
  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSaving(true); setSaveStatus("");
    try { await onSave({ tenantId, clientId, clientSecret, senderEmail }); setClientSecret(""); }
    catch (error) { setSaveStatus(error instanceof Error ? error.message : "Kunde inte spara"); }
    finally { setSaving(false); }
  };
  const test = async () => {
    setTesting(true); setTestStatus("");
    try { setTestStatus(await onTest(testRecipient)); }
    catch (error) { setTestStatus(error instanceof Error ? error.message : "Kunde inte skicka testmail"); }
    finally { setTesting(false); }
  };
  return <section className="panel admin-panel"><div className="panel-title"><div><p className="eyebrow">E-post</p><h2>Microsoft Graph</h2></div><span className={`role-badge ${settings.configured ? "positive-badge" : "muted-badge"}`}>{settings.configured ? "Konfigurerad" : "Ej konfigurerad"}</span></div>
    <form className="auth-form" onSubmit={save}>
      <div className="form-row"><label>Tenant-ID<input value={tenantId} onChange={(event) => setTenantId(event.target.value)} maxLength={100} required /></label><label>Klient-ID (app-registrering)<input value={clientId} onChange={(event) => setClientId(event.target.value)} maxLength={100} required /></label></div>
      <div className="form-row"><label>Klienthemlighet{settings.hasSecret && <small>Satt — lämna tomt för att behålla</small>}<input type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} maxLength={300} placeholder={settings.hasSecret ? "••••••••" : ""} required={!settings.hasSecret} /></label><label>Avsändaradress<input type="email" value={senderEmail} onChange={(event) => setSenderEmail(event.target.value)} maxLength={180} required /></label></div>
      <button className="button dark" type="submit" disabled={saving}>{saving ? "Sparar…" : "Spara inställningar"}</button>
      {saveStatus && <p className="form-error" role="alert">{saveStatus}</p>}
    </form>
    <div className="email-settings-actions"><label className="grow">Skicka testmail till<input type="email" value={testRecipient} onChange={(event) => setTestRecipient(event.target.value)} maxLength={180} /></label><button className="button ghost small-button" type="button" onClick={() => void test()} disabled={testing || !settings.configured}>{testing ? "Skickar…" : "Skicka testmail"}</button></div>
    {testStatus && <small className="email-settings-status">{testStatus}</small>}
    <small className="email-settings-status">Betalningspåminnelser skickas av varje användare själv från startsidan, inte härifrån — det påminner bara om vad andra är skyldiga en specifik person.</small>
  </section>;
}

interface OcrBenchmarkPanelProps {
  onRun: (mode: "parser" | "image") => Promise<{ available: boolean; job: OcrBenchmarkJob }>;
  onStatus: () => Promise<{ available: boolean; job: OcrBenchmarkJob | null }>;
}

function OcrBenchmarkPanel({ onRun, onStatus }: OcrBenchmarkPanelProps) {
  const [available, setAvailable] = useState(true);
  const [job, setJob] = useState<OcrBenchmarkJob | null>(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState<"parser" | "image" | null>(null);

  useEffect(() => { void onStatus().then((payload) => { setAvailable(payload.available); setJob(payload.job); }); }, [onStatus]);
  useEffect(() => {
    if (job?.status !== "running") return;
    const timer = window.setInterval(() => { void onStatus().then((payload) => setJob(payload.job)); }, 2000);
    return () => window.clearInterval(timer);
  }, [job?.status, onStatus]);

  const run = async (mode: "parser" | "image") => {
    setStarting(mode); setError("");
    try { setJob((await onRun(mode)).job); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Kunde inte starta benchmark"); }
    finally { setStarting(null); }
  };

  const pct = (value: number | null) => (value === null ? "–" : `${(value * 100).toFixed(0)} %`);
  const ms = (value: number | null) => (value === null ? "–" : `${Math.round(value)} ms`);
  const report = job?.report;
  const failures = report?.scores?.filter((score) => !score.financiallyReconciled) || [];

  return <section className="panel admin-panel"><div className="panel-title"><div><p className="eyebrow">Kvalitetskontroll</p><h2>OCR-benchmark</h2></div>{job && <span className={`role-badge ${job.status === "running" ? "muted-badge" : job.status === "error" ? "danger-badge" : "positive-badge"}`}>{job.status === "running" ? "Kör…" : job.status === "error" ? "Fel" : "Klar"}</span>}</div>
    {!available ? <p className="muted">Benchmark-korpusen saknas i den här installationen (behöver köras från en image byggd efter v1.23.0).</p> : <>
      <p className="muted">Kör den riktiga kvittoläsningen mot den offentliga utvecklingskorpusen med svenska testkvitton och facit. Snabb kontroll rör bara parsern, ingen OCR/GPU. Verklig pipeline anropar samma lokala OCR som riktiga kvitton — kan ta någon minut.</p>
      <div className="email-settings-actions">
        <button className="button ghost small-button" type="button" disabled={job?.status === "running" || starting !== null} onClick={() => void run("parser")}>{starting === "parser" ? "Startar…" : "Snabb kontroll"}</button>
        <button className="button dark small-button" type="button" disabled={job?.status === "running" || starting !== null} onClick={() => void run("image")}>{starting === "image" ? "Startar…" : "Verklig OCR-pipeline"}</button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {job?.status === "running" && <small className="email-settings-status">{job.progress.total ? `${job.progress.completed}/${job.progress.total} kvitton bearbetade…` : "Startar…"}</small>}
      {job?.status === "error" && <p className="form-error" role="alert">{job.error}</p>}
      {report?.overall && <>
        <small className="email-settings-status">{report.fixtureCount} kvitton · {report.mode === "image" ? "verklig pipeline" : "endast parser"}{report.sources && ` · ${Object.entries(report.sources).map(([source, count]) => `${source}: ${count}`).join(", ")}`} · klart {formatDate(report.generatedAt)}</small>
        <table className="ocr-benchmark-table"><tbody>
          <tr><th>Köpman</th><td>{pct(report.overall.merchantAccuracy)}</td></tr>
          <tr><th>Datum</th><td>{pct(report.overall.dateAccuracy)}</td></tr>
          <tr><th>Totalbelopp</th><td>{pct(report.overall.totalAccuracy)}</td></tr>
          <tr><th>Artikel-F1</th><td>{pct(report.overall.itemF1)}</td></tr>
          <tr><th>Prisnoggrannhet</th><td>{pct(report.overall.priceAccuracy)}</td></tr>
          <tr><th>Antalsnoggrannhet</th><td>{pct(report.overall.quantityAccuracy)}</td></tr>
          <tr><th>Exakt avstämning</th><td>{pct(report.overall.exactReconciliation)}</td></tr>
          <tr><th>Falska metadata-rader</th><td>{report.overall.falseMetadataItemsTotal}</td></tr>
          <tr><th>Behöver granskning</th><td>{report.overall.receiptsNeedingReview}/{report.overall.receiptCount}</td></tr>
          {report.mode === "image" && <tr><th>Medianhastighet</th><td>{ms(report.overall.medianMs)} (P95 {ms(report.overall.p95Ms)})</td></tr>}
        </tbody></table>
        {failures.length > 0 && <details className="bug-report-context"><summary>{failures.length} kvitton med avvikelse</summary><ul className="bug-report-breadcrumbs">{failures.map((score) => <li key={score.id}>{score.id} ({score.category}/{score.difficulty}){score.unmatchedTruthNames.length ? ` · saknade: ${score.unmatchedTruthNames.join(", ")}` : ""}{score.falseMetadataItems.length ? ` · falska rader: ${score.falseMetadataItems.join(", ")}` : ""}</li>)}</ul></details>}
      </>}
    </>}
  </section>;
}

interface Props {
  data: AdminResponse;
  currentUserId: number;
  demoMode: boolean;
  onEnterDemo: () => void;
  onBack: () => void;
  onRefresh: () => void;
  onOpenTrip: (id: number) => void;
  onUserUpdate: (id: number, update: { isAdmin?: boolean; isDisabled?: boolean }) => void;
  onTripArchive: (id: number, archived: boolean) => void;
  onTripRestore: (id: number) => void;
  onQuickTabDelete: (id: number) => void;
  onBugReportResolve: (id: number, resolved: boolean) => void;
  onBugReportDelete: (id: number) => void;
  onEmailSettingsSave: (values: { tenantId: string; clientId: string; clientSecret: string; senderEmail: string }) => Promise<void>;
  onEmailSettingsTest: (recipientEmail: string) => Promise<string>;
  onOcrBenchmarkRun: (mode: "parser" | "image") => Promise<{ available: boolean; job: OcrBenchmarkJob }>;
  onOcrBenchmarkStatus: () => Promise<{ available: boolean; job: OcrBenchmarkJob | null }>;
}

export function AdminPage({ data, currentUserId, demoMode, onEnterDemo, onBack, onRefresh, onOpenTrip, onUserUpdate, onTripArchive, onTripRestore, onQuickTabDelete, onBugReportResolve, onBugReportDelete, onEmailSettingsSave, onEmailSettingsTest, onOcrBenchmarkRun, onOcrBenchmarkStatus }: Props) {
  const [openReportId, setOpenReportId] = useState<number | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const openReport = data.bugReports.find((item) => item.id === openReportId) || null;
  const copyReport = async (report: BugReport) => {
    try { await copyText(bugReportText(report)); setCopyStatus("Kopierat!"); }
    catch { setCopyStatus("Kunde inte kopiera"); }
    setTimeout(() => setCopyStatus(""), 2500);
  };
  return <section className="admin-view">
    <header className="dashboard-heading"><div><button className="mobile-back visible-back" onClick={onBack}>← Till startsidan</button><p className="eyebrow">Appadministration</p><h1>Hela Kompis Split</h1><p>Användare, grupper och aktivitet. Alla åtgärder kontrolleras på servern.</p></div><div className="header-actions"><button className="button ghost" disabled={demoMode} onClick={onEnterDemo} title={demoMode ? "Redan i demoläge" : "Visa appen med fiktiva exempeldata utan att röra riktiga konton"}>Demoläge</button><button className="button ghost" onClick={onRefresh}>Uppdatera</button></div></header>
    <div className="summary-grid admin-stats"><article className="hero-stat coral"><span className="stat-icon">●</span><p>Användare</p><strong>{data.stats.userCount}</strong><small>{data.stats.activeUserCount} aktiva</small></article><article className="hero-stat cobalt"><span className="stat-icon">✦</span><p>Grupper</p><strong>{data.stats.tripCount}</strong><small>{data.stats.activeTripCount} aktiva · {data.stats.deletedTripCount} borttagna</small></article><article className="member-stat"><p>Registrerade utgifter</p><strong>{formatMoney(data.stats.totalCents)}</strong><small>över hela appen</small></article></div>
    <section className="panel admin-panel"><div className="panel-title"><div><p className="eyebrow">Konton</p><h2>Alla användare</h2></div></div><div className="admin-list">{data.users.length ? data.users.map((user, index) => { const self = user.id === currentUserId; return <article className={`admin-row${user.isDisabled ? " disabled-row" : ""}`} key={user.id}><Avatar name={user.name} index={index} /><div className="admin-row-main"><strong>{user.name} {user.isAdmin && <span className="role-badge">Admin</span>}</strong><small>{user.email} · {user.tripCount} grupper · konto {formatDate(user.createdAt)}</small></div><div className="admin-actions"><button className="button ghost small-button" disabled={self} onClick={() => onUserUpdate(user.id, { isAdmin: !user.isAdmin })}>{user.isAdmin ? "Ta bort admin" : "Gör till admin"}</button><button className={`button ghost small-button ${user.isDisabled ? "positive" : "danger"}`} disabled={self} onClick={() => confirm(user.isDisabled ? "Aktivera kontot igen?" : "Inaktivera kontot och logga ut användaren från alla enheter?") && onUserUpdate(user.id, { isDisabled: !user.isDisabled })}>{user.isDisabled ? "Aktivera" : "Inaktivera"}</button></div></article>; }) : <EmptyState title="Inga användare">Användarkonton visas här.</EmptyState>}</div></section>
    <section className="panel admin-panel"><div className="panel-title"><div><p className="eyebrow">Överblick</p><h2>Alla grupper</h2></div></div><div className="admin-list">{data.trips.length ? data.trips.map((trip, index) => <article className={`admin-row${trip.deletedAt ? " disabled-row" : ""}`} key={trip.id}><span className="trip-emoji">{["✦", "⌁", "◇", "◉"][index % 4]}</span><div className="admin-row-main"><strong>{trip.name} {trip.deletedAt ? <span className="role-badge danger-badge">Borttagen</span> : trip.archivedAt ? <span className="role-badge muted-badge">Arkiverad</span> : null}</strong><small>{trip.ownerName || "Okänd ägare"} · {trip.memberCount} medlemmar · {trip.expenseCount} utgifter · {formatMoney(trip.totalCents)}</small></div><div className="admin-actions">{trip.deletedAt ? <button className="button ghost small-button positive" onClick={() => confirm("Återställ gruppen från papperskorgen?") && onTripRestore(trip.id)}>Återställ</button> : <><button className="button ghost small-button" onClick={() => onOpenTrip(trip.id)}>Öppna</button><button className="button ghost small-button" onClick={() => confirm(trip.archivedAt ? "Återställ gruppen?" : "Arkivera gruppen? Alla ekonomiska poster bevaras.") && onTripArchive(trip.id, !trip.archivedAt)}>{trip.archivedAt ? "Återställ" : "Arkivera"}</button></>}</div></article>) : <EmptyState title="Inga grupper">Alla grupper visas här när de skapas.</EmptyState>}</div></section>
    <section className="panel admin-panel"><div className="panel-title"><div><p className="eyebrow">Dela direkt</p><h2>Alla snabbnotor</h2></div></div><div className="admin-list">{data.quickTabs.length ? data.quickTabs.map((tab) => <article className="admin-row" key={tab.id}><span className="trip-emoji">●</span><div className="admin-row-main"><strong>{tab.name} {tab.closedAt && <span className="role-badge muted-badge">Avslutad</span>}</strong><small>{tab.ownerName || "Okänd ägare"} · {tab.merchant || "Ingen plats angiven"} · {tab.memberCount} deltagare · {formatMoney(tab.totalCents)}</small></div><div className="admin-actions"><button className="button ghost small-button danger" onClick={() => confirm(`Ta bort snabbnotan "${tab.name}" permanent? Detta kan inte ångras.`) && onQuickTabDelete(tab.id)}>Ta bort</button></div></article>) : <EmptyState title="Inga snabbnotor">Alla snabbnotor visas här när de skapas.</EmptyState>}</div></section>
    <EmailSettingsPanel key={data.emailSettings.updatedAt || "unset"} settings={data.emailSettings} onSave={onEmailSettingsSave} onTest={onEmailSettingsTest} />
    <OcrBenchmarkPanel onRun={onOcrBenchmarkRun} onStatus={onOcrBenchmarkStatus} />
    <section className="panel admin-panel"><div className="panel-title"><div><p className="eyebrow">Felsökning</p><h2>Buggrapporter</h2></div></div><div className="admin-list">{data.bugReports.length ? data.bugReports.map((report) => <article className={`admin-row${report.resolvedAt ? " disabled-row" : ""}`} key={report.id}><span className="trip-emoji">⚠</span><div className="admin-row-main"><strong>{report.description.slice(0, 80)}{report.description.length > 80 ? "…" : ""} {report.resolvedAt && <span className="role-badge positive-badge">Löst</span>}</strong><small>{report.reporterName || "Okänd"} · {formatDate(report.createdAt)}{report.hasScreenshot ? " · Skärmbild bifogad" : ""}</small></div><div className="admin-actions"><button className="button ghost small-button" onClick={() => setOpenReportId(report.id)}>Visa</button><button className={`button ghost small-button ${report.resolvedAt ? "" : "positive"}`} onClick={() => onBugReportResolve(report.id, !report.resolvedAt)}>{report.resolvedAt ? "Markera olöst" : "Markera löst"}</button><button className="button ghost small-button danger" onClick={() => confirm("Ta bort buggrapporten permanent?") && onBugReportDelete(report.id)}>Ta bort</button></div></article>) : <EmptyState title="Inga buggrapporter">Rapporter som skickas in via "Rapportera en bugg" visas här.</EmptyState>}</div></section>
    <section className="panel admin-panel"><div className="panel-title"><div><p className="eyebrow">Spårbarhet</p><h2>Senaste aktivitet</h2></div></div><div className="admin-list">{data.activity.length ? data.activity.map((item) => <article className="activity-row" key={item.id}><span className="activity-dot" /><div><strong>{activityLabels[item.action] || item.action}</strong><small>{item.actorName || "Systemet"}{item.tripName ? ` · ${item.tripName}` : ""} · {formatDate(item.createdAt)}</small></div></article>) : <EmptyState title="Ingen aktivitet">Administrativa och ekonomiska händelser visas här.</EmptyState>}</div></section>
    <Modal open={Boolean(openReport)} onClose={() => { setOpenReportId(null); setCopyStatus(""); }}>{openReport && <><DialogHeader eyebrow={`${openReport.reporterName || "Okänd"} · ${formatDate(openReport.createdAt)}`} title="Buggrapport" onClose={() => setOpenReportId(null)} /><p>{openReport.description}</p>{openReport.hasScreenshot && <img className="receipt-view-image" src={`/api/admin/bug-reports/${openReport.id}/screenshot`} alt="Bifogad skärmbild" />}<details className="bug-report-context" open><summary>Teknisk information</summary><small>Sida: {openReport.pageUrl || "Okänd"}</small><small>Appversion: {openReport.appVersion || "Okänd"}</small><small>Webbläsare: {openReport.userAgent || "Okänd"}</small>{openReport.breadcrumbs.length > 0 && <ul className="bug-report-breadcrumbs">{openReport.breadcrumbs.map((entry, index) => <li key={index}>{entry}</li>)}</ul>}</details><div className="email-settings-actions"><button className="button dark wide" type="button" onClick={() => void copyReport(openReport)}>📋 Kopiera för utvecklare</button></div>{copyStatus && <small className="email-settings-status">{copyStatus}</small>}</>}</Modal>
  </section>;
}
