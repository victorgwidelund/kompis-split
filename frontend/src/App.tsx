import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api/client";
import { BugReportDialog } from "./components/BugReportDialog";
import { FriendInviteDialog, NewTripDialog } from "./components/GlobalDialogs";
import { Shell } from "./components/Shell";
import { Toast } from "./components/Toast";
import { AdminPage } from "./features/admin/AdminPage";
import { AuthScreen, type AuthMode } from "./features/auth/AuthScreen";
import { DashboardPage } from "./features/dashboard/DashboardPage";
import { GuidePage } from "./features/guide/GuidePage";
import { QuickTabDialog } from "./features/quick-tabs/QuickTabDialog";
import { QuickTabPage } from "./features/quick-tabs/QuickTabPage";
import { StatisticsPage } from "./features/statistics/StatisticsPage";
import { ExpenseDialog } from "./features/trips/ExpenseDialog";
import { CategoryDialog, InviteDialog, PaymentDialog, PersonDialog } from "./features/trips/TripDialogs";
import { TripPage, type PaymentPreset, type TripDialog } from "./features/trips/TripPage";
import type { AdminResponse, Category, DashboardResponse, Expense, InvitationPreview, InvitationResult, OcrBenchmarkJob, QuickTab, QuickTabSummary, ReminderResult, SessionResponse, StatisticsResponse, Trip, User, View } from "./types/models";

const guestUser: User = { id: 0, email: "", name: "Gäst", swishPhone: null, isAdmin: false };

function hashView(): View {
  const trip = location.hash.match(/^#trip-(\d+)$/); if (trip) return { page: "trip", id: Number(trip[1]) };
  const quick = location.hash.match(/^#quick-tab-(\d+)$/); if (quick) return { page: "quick-tab", id: Number(quick[1]) };
  if (location.hash === "#statistics") return { page: "statistics" };
  if (location.hash === "#admin") return { page: "admin" };
  if (location.hash === "#guide") return { page: "guide" };
  return { page: "dashboard" };
}

function inviteToken(): string {
  const match = location.hash.match(/^#invite=(.+)$/); try { return match?.[1] ? decodeURIComponent(match[1]) : ""; } catch { return ""; }
}

function resetPasswordToken(): string {
  const match = location.hash.match(/^#reset-password=(.+)$/); try { return match?.[1] ? decodeURIComponent(match[1]) : ""; } catch { return ""; }
}

export default function App() {
  const [loading, setLoading] = useState(true); const [user, setUser] = useState<User | null>(null); const [guestMode, setGuestMode] = useState(false); const [needsSetup, setNeedsSetup] = useState(false); const [version, setVersion] = useState("dev"); const [token, setToken] = useState(inviteToken); const [invitation, setInvitation] = useState<InvitationPreview | null>(null); const [authMode, setAuthMode] = useState<AuthMode>("login"); const [demoMode, setDemoMode] = useState(false); const [resetToken, setResetToken] = useState(resetPasswordToken);
  const initialToken = useRef(token);
  const initialResetToken = useRef(resetToken);
  const [view, setView] = useState<View>({ page: "dashboard" }); const [dashboard, setDashboard] = useState<DashboardResponse | null>(null); const [quickTabs, setQuickTabs] = useState<QuickTabSummary[]>([]); const [categories, setCategories] = useState<Category[]>([]); const [trip, setTrip] = useState<Trip | null>(null); const [quickTab, setQuickTab] = useState<QuickTab | null>(null); const [statistics, setStatistics] = useState<StatisticsResponse | null>(null); const [admin, setAdmin] = useState<AdminResponse | null>(null);
  const [globalDialog, setGlobalDialog] = useState<"trip" | "quick" | "friend" | "bug" | null>(null); const [tripDialog, setTripDialog] = useState<TripDialog>(null); const [editingExpense, setEditingExpense] = useState<Expense | null>(null); const [paymentPreset, setPaymentPreset] = useState<PaymentPreset | null>(null); const [categoryOpen, setCategoryOpen] = useState(false); const [quickInvitation, setQuickInvitation] = useState<InvitationResult | null>(null); const [toast, setToast] = useState("");
  const notify = useCallback((message: string) => { setToast(message); window.setTimeout(() => setToast((current) => current === message ? "" : current), 2800); }, []);
  const refreshDashboard = useCallback(async () => { const [data, quick] = await Promise.all([api<DashboardResponse>("/api/dashboard"), api<{ quickTabs: QuickTabSummary[] }>("/api/quick-tabs")]); setDashboard(data); setQuickTabs(quick.quickTabs || []); }, []);
  const refreshCategories = useCallback(async () => { const payload = await api<{ categories: Category[] }>("/api/categories"); setCategories(payload.categories || []); }, []);
  const loadTrip = useCallback(async (id: number) => { const payload = await api<{ trip: Trip }>(`/api/trips/${id}`); setTrip(payload.trip); return payload.trip; }, []);
  const loadQuickTab = useCallback(async (id: number) => { const payload = await api<{ quickTab: QuickTab }>(`/api/quick-tabs/${id}`); setQuickTab(payload.quickTab); return payload.quickTab; }, []);
  const enterAuthenticated = useCallback(async (account: User, target?: View) => { setUser(account); setGuestMode(false); await Promise.all([refreshCategories(), refreshDashboard()]); const wanted = target || hashView(); if (wanted.page === "trip") await loadTrip(wanted.id); else if (wanted.page === "quick-tab") await loadQuickTab(wanted.id); else if (wanted.page === "statistics") setStatistics(await api<StatisticsResponse>("/api/statistics")); else if (wanted.page === "admin" && account.isAdmin) setAdmin(await api<AdminResponse>("/api/admin")); setView(wanted.page === "admin" && !account.isAdmin ? { page: "dashboard" } : wanted); }, [loadQuickTab, loadTrip, refreshCategories, refreshDashboard]);
  useEffect(() => { void (async () => {
    try {
      let preview: InvitationPreview | null = null;
      if (initialToken.current) { try { preview = (await api<{ invitation: InvitationPreview }>("/api/invitations/preview", { method: "POST", body: { token: initialToken.current } })).invitation; setInvitation(preview); } catch (error) { notify(error instanceof Error ? error.message : "Inbjudan är ogiltig"); setToken(""); history.replaceState(null, "", location.pathname); } }
      const session = await api<SessionResponse>("/api/session"); setVersion(session.version || "dev"); setNeedsSetup(session.needsSetup); setDemoMode(Boolean(session.demoMode));
      if (session.authenticated && session.user) {
        let target: View | undefined;
        if (initialToken.current) {
          const joined = await api<{ tripId?: number; quickTabId?: number }>("/api/invitations/join", { method: "POST", body: { token: initialToken.current } });
          if (joined.tripId) target = { page: "trip", id: joined.tripId };
          else if (joined.quickTabId) target = { page: "quick-tab", id: joined.quickTabId };
          setToken(""); setInvitation(null);
        }
        await enterAuthenticated(session.user, target);
      }
      else {
        const wanted = hashView();
        if (!preview && wanted.page === "quick-tab") { try { await loadQuickTab(wanted.id); setGuestMode(true); setView(wanted); } catch { setAuthMode("login"); } }
        else setAuthMode(session.needsSetup ? "setup" : initialResetToken.current ? "reset" : preview?.kind === "quick_tab" ? "quick-guest" : preview ? "register" : "login");
      }
    } catch (error) { notify(error instanceof Error ? error.message : "Appen kunde inte starta"); }
    finally { setLoading(false); }
  })(); }, [enterAuthenticated, loadQuickTab, notify]);
  useEffect(() => {
    const handleUnauthorized = () => { if (user || guestMode) window.location.reload(); };
    window.addEventListener("kompis:unauthorized", handleUnauthorized);
    return () => window.removeEventListener("kompis:unauthorized", handleUnauthorized);
  }, [user, guestMode]);
  const navigate = useCallback(async (next: View) => {
    try {
      if (next.page === "trip") await loadTrip(next.id);
      if (next.page === "quick-tab") await loadQuickTab(next.id);
      if (next.page === "statistics") setStatistics(await api<StatisticsResponse>("/api/statistics"));
      if (next.page === "admin") setAdmin(await api<AdminResponse>("/api/admin"));
      setView(next); setQuickInvitation(null); const hash = next.page === "dashboard" ? "" : next.page === "trip" ? `#trip-${next.id}` : next.page === "quick-tab" ? `#quick-tab-${next.id}` : `#${next.page}`; history.replaceState(null, "", `${location.pathname}${hash}`);
    } catch (error) { notify(error instanceof Error ? error.message : "Kunde inte öppna sidan"); }
  }, [loadQuickTab, loadTrip, notify]);
  const finishAuth = async (account: User, target?: View, tokenAlreadyUsed = false) => {
    let next = target;
    if (token && !tokenAlreadyUsed && !next) { const joined = await api<{ tripId?: number; quickTabId?: number }>("/api/invitations/join", { method: "POST", body: { token } }); if (joined.tripId) next = { page: "trip", id: joined.tripId }; else if (joined.quickTabId) next = { page: "quick-tab", id: joined.quickTabId }; }
    setToken(""); setInvitation(null); history.replaceState(null, "", location.pathname); await enterAuthenticated(account, next || { page: "dashboard" });
  };
  const authenticate = async (mode: AuthMode, values: Record<string, string>) => {
    if (mode === "quick-guest") { const payload = await api<{ quickTabId: number }>("/api/quick-tabs/guest-join", { method: "POST", body: { ...values, token } }); setToken(""); setInvitation(null); setGuestMode(true); await loadQuickTab(payload.quickTabId); setView({ page: "quick-tab", id: payload.quickTabId }); history.replaceState(null, "", `${location.pathname}#quick-tab-${payload.quickTabId}`); return; }
    if (mode === "forgot") { await api("/api/auth/forgot-password", { method: "POST", body: { email: values.email } }); notify("Om adressen finns skickas ett mail med instruktioner"); setAuthMode("login"); return; }
    if (mode === "reset") { await api("/api/auth/reset-password", { method: "POST", body: { token: resetToken, password: values.password } }); setResetToken(""); history.replaceState(null, "", location.pathname); notify("Lösenordet uppdaterades. Logga in igen."); setAuthMode("login"); return; }
    const endpoint = mode === "setup" ? "/api/setup" : mode === "register" ? "/api/register" : "/api/login"; const payload = await api<{ user: User; tripId?: number; quickTabId?: number }>(endpoint, { method: "POST", body: mode === "register" ? { ...values, inviteToken: token } : values }); const target = payload.tripId ? { page: "trip", id: payload.tripId } as View : payload.quickTabId ? { page: "quick-tab", id: payload.quickTabId } as View : undefined; await finishAuth(payload.user, target, mode === "register");
  };
  const refreshTrip = useCallback(async () => { if (!trip) return; await Promise.all([loadTrip(trip.id), refreshDashboard()]); }, [loadTrip, refreshDashboard, trip]);
  const quickTabId = quickTab?.id;
  const refreshQuick = useCallback(async () => { if (!quickTabId) return; await loadQuickTab(quickTabId); }, [loadQuickTab, quickTabId]);
  const reloadAdmin = useCallback(async () => setAdmin(await api<AdminResponse>("/api/admin")), []);
  const openTripDialog = (dialog: TripDialog, expense?: Expense, payment?: PaymentPreset) => { setEditingExpense(expense || null); setPaymentPreset(payment || null); setTripDialog(dialog); };
  const enterDemo = async () => { try { await api("/api/admin/demo/enter", { method: "POST", body: {} }); history.replaceState(null, "", location.pathname); location.reload(); } catch (error) { notify(error instanceof Error ? error.message : "Kunde inte starta demoläget"); } };
  const exitDemo = async () => { try { await api("/api/admin/demo/exit", { method: "POST", body: {} }); history.replaceState(null, "", location.pathname); location.reload(); } catch (error) { notify(error instanceof Error ? error.message : "Kunde inte avsluta demoläget"); } };
  if (loading) return <div className="login-screen"><div className="login-card"><div className="brand-mark">KS</div><p className="eyebrow">Kompis Split</p><h1>Laddar…</h1></div></div>;
  if (!user && !guestMode) return <><AuthScreen mode={authMode} needsSetup={needsSetup} invitation={invitation} version={version} onModeChange={setAuthMode} onSubmit={authenticate} /><Toast message={toast} /></>;
  const shellUser = user || guestUser;
  return <>{demoMode && <div className="demo-banner" role="status"><strong>DEMOLÄGE</strong> – fiktiva uppgifter, ändringar sparas inte permanent <button type="button" className="button ghost small-button" onClick={() => void exitDemo()}>Avsluta demoläge</button></div>}
  <Shell user={shellUser} version={version} trips={dashboard?.trips || []} view={view} guestMode={guestMode} onNavigate={(next) => void navigate(next)} onNewTrip={() => setGlobalDialog("trip")} onNewQuickTab={() => setGlobalDialog("quick")} onLogout={() => void api("/api/logout", { method: "POST", body: {} }).then(() => location.reload())} onReportBug={() => setGlobalDialog("bug")}>
    {view.page === "dashboard" && user && dashboard && <DashboardPage user={user} dashboard={dashboard} quickTabs={quickTabs} categories={categories} onNavigate={(next) => void navigate(next)} onNewTrip={() => setGlobalDialog("trip")} onNewQuickTab={() => setGlobalDialog("quick")} onInviteFriend={() => setGlobalDialog("friend")} onRemindUnpaid={() => api<ReminderResult>("/api/remind-unpaid", { method: "POST", body: {} })} notify={notify} />}
    {view.page === "trip" && user && trip && <TripPage trip={trip} user={user} categories={categories} onBack={() => void navigate({ page: "dashboard" })} onRefresh={refreshTrip} onOpenDialog={openTripDialog} notify={notify} />}
    {view.page === "quick-tab" && quickTab && <QuickTabPage tab={quickTab} initialInvitation={quickInvitation} guestMode={guestMode} onBack={() => void navigate({ page: "dashboard" })} onRefresh={refreshQuick} onChanged={setQuickTab} notify={notify} />}
    {view.page === "statistics" && statistics && <StatisticsPage data={statistics} onBack={() => void navigate({ page: "dashboard" })} onRefresh={() => void api<StatisticsResponse>("/api/statistics").then(setStatistics)} />}
    {view.page === "guide" && user && <GuidePage isAdmin={user.isAdmin} onBack={() => void navigate({ page: "dashboard" })} />}
    {view.page === "admin" && admin && user && <AdminPage data={admin} currentUserId={user.id} demoMode={demoMode} onEnterDemo={() => void enterDemo()} onBack={() => void navigate({ page: "dashboard" })} onRefresh={() => void reloadAdmin()} onOpenTrip={(id) => void navigate({ page: "trip", id })} onUserUpdate={(id, update) => void api(`/api/admin/users/${id}`, { method: "PATCH", body: update }).then(reloadAdmin).then(() => notify("Kontot uppdaterades"))} onTripArchive={(id, archived) => void api(`/api/trips/${id}/archive`, { method: "POST", body: { archived } }).then(() => Promise.all([reloadAdmin(), refreshDashboard()])).then(() => notify("Gruppen uppdaterades"))} onTripRestore={(id) => void api(`/api/trips/${id}/trash`, { method: "POST", body: { deleted: false } }).then(() => Promise.all([reloadAdmin(), refreshDashboard()])).then(() => notify("Gruppen återställdes"))} onQuickTabDelete={(id) => void api(`/api/admin/quick-tabs/${id}`, { method: "DELETE" }).then(reloadAdmin).then(() => notify("Snabbnotan togs bort"))} onBugReportResolve={(id, resolved) => void api(`/api/admin/bug-reports/${id}/resolve`, { method: "POST", body: { resolved } }).then(reloadAdmin).then(() => notify(resolved ? "Markerad som löst" : "Markerad som olöst"))} onBugReportDelete={(id) => void api(`/api/admin/bug-reports/${id}`, { method: "DELETE" }).then(reloadAdmin).then(() => notify("Buggrapporten togs bort"))} onEmailSettingsSave={(values) => api("/api/admin/email-settings", { method: "POST", body: values }).then(reloadAdmin).then(() => notify("E-postinställningarna sparades")) as Promise<void>} onEmailSettingsTest={(recipientEmail) => api<{ recipient: string }>("/api/admin/email-settings/test", { method: "POST", body: { recipientEmail } }).then((result) => `Testmail skickat till ${result.recipient}`)} onOcrBenchmarkRun={(mode) => api<{ available: boolean; job: OcrBenchmarkJob }>("/api/admin/ocr-benchmark", { method: "POST", body: { mode } })} onOcrBenchmarkStatus={() => api<{ available: boolean; job: OcrBenchmarkJob | null }>("/api/admin/ocr-benchmark")} />}
  </Shell>
  <NewTripDialog open={globalDialog === "trip"} onClose={() => setGlobalDialog(null)} onCreated={async (created) => { await refreshDashboard(); setTrip(created); setView({ page: "trip", id: created.id }); history.replaceState(null, "", `${location.pathname}#trip-${created.id}`); setTripDialog("invite"); notify("Gruppen skapades — bjud nu in gänget"); }} />
  <QuickTabDialog open={globalDialog === "quick"} onClose={() => setGlobalDialog(null)} notify={notify} onCreated={async (created, createdInvitation) => { setQuickTab(created); setQuickInvitation(createdInvitation); setView({ page: "quick-tab", id: created.id }); history.replaceState(null, "", `${location.pathname}#quick-tab-${created.id}`); await refreshDashboard(); notify("Snabbnotan är live – dela länken med gänget"); }} />
  <FriendInviteDialog key={globalDialog === "friend" ? "friend-open" : "friend-closed"} open={globalDialog === "friend"} onClose={() => setGlobalDialog(null)} notify={notify} />
  <BugReportDialog open={globalDialog === "bug"} version={version} onClose={() => setGlobalDialog(null)} notify={notify} />
  {trip && user && <><InviteDialog open={tripDialog === "invite"} tripId={trip.id} onClose={() => setTripDialog(null)} notify={notify} /><PersonDialog open={tripDialog === "person"} trip={trip} onClose={() => setTripDialog(null)} onSaved={refreshTrip} notify={notify} /><ExpenseDialog open={tripDialog === "expense"} trip={trip} categories={categories} expense={editingExpense} onClose={() => setTripDialog(null)} onSaved={refreshTrip} onManageCategories={() => setCategoryOpen(true)} notify={notify} /><CategoryDialog open={categoryOpen} categories={categories} user={user} onClose={() => setCategoryOpen(false)} onChanged={setCategories} notify={notify} /><PaymentDialog key={paymentPreset ? `${paymentPreset.fromId}-${paymentPreset.toId}-${paymentPreset.amountCents}` : "none"} open={tripDialog === "payment"} trip={trip} preset={paymentPreset} onClose={() => setTripDialog(null)} onSaved={refreshTrip} /></>}
  <Toast message={toast} /></>;
}
