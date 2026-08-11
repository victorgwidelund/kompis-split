const state = { user: null, dashboard: null, trips: [], trip: null, admin: null, categories: [], tab: "overview", inviteToken: "", invitation: null, version: "dev" };
const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const money = new Intl.NumberFormat("sv-SE", { style: "currency", currency: "SEK", maximumFractionDigits: 2 });
const dateFormat = new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "short", year: "numeric" });
const colors = ["#c7e6d2", "#f6ca67", "#bfc6fb", "#ffc6b7", "#d5c2e8", "#b9dcdf"];
const categories = { food: "🍝", travel: "🚆", stay: "🏡", fun: "🎟️", other: "🧾" };
let pendingExpenseReceipt = null;
let pendingExpenseReceiptUrl = "";

function formatMoney(ore) { return money.format((Number(ore) || 0) / 100).replace("SEK", "kr"); }
function formatDate(value, fallback = "Inga datum angivna") {
  if (!value) return fallback;
  const date = String(value).includes("T") || String(value).includes(" ") ? new Date(String(value).replace(" ", "T") + (String(value).includes("Z") ? "" : "Z")) : new Date(`${value}T12:00:00`);
  return dateFormat.format(date);
}
function person(id) { return state.trip?.participants.find((item) => item.id === Number(id)); }
function initials(name) { return String(name || "?").split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase(); }
function avatar(item, index = 0) { return `<span class="avatar" style="background:${colors[index % colors.length]}">${escapeHtml(initials(item?.name))}</span>`; }
function escapeHtml(value) { const div = document.createElement("div"); div.textContent = String(value ?? ""); return div.innerHTML; }
function canManageTrip() { return ["owner", "admin"].includes(state.trip?.role); }
function canVoid(createdBy) { return canManageTrip() || Number(createdBy) === Number(state.user?.id); }
function categoryInfo(slug) { return state.categories.find((item) => item.slug === slug) || { slug, name: slug || "Övrigt", emoji: categories[slug] || categories.other }; }
function categoryIcon(slug) { return escapeHtml(categoryInfo(slug).emoji || categories.other); }
function formatBytes(bytes) { const size = Number(bytes) || 0; return size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} kB` : `${(size / 1024 / 1024).toFixed(1).replace(".", ",")} MB`; }
function emptyState(title, text) { return `<div class="empty"><strong>${title}</strong>${text}</div>`; }
function renderVersion() {
  const full = String(state.version || "dev");
  const short = full.startsWith("sha-") ? full.slice(0, 11) : full.replace(/^v/, "");
  $$(".app-version").forEach((element) => { element.textContent = element.classList.contains("mobile-version") ? short : `Version ${short}`; element.title = `Installerad appversion: ${full}`; });
}

let toastTimer;
function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 2800);
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || "Något gick fel");
    error.status = response.status;
    if (response.status === 401 && state.user) {
      state.user = null;
      showAuth(false);
    }
    throw error;
  }
  return payload;
}

function inviteTokenFromHash() {
  const match = location.hash.match(/^#invite=(.+)$/);
  try { return match ? decodeURIComponent(match[1]) : ""; } catch { return ""; }
}

async function loadInvitation() {
  if (!state.inviteToken) return null;
  try {
    const payload = await api("/api/invitations/preview", { method: "POST", body: JSON.stringify({ token: state.inviteToken }) });
    state.invitation = payload.invitation;
    return payload.invitation;
  } catch (error) {
    state.inviteToken = "";
    state.invitation = null;
    history.replaceState(null, "", location.pathname);
    toast(error.message);
    return null;
  }
}

function setAuthMode(mode) {
  $$(".auth-form").forEach((form) => form.classList.add("hidden"));
  $(`#${mode}-form`).classList.remove("hidden");
  if (mode === "register") {
    $("#auth-subtitle").textContent = state.invitation?.kind === "friend" ? "Skapa ditt konto för att lägga till vännen." : "Skapa ditt eget konto för att gå med i resan.";
  } else if (mode === "login" && state.invitation) {
    $("#auth-subtitle").textContent = state.invitation.kind === "friend" ? "Logga in så sparas ni som vänner." : "Logga in så läggs resan till på ditt konto.";
  }
}

function showAuth(needsSetup) {
  $("#app").classList.add("hidden");
  $("#login-screen").classList.remove("hidden");
  const summary = $("#invite-summary");
  summary.classList.toggle("hidden", !state.invitation);
  if (state.invitation) summary.innerHTML = state.invitation.kind === "friend"
    ? `<strong>${escapeHtml(state.invitation.inviterName)}</strong> vill lägga till dig som vän i Kompis Split.`
    : `<strong>${escapeHtml(state.invitation.inviterName)}</strong> har bjudit in dig till <strong>${escapeHtml(state.invitation.tripName)}</strong>.`;
  $("#show-register-button").classList.toggle("hidden", !state.invitation);
  if (needsSetup) {
    $("#auth-subtitle").textContent = "Skapa det första administratörskontot. Dina befintliga resor bevaras.";
    setAuthMode("setup");
  } else if (state.invitation) setAuthMode("register");
  else {
    $("#auth-subtitle").textContent = "Logga in för att se dina resor.";
    setAuthMode("login");
  }
}

async function finishAuthentication(user, knownTripId = null) {
  state.user = user;
  let tripId = knownTripId;
  if (state.inviteToken && !tripId) {
    const payload = await api("/api/invitations/join", { method: "POST", body: JSON.stringify({ token: state.inviteToken }) });
    tripId = payload.tripId;
  }
  state.inviteToken = "";
  state.invitation = null;
  await enterApp();
  if (tripId) await selectTrip(tripId);
}

async function init() {
  try {
    state.inviteToken = inviteTokenFromHash();
    if (state.inviteToken) await loadInvitation();
    const session = await api("/api/session");
    state.version = session.version || "dev";
    renderVersion();
    if (!session.authenticated) return showAuth(session.needsSetup);
    await finishAuthentication(session.user);
  } catch (error) { toast(error.message); }
}

async function enterApp() {
  $("#login-screen").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#sidebar-user-name").textContent = state.user.name;
  $("#sidebar-user-email").textContent = state.user.email;
  $$(".admin-nav").forEach((button) => button.classList.toggle("hidden", !state.user.isAdmin));
  $("#dashboard-greeting").textContent = `Hej, ${state.user.name.split(/\s+/)[0]}!`;
  await loadCategories();
  await loadDashboard();
  const hashId = Number(location.hash.match(/^#trip-(\d+)$/)?.[1]);
  if (hashId && state.trips.some((trip) => trip.id === hashId)) await selectTrip(hashId);
  else if (location.hash === "#admin" && state.user.isAdmin) await showAdmin();
  else showDashboard(false);
}

async function loadCategories() {
  const payload = await api("/api/categories");
  state.categories = payload.categories || [];
}

async function loadDashboard() {
  const payload = await api("/api/dashboard");
  state.dashboard = payload;
  state.trips = payload.trips;
  renderDashboard();
  renderTripLists();
}

function tripButton(trip, index, compact = false) {
  const balance = Number(trip.myBalanceCents || 0);
  const balanceText = balance > 0 ? `Får tillbaka ${formatMoney(balance)}` : balance < 0 ? `Skyldig ${formatMoney(-balance)}` : "Jämnt saldo";
  return `<button class="${compact ? "trip-link" : "trip-card"} ${state.trip?.id === trip.id ? "active" : ""}" data-trip-id="${trip.id}">
    <span class="trip-emoji">${["✦", "⌁", "◇", "◉"][index % 4]}</span>
    <span class="trip-card-copy"><strong>${escapeHtml(trip.name)}</strong><small>${trip.participantCount} ${trip.participantCount === 1 ? "person" : "personer"} · ${formatMoney(trip.totalCents)}</small>${compact ? "" : `<em class="${balance > 0 ? "positive" : balance < 0 ? "negative" : ""}">${balanceText}</em>`}</span>
  </button>`;
}

function renderTripLists() {
  const active = state.trips.filter((trip) => !trip.archivedAt);
  const archived = state.trips.filter((trip) => trip.archivedAt);
  $("#trip-count").textContent = active.length;
  $("#archive-count").textContent = archived.length;
  $("#trip-list").innerHTML = active.length ? active.map((trip, index) => tripButton(trip, index, true)).join("") : `<small class="side-empty">Inga aktiva resor</small>`;
  $("#archive-list").innerHTML = archived.map((trip, index) => tripButton(trip, index, true)).join("");
  $("#archive-section").classList.toggle("hidden", archived.length === 0);
}

function renderDashboard() {
  const active = state.trips.filter((trip) => !trip.archivedAt);
  const archived = state.trips.filter((trip) => trip.archivedAt);
  const net = active.reduce((sum, trip) => sum + Number(trip.myBalanceCents || 0), 0);
  const spent = active.reduce((sum, trip) => sum + Number(trip.totalCents || 0), 0);
  $("#active-trip-total").textContent = active.length;
  $("#dashboard-balance").textContent = formatMoney(Math.abs(net));
  $("#dashboard-balance-caption").textContent = net > 0 ? "Du får tillbaka totalt" : net < 0 ? "Du är skyldig totalt" : "Du ligger jämnt";
  $("#dashboard-balance").classList.toggle("negative", net < 0);
  $("#dashboard-spent").textContent = formatMoney(spent);
  $("#dashboard-trips").innerHTML = active.length ? active.map((trip, index) => tripButton(trip, index)).join("") : emptyState("Dags för nästa resa?", "Skapa en resa och bjud in gänget med en länk.");
  $("#dashboard-expenses").innerHTML = state.dashboard.recentExpenses.length ? state.dashboard.recentExpenses.map((expense) => `<button class="expense-row dashboard-expense" data-trip-id="${expense.tripId}"><span class="category-icon">${categoryIcon(expense.category)}</span><span class="expense-main"><strong>${escapeHtml(expense.title)}</strong><small>${escapeHtml(expense.tripName)} · ${escapeHtml(expense.payerName)} · ${formatDate(expense.expenseDate, "Inget datum")}</small></span><span class="expense-amount">${formatMoney(expense.amountCents)}</span></button>`).join("") : emptyState("Inga utgifter ännu", "De senaste utgifterna från dina aktiva resor visas här.");
  const friends = state.dashboard.contacts || [];
  $("#dashboard-friends").innerHTML = friends.length ? friends.map((friend, index) => `<article class="friend-card">${avatar(friend, index)}<span><strong>${escapeHtml(friend.name)}</strong><small>${escapeHtml(friend.email)}</small><small>${friend.swishPhone ? `Swish ${escapeHtml(friend.swishPhone)}` : "Inget Swish-nummer"}</small></span></article>`).join("") : emptyState("Inga sparade vänner ännu", "Vänner sparas automatiskt när ni delar en resa eller när du lägger till en registrerad användare.");
  $("#dashboard-archive-panel").classList.toggle("hidden", archived.length === 0);
  $("#dashboard-archive").innerHTML = archived.map((trip, index) => tripButton(trip, index)).join("");
}

function showDashboard(updateHash = true) {
  state.trip = null;
  $("#trip-view").classList.add("hidden");
  $("#admin-view").classList.add("hidden");
  $("#dashboard-view").classList.remove("hidden");
  if (updateHash) history.replaceState(null, "", location.pathname);
  renderTripLists();
}

const activityLabels = {
  "account.bootstrap": "Administratörskonto skapades",
  "trip.created": "Resa skapades",
  "trip.archived": "Resa arkiverades",
  "trip.restored": "Resa återställdes",
  "trip.deleted": "Resa flyttades till papperskorgen",
  "trip.undeleted": "Resa återställdes från papperskorgen",
  "participant.added": "Person lades till",
  "expense.created": "Utgift skapades",
  "expense.updated": "Utgift redigerades",
  "expense.voided": "Utgift togs bort från beräkningen",
  "receipt.created": "Kvitto laddades upp",
  "receipt.deleted": "Kvitto togs bort",
  "category.created": "Kategori skapades",
  "category.updated": "Kategori uppdaterades",
  "payment.created": "Betalning registrerades",
  "payment.voided": "Betalning togs bort från beräkningen",
  "invitation.created": "Inbjudan skapades",
  "invitation.joined": "Inbjudan användes",
  "friend_invitation.created": "Väninbjudan skapades",
  "friend_invitation.joined": "Väninbjudan användes",
  "admin.user.updated": "Användarkonto uppdaterades",
};

async function showAdmin() {
  if (!state.user?.isAdmin) return toast("Du saknar administratörsbehörighet");
  const payload = await api("/api/admin");
  state.admin = payload;
  state.trip = null;
  $("#dashboard-view").classList.add("hidden");
  $("#trip-view").classList.add("hidden");
  $("#admin-view").classList.remove("hidden");
  history.replaceState(null, "", `${location.pathname}#admin`);
  renderAdmin();
  renderTripLists();
}

function renderAdmin() {
  const data = state.admin;
  if (!data) return;
  $("#admin-user-count").textContent = data.stats.userCount;
  $("#admin-active-users").textContent = `${data.stats.activeUserCount} aktiva`;
  $("#admin-trip-count").textContent = data.stats.tripCount;
  $("#admin-active-trips").textContent = `${data.stats.activeTripCount} aktiva · ${data.stats.deletedTripCount || 0} borttagna`;
  $("#admin-total-spent").textContent = formatMoney(data.stats.totalCents);
  $("#admin-users").innerHTML = data.users.length ? data.users.map((user, index) => {
    const self = Number(user.id) === Number(state.user.id);
    return `<article class="admin-row ${user.isDisabled ? "disabled-row" : ""}">${avatar(user, index)}<div class="admin-row-main"><strong>${escapeHtml(user.name)} ${user.isAdmin ? '<span class="role-badge">Admin</span>' : ""}</strong><small>${escapeHtml(user.email)} · ${user.tripCount} resor · konto ${formatDate(user.createdAt)}</small></div><div class="admin-actions"><button class="button ghost small-button" data-admin-toggle="${user.id}" data-next-admin="${!user.isAdmin}" ${self ? "disabled" : ""}>${user.isAdmin ? "Ta bort admin" : "Gör till admin"}</button><button class="button ghost small-button ${user.isDisabled ? "positive" : "danger"}" data-user-disable="${user.id}" data-next-disabled="${!user.isDisabled}" ${self ? "disabled" : ""}>${user.isDisabled ? "Aktivera" : "Inaktivera"}</button></div></article>`;
  }).join("") : emptyState("Inga användare", "Användarkonton visas här.");
  $("#admin-trips").innerHTML = data.trips.length ? data.trips.map((trip, index) => {
    const deleted = Boolean(trip.deletedAt);
    const badge = deleted ? '<span class="role-badge danger-badge">Borttagen</span>' : trip.archivedAt ? '<span class="role-badge muted-badge">Arkiverad</span>' : "";
    const actions = deleted
      ? `<button class="button ghost small-button positive" data-admin-trash-trip="${trip.id}" data-next-deleted="false">Återställ</button>`
      : `<button class="button ghost small-button" data-admin-open-trip="${trip.id}">Öppna</button><button class="button ghost small-button" data-admin-archive-trip="${trip.id}" data-next-archived="${!trip.archivedAt}">${trip.archivedAt ? "Återställ" : "Arkivera"}</button>`;
    return `<article class="admin-row ${deleted ? "disabled-row" : ""}"><span class="trip-emoji">${["✦", "⌁", "◇", "◉"][index % 4]}</span><div class="admin-row-main"><strong>${escapeHtml(trip.name)} ${badge}</strong><small>${escapeHtml(trip.ownerName || "Okänd ägare")} · ${trip.memberCount} medlemmar · ${trip.expenseCount} utgifter · ${formatMoney(trip.totalCents)}</small></div><div class="admin-actions">${actions}</div></article>`;
  }).join("") : emptyState("Inga resor", "Alla resor visas här när de skapas.");
  $("#admin-activity").innerHTML = data.activity.length ? data.activity.map((item) => `<article class="activity-row"><span class="activity-dot"></span><div><strong>${escapeHtml(activityLabels[item.action] || item.action)}</strong><small>${escapeHtml(item.actorName || "Systemet")}${item.tripName ? ` · ${escapeHtml(item.tripName)}` : ""} · ${formatDate(item.createdAt)}</small></div></article>`).join("") : emptyState("Ingen aktivitet", "Administrativa och ekonomiska händelser visas här.");
}

async function selectTrip(id) {
  const payload = await api(`/api/trips/${id}`);
  state.trip = payload.trip;
  location.hash = `trip-${id}`;
  $("#dashboard-view").classList.add("hidden");
  $("#admin-view").classList.add("hidden");
  $("#trip-view").classList.remove("hidden");
  renderTripLists();
  renderTrip();
}

async function refreshTrip() {
  if (!state.trip) return;
  const payload = await api(`/api/trips/${state.trip.id}`);
  state.trip = payload.trip;
  await loadDashboard();
  renderTrip();
}

function renderTrip() {
  const trip = state.trip;
  if (!trip) return;
  const archived = Boolean(trip.archivedAt);
  const manager = canManageTrip();
  $("#trip-name").textContent = trip.name;
  $("#trip-date").textContent = trip.startDate ? `${formatDate(trip.startDate)}${trip.endDate ? ` — ${formatDate(trip.endDate)}` : ""}` : "RESA PÅGÅR";
  $("#trip-archive-note").classList.toggle("hidden", !archived);
  $("#archive-button").classList.toggle("hidden", !manager);
  $("#archive-button").textContent = archived ? "Återställ resa" : "Arkivera";
  $("#delete-trip-button").classList.toggle("hidden", !manager || !archived);
  $("#invite-button").classList.toggle("hidden", !manager || archived);
  $("#add-person-button").classList.toggle("hidden", !manager || archived);
  $("#summary-add-person").classList.toggle("hidden", !manager || archived);
  $("#people-add-button").classList.toggle("hidden", !manager || archived);
  $("#add-expense-button").classList.toggle("hidden", archived);
  $("#expenses-add-button").classList.toggle("hidden", archived);
  $("#total-spent").textContent = formatMoney(trip.totalCents);
  $("#expense-count").textContent = trip.expenses.length === 1 ? "1 utgift registrerad" : `${trip.expenses.length} utgifter registrerade`;
  const openAmount = trip.settlements.reduce((sum, item) => sum + item.amountCents, 0);
  $("#to-settle").textContent = formatMoney(openAmount);
  $("#settle-caption").textContent = trip.settlements.length ? `${trip.settlements.length} ${trip.settlements.length === 1 ? "betalning" : "betalningar"} kvar` : "Alla ligger jämnt";
  $("#settlement-count").textContent = trip.settlements.length;
  $("#people-count").textContent = `${trip.participants.length} ${trip.participants.length === 1 ? "person" : "personer"}`;
  $("#avatar-stack").innerHTML = trip.participants.slice(0, 5).map(avatar).join("");
  renderExpenses(); renderBalances(); renderSettlements(); renderPeople(); setTab(state.tab);
}

function expenseRow(expense, allowAction = true) {
  const payer = person(expense.payerId);
  const canEdit = allowAction && canVoid(expense.createdBy) && !state.trip.archivedAt;
  const canUpload = allowAction && !state.trip.archivedAt;
  const receipts = (expense.receipts || []).map((receipt) => `<span class="receipt-chip"><a href="/api/receipts/${receipt.id}" target="_blank" rel="noopener" title="Öppna ${escapeHtml(receipt.fileName)}">${receipt.mimeType === "application/pdf" ? "PDF" : "Kvitto"} · ${escapeHtml(receipt.fileName)} <small>${formatBytes(receipt.byteSize)}</small></a>${allowAction && canVoid(receipt.createdBy) && !state.trip.archivedAt ? `<button type="button" data-delete-receipt="${receipt.id}" aria-label="Ta bort ${escapeHtml(receipt.fileName)}">×</button>` : ""}</span>`).join("");
  return `<article class="expense-entry"><div class="expense-row"><span class="category-icon" title="${escapeHtml(categoryInfo(expense.category).name)}">${categoryIcon(expense.category)}</span><div class="expense-main"><strong>${escapeHtml(expense.title)}</strong><small>${escapeHtml(payer?.name || "Okänd")} betalade · ${formatDate(expense.expenseDate, "Inget datum")} · delat mellan ${expense.shares.length}</small></div><div class="expense-amount">${formatMoney(expense.amountCents)}</div>${canEdit ? `<div class="expense-actions"><button class="edit-button" data-edit-expense="${expense.id}" aria-label="Redigera ${escapeHtml(expense.title)}" title="Redigera utgiften">Redigera</button><button class="delete-button" data-delete-expense="${expense.id}" aria-label="Ta bort ${escapeHtml(expense.title)} från beräkningen" title="Ta bort från beräkningen">×</button></div>` : ""}</div><div class="receipt-list">${receipts}${canUpload && (expense.receipts || []).length < 5 ? `<button class="receipt-upload" type="button" data-add-receipt="${expense.id}">＋ Lägg till kvitto</button>` : ""}</div></article>`;
}

function renderExpenses() {
  const expenses = state.trip.expenses;
  $("#recent-expenses").innerHTML = expenses.length ? expenses.slice(0, 4).map((expense) => expenseRow(expense, false)).join("") : emptyState("Inget spenderat ännu", "Lägg till den första utgiften när någon tar notan.");
  $("#all-expenses").innerHTML = expenses.length ? expenses.map((expense) => expenseRow(expense)).join("") : emptyState("Inga kvitton, inga problem", "Utgifterna visas här när ni lägger till dem.");
}

function renderBalances() {
  $("#balance-list").innerHTML = state.trip.participants.length ? state.trip.participants.map((item, index) => {
    const balance = Number(state.trip.balances[item.id] || 0);
    const caption = balance > 0 ? "får tillbaka" : balance < 0 ? "är skyldig" : "ligger jämnt";
    return `<div class="balance-row">${avatar(item, index)}<div class="balance-name"><strong>${escapeHtml(item.name)}</strong><small>${caption}</small></div><strong class="${balance > 0 ? "positive" : balance < 0 ? "negative" : ""}">${balance === 0 ? "—" : formatMoney(Math.abs(balance))}</strong></div>`;
  }).join("") : emptyState("Lägg till gänget", "Saldon visas när fler personer är med.");
}

function swishUrl(settlement) {
  const recipient = person(settlement.toId);
  const phone = recipient?.swishPhone?.replace(/\D/g, "") || "";
  if (!phone) return "";
  const data = { version: 1, payee: { value: phone, editable: false }, amount: { value: settlement.amountCents / 100, editable: false }, message: { value: state.trip.name.slice(0, 50), editable: true } };
  return `swish://payment?data=${encodeURIComponent(JSON.stringify(data))}`;
}

function renderSettlements() {
  const settlements = state.trip.settlements;
  $("#settlement-list").innerHTML = settlements.length ? settlements.map((item) => {
    const from = person(item.fromId); const to = person(item.toId); const link = swishUrl(item);
    return `<article class="settlement-card"><div class="settlement-route"><div>${avatar(from, item.fromId)}<strong>${escapeHtml(from.name)}</strong></div><span class="route-arrow">→</span><div>${avatar(to, item.toId)}<strong>${escapeHtml(to.name)}</strong></div></div><div class="settlement-amount"><small>ska betala</small><strong>${formatMoney(item.amountCents)}</strong></div><div class="settlement-actions"><button class="button ${link ? "primary" : "ghost"}" data-swish-from="${item.fromId}" data-swish-to="${item.toId}" data-swish-amount="${item.amountCents}" ${link ? `data-swish-url="${escapeHtml(link)}"` : ""}>${link ? "Öppna Swish" : "Kopiera detaljer"}</button><button class="button ghost" data-record-from="${item.fromId}" data-record-to="${item.toId}" data-record-amount="${item.amountCents}" ${state.trip.archivedAt ? "disabled" : ""}>Markera betald</button></div></article>`;
  }).join("") : `<div class="panel" style="grid-column:1/-1">${emptyState("Allt är uppgjort ✦", "Ingen är skyldig någon något just nu.")}</div>`;
  $("#payment-list").innerHTML = state.trip.payments.length ? state.trip.payments.map((payment) => `<article class="expense-row"><span class="category-icon">✓</span><div class="expense-main"><strong>${escapeHtml(person(payment.fromId)?.name)} betalade ${escapeHtml(person(payment.toId)?.name)}</strong><small>${escapeHtml(payment.note || "Betalning")} · ${formatDate(payment.paidAt)}</small></div><div class="expense-amount positive">${formatMoney(payment.amountCents)}</div>${canVoid(payment.createdBy) && !state.trip.archivedAt ? `<button class="delete-button" data-delete-payment="${payment.id}" aria-label="Ta bort betalning från beräkningen" title="Ta bort från beräkningen">×</button>` : ""}</article>`).join("") : emptyState("Inga betalningar registrerade", "Färdiga betalningar visas här.");
}

function renderPeople() {
  $("#people-list").innerHTML = state.trip.participants.length ? state.trip.participants.map((item, index) => `<article class="person-card">${avatar(item, index)}<strong>${escapeHtml(item.name)}</strong><small>${item.userId ? "Registrerad användare" : "Gäst"}</small><small>${item.swishPhone ? `Swish ${escapeHtml(item.swishPhone)}` : "Inget Swish-nummer"}</small></article>`).join("") : emptyState("Vilka ska med?", "Lägg till vänner för att börja dela utgifter.");
}

function setTab(tab) {
  state.tab = tab;
  $$(".tab").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  $$(".tab-panel").forEach((panel) => panel.classList.add("hidden"));
  $(`#tab-${tab}`).classList.remove("hidden");
}

function openDialog(id) {
  const dialog = $(`#${id}`);
  const error = $(".form-error", dialog);
  if (error) error.textContent = "";
  dialog.showModal();
}

function renderContactResults(users, heading = "") {
  const alreadyAdded = new Set(state.trip.participants.map((participant) => Number(participant.userId)).filter(Boolean));
  const available = users.filter((user) => !alreadyAdded.has(Number(user.id)));
  $("#contact-results").innerHTML = `${heading ? `<p class="result-heading">${escapeHtml(heading)}</p>` : ""}${available.length ? available.map((user, index) => `<button class="contact-result" type="button" data-add-user="${user.id}">${avatar(user, index)}<span><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(user.email)}${user.isContact ? " · sparad kontakt" : ""}</small></span><b>＋</b></button>`).join("") : `<small class="muted">Ingen tillgänglig användare hittades.</small>`}`;
}

async function openPersonDialog() {
  if (!state.trip) return toast("Skapa en resa först");
  if (!canManageTrip()) return toast("Bara ägare och administratörer kan lägga till personer");
  $("#person-form").reset(); $("#person-search").value = "";
  openDialog("person-dialog");
  try { const payload = await api("/api/contacts"); renderContactResults(payload.contacts, "Sparade kontakter"); }
  catch (error) { toast(error.message); }
}

function renderCategorySelect(selectedSlug = "other") {
  const active = state.categories.filter((category) => !category.archivedAt);
  const selected = state.categories.find((category) => category.slug === selectedSlug);
  const choices = selected?.archivedAt ? [...active, selected] : active;
  const select = $("#expense-form").elements.category;
  select.innerHTML = choices.map((category) => `<option value="${escapeHtml(category.slug)}" ${category.slug === selectedSlug ? "selected" : ""}>${escapeHtml(category.emoji)} ${escapeHtml(category.name)}${category.archivedAt ? " (arkiverad)" : ""}</option>`).join("");
}

function renderCategoryDialog() {
  $("#category-list").innerHTML = state.categories.map((category) => {
    const canChange = !category.isBuiltin && (state.user.isAdmin || Number(category.createdBy) === Number(state.user.id));
    return `<article class="category-row ${category.archivedAt ? "category-archived" : ""}"><span class="category-icon">${escapeHtml(category.emoji)}</span><span><strong>${escapeHtml(category.name)}</strong><small>${category.isBuiltin ? "Standardkategori" : category.archivedAt ? "Arkiverad" : "Egen kategori"}</small></span>${canChange ? `<button class="button ghost small-button" type="button" data-category-archive="${category.id}" data-next-archived="${!category.archivedAt}">${category.archivedAt ? "Återställ" : "Arkivera"}</button>` : ""}</article>`;
  }).join("");
}

function openCategoryDialog() {
  $("#category-form").reset();
  $("#category-form").elements.emoji.value = "🧾";
  renderCategoryDialog();
  openDialog("category-dialog");
}

function resetExpenseReceipt() {
  pendingExpenseReceipt = null;
  if (pendingExpenseReceiptUrl) URL.revokeObjectURL(pendingExpenseReceiptUrl);
  pendingExpenseReceiptUrl = "";
  const input = $("#expense-receipt-input");
  if (input) input.value = "";
  $("#expense-receipt-preview")?.classList.add("hidden");
  $("#expense-receipt-image")?.removeAttribute("src");
  const status = $("#expense-receipt-status");
  if (status) { status.className = "receipt-status"; status.textContent = "Du granskar alltid förslagen innan utgiften sparas."; }
}

function openExpenseDialog(expense = null) {
  if (!state.trip?.participants.length) { toast("Lägg till minst en person först"); return openPersonDialog(); }
  const form = $("#expense-form"); form.reset();
  resetExpenseReceipt();
  $("#expense-receipt-capture").classList.toggle("hidden", Boolean(expense));
  form.dataset.expenseId = expense?.id || "";
  form.elements.payerId.innerHTML = state.trip.participants.map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join("");
  renderCategorySelect(expense?.category || "other");
  $("#expense-dialog-eyebrow").textContent = expense ? "Uppdatera notan" : "Lägg till på notan";
  $("#expense-dialog-title").textContent = expense ? "Redigera utgift" : "Ny utgift";
  $("#expense-submit-label").textContent = expense ? "Spara ändringar" : "Lägg till utgift";
  if (expense) {
    form.elements.title.value = expense.title;
    form.elements.amount.value = (Number(expense.amountCents) / 100).toFixed(2);
    form.elements.payerId.value = String(expense.payerId);
    form.elements.expenseDate.value = expense.expenseDate || "";
    form.elements.category.value = expense.category;
    form.elements.splitMode.value = expense.splitMode === "equal" ? "equal" : "exact";
  }
  renderSplitPeople(expense?.shares || null); openDialog("expense-dialog");
}

function renderSplitPeople(presetShares = null) {
  const form = $("#expense-form"); const mode = form.elements.splitMode.value; const count = state.trip.participants.length; const amountOre = Math.round(Number(form.elements.amount.value || 0) * 100);
  const preset = new Map((presetShares || []).map((share) => [Number(share.participantId), Number(share.amountCents)]));
  function defaultValue(index) {
    if (mode === "shares") return "1";
    if (mode === "percentage") { const base = Math.floor(10000 / count) / 100; return (index === count - 1 ? 100 - base * (count - 1) : base).toFixed(2); }
    if (mode === "exact" && amountOre > 0) { const base = Math.floor(amountOre / count); const ore = index === 0 ? base + (amountOre - base * count) : base; return (ore / 100).toFixed(2); }
    return "";
  }
  $("#split-people").innerHTML = state.trip.participants.map((item, index) => {
    const selected = !presetShares || preset.has(Number(item.id));
    const value = presetShares && mode === "exact" && selected ? (preset.get(Number(item.id)) / 100).toFixed(2) : defaultValue(index);
    return `<label class="split-person ${selected ? "selected" : ""}"><input type="checkbox" name="splitPerson" value="${item.id}" ${selected ? "checked" : ""} />${avatar(item, index)}<span>${escapeHtml(item.name)}</span>${mode === "equal" ? "<span></span>" : `<input class="value-input" name="splitValue-${item.id}" type="number" min="0" step="${mode === "shares" ? "0.1" : "0.01"}" value="${value}" aria-label="${mode} för ${escapeHtml(item.name)}" />`}</label>`;
  }).join("");
  updateSplitSummary();
}

function updateSplitSummary() {
  const form = $("#expense-form"); const selected = $$("input[name='splitPerson']:checked", form); const amount = Number(form.elements.amount.value || 0); const mode = form.elements.splitMode.value;
  let text = `${selected.length} ${selected.length === 1 ? "person" : "personer"} valda`;
  if (mode === "equal" && selected.length && amount) text += ` · cirka ${money.format(amount / selected.length).replace("SEK", "kr")} var`;
  if (mode === "percentage") { const total = selected.reduce((sum, checkbox) => sum + Number(form.elements[`splitValue-${checkbox.value}`]?.value || 0), 0); text += ` · ${total.toFixed(2).replace(/\.00$/, "")}% fördelat`; }
  if (mode === "exact") { const total = selected.reduce((sum, checkbox) => sum + Number(form.elements[`splitValue-${checkbox.value}`]?.value || 0), 0); text += ` · ${money.format(total).replace("SEK", "kr")} fördelat`; }
  $("#split-summary").textContent = text;
}

function showFormError(form, error) { $(".form-error", form).textContent = error.message; }

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; }
    catch { /* HTTP och vissa mobilwebbläsare nekar Clipboard API; använd reservmetoden. */ }
  }
  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.inset = "0 auto auto 0";
  input.style.opacity = "0";
  document.body.append(input);
  input.focus();
  input.select();
  input.setSelectionRange(0, input.value.length);
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("Webbläsaren blockerade kopieringen");
}

$("#setup-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget;
  try { const payload = await api("/api/setup", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) }); form.reset(); await finishAuthentication(payload.user); }
  catch (error) { showFormError(form, error); }
});

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget;
  try { const payload = await api("/api/login", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) }); form.reset(); await finishAuthentication(payload.user); }
  catch (error) { showFormError(form, error); }
});

$("#register-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget; const data = Object.fromEntries(new FormData(form)); data.inviteToken = state.inviteToken;
  try { const payload = await api("/api/register", { method: "POST", body: JSON.stringify(data) }); form.reset(); state.inviteToken = ""; state.invitation = null; await finishAuthentication(payload.user, payload.tripId); }
  catch (error) { showFormError(form, error); }
});

$("#show-login-button").addEventListener("click", () => setAuthMode("login"));
$("#show-register-button").addEventListener("click", () => setAuthMode("register"));
$("#logout-button").addEventListener("click", async () => { await api("/api/logout", { method: "POST", body: "{}" }); location.reload(); });

let searchTimer;
$("#person-search").addEventListener("input", (event) => {
  clearTimeout(searchTimer); const query = event.target.value.trim();
  searchTimer = setTimeout(async () => {
    if (query.length < 2) { const payload = await api("/api/contacts"); return renderContactResults(payload.contacts, "Sparade kontakter"); }
    try { const payload = await api(`/api/users/search?q=${encodeURIComponent(query)}`); renderContactResults(payload.users, "Sökresultat"); }
    catch (error) { toast(error.message); }
  }, 250);
});

document.addEventListener("click", async (event) => {
  const adminToggle = event.target.closest("[data-admin-toggle]");
  if (adminToggle) { try { await api(`/api/admin/users/${adminToggle.dataset.adminToggle}`, { method: "PATCH", body: JSON.stringify({ isAdmin: adminToggle.dataset.nextAdmin === "true" }) }); await showAdmin(); toast("Adminbehörigheten uppdaterades"); } catch (error) { toast(error.message); } return; }
  const userDisable = event.target.closest("[data-user-disable]");
  if (userDisable && confirm(userDisable.dataset.nextDisabled === "true" ? "Inaktivera kontot och logga ut användaren från alla enheter?" : "Aktivera kontot igen?")) { try { await api(`/api/admin/users/${userDisable.dataset.userDisable}`, { method: "PATCH", body: JSON.stringify({ isDisabled: userDisable.dataset.nextDisabled === "true" }) }); await showAdmin(); toast("Kontostatusen uppdaterades"); } catch (error) { toast(error.message); } return; }
  const adminOpenTrip = event.target.closest("[data-admin-open-trip]"); if (adminOpenTrip) return selectTrip(Number(adminOpenTrip.dataset.adminOpenTrip));
  const adminArchiveTrip = event.target.closest("[data-admin-archive-trip]");
  if (adminArchiveTrip && confirm(adminArchiveTrip.dataset.nextArchived === "true" ? "Arkivera resan? Alla ekonomiska poster bevaras." : "Återställ resan?")) { try { await api(`/api/trips/${adminArchiveTrip.dataset.adminArchiveTrip}/archive`, { method: "POST", body: JSON.stringify({ archived: adminArchiveTrip.dataset.nextArchived === "true" }) }); await loadDashboard(); await showAdmin(); toast("Resan uppdaterades"); } catch (error) { toast(error.message); } return; }
  const adminTrashTrip = event.target.closest("[data-admin-trash-trip]");
  if (adminTrashTrip && confirm("Återställ resan från papperskorgen?")) { try { await api(`/api/trips/${adminTrashTrip.dataset.adminTrashTrip}/trash`, { method: "POST", body: JSON.stringify({ deleted: false }) }); await loadDashboard(); await showAdmin(); toast("Resan återställdes"); } catch (error) { toast(error.message); } return; }
  const tripLink = event.target.closest("[data-trip-id]"); if (tripLink) return selectTrip(Number(tripLink.dataset.tripId));
  const tab = event.target.closest("[data-tab]"); if (tab) return setTab(tab.dataset.tab);
  const goTab = event.target.closest("[data-go-tab]"); if (goTab) return setTab(goTab.dataset.goTab);
  const close = event.target.closest(".dialog-close"); if (close) return close.closest("dialog").close();
  const addUserButton = event.target.closest("[data-add-user]");
  if (addUserButton) {
    try { await api(`/api/trips/${state.trip.id}/participants`, { method: "POST", body: JSON.stringify({ userId: Number(addUserButton.dataset.addUser) }) }); $("#person-dialog").close(); await refreshTrip(); toast("Vännen lades till och sparades som kontakt"); }
    catch (error) { toast(error.message); }
    return;
  }
  const categoryArchive = event.target.closest("[data-category-archive]");
  if (categoryArchive) {
    const archived = categoryArchive.dataset.nextArchived === "true";
    try {
      const selected = $("#expense-form").elements.category.value;
      const payload = await api(`/api/categories/${categoryArchive.dataset.categoryArchive}`, { method: "PATCH", body: JSON.stringify({ archived }) });
      state.categories = payload.categories;
      renderCategoryDialog();
      renderCategorySelect(selected);
      toast(archived ? "Kategorin arkiverades" : "Kategorin återställdes");
    } catch (error) { toast(error.message); }
    return;
  }
  const addReceipt = event.target.closest("[data-add-receipt]");
  if (addReceipt) {
    const input = $("#receipt-file-input");
    input.dataset.expenseId = addReceipt.dataset.addReceipt;
    input.value = "";
    input.click();
    return;
  }
  const deleteReceipt = event.target.closest("[data-delete-receipt]");
  if (deleteReceipt && confirm("Ta bort kvittot permanent? Själva utgiften påverkas inte.")) {
    try { await api(`/api/receipts/${deleteReceipt.dataset.deleteReceipt}`, { method: "DELETE", body: "{}" }); await refreshTrip(); toast("Kvittot togs bort"); }
    catch (error) { toast(error.message); }
    return;
  }
  const deleteExpense = event.target.closest("[data-delete-expense]");
  if (deleteExpense && confirm("Ta bort utgiften från beräkningen? Originalposten sparas i historiken.")) { try { await api(`/api/expenses/${deleteExpense.dataset.deleteExpense}`, { method: "DELETE", body: "{}" }); await refreshTrip(); toast("Utgiften togs bort från beräkningen"); } catch (error) { toast(error.message); } return; }
  const editExpense = event.target.closest("[data-edit-expense]");
  if (editExpense) {
    const expense = state.trip.expenses.find((item) => Number(item.id) === Number(editExpense.dataset.editExpense));
    if (expense) openExpenseDialog(expense);
    return;
  }
  const deletePayment = event.target.closest("[data-delete-payment]");
  if (deletePayment && confirm("Ta bort betalningen från beräkningen? Originalposten sparas i historiken.")) { try { await api(`/api/payments/${deletePayment.dataset.deletePayment}`, { method: "DELETE", body: "{}" }); await refreshTrip(); toast("Betalningen togs bort från beräkningen"); } catch (error) { toast(error.message); } return; }
  const swish = event.target.closest("[data-swish-from]");
  if (swish) {
    const from = person(swish.dataset.swishFrom); const to = person(swish.dataset.swishTo); const details = `${from.name} betalar ${to.name} ${formatMoney(swish.dataset.swishAmount)} — ${state.trip.name}`;
    if (swish.dataset.swishUrl) { location.href = swish.dataset.swishUrl; setTimeout(() => copyText(details).catch(() => {}), 700); }
    else { await copyText(details); toast(`Betalningsdetaljer kopierade. Lägg till Swish-numret för ${to.name} för direktlänk.`); }
    return;
  }
  const record = event.target.closest("[data-record-from]");
  if (record) { const form = $("#payment-form"); form.reset(); form.elements.fromId.value = record.dataset.recordFrom; form.elements.toId.value = record.dataset.recordTo; form.elements.amount.value = (Number(record.dataset.recordAmount) / 100).toFixed(2); $("#payment-route").textContent = `${person(record.dataset.recordFrom).name} → ${person(record.dataset.recordTo).name}`; openDialog("payment-dialog"); }
});

[$("#home-button"), $("#mobile-home-button"), $("#back-to-trips")].forEach((button) => button.addEventListener("click", () => showDashboard()));
[$("#admin-button"), $("#mobile-admin-button")].forEach((button) => button.addEventListener("click", () => showAdmin().catch((error) => toast(error.message))));
$("#admin-back-button").addEventListener("click", () => showDashboard());
$("#admin-refresh-button").addEventListener("click", () => showAdmin().catch((error) => toast(error.message)));
$("#active-trips-card").addEventListener("click", () => {
  const panel = $("#dashboard-trips-panel");
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
  panel.focus({ preventScroll: true });
  panel.classList.remove("panel-highlight");
  requestAnimationFrame(() => panel.classList.add("panel-highlight"));
});
[$("#new-trip-button"), $("#mobile-new-trip"), $("#dashboard-new-trip")].forEach((button) => button.addEventListener("click", () => { $("#trip-form").reset(); openDialog("trip-dialog"); }));
[$("#add-person-button"), $("#summary-add-person"), $("#people-add-button")].forEach((button) => button.addEventListener("click", openPersonDialog));
[$("#add-expense-button"), $("#expenses-add-button")].forEach((button) => button.addEventListener("click", () => openExpenseDialog()));
$("#manage-categories-button").addEventListener("click", openCategoryDialog);

$("#expense-receipt-input").addEventListener("change", async (event) => {
  const input = event.currentTarget;
  const file = input.files?.[0];
  if (!file) return;
  const status = $("#expense-receipt-status");
  if (file.size > 8 * 1024 * 1024) { resetExpenseReceipt(); status.className = "receipt-status warning"; status.textContent = "Kvittofilen får vara högst 8 MB."; return; }
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) { resetExpenseReceipt(); status.className = "receipt-status warning"; status.textContent = "Välj en bild i JPG-, PNG- eller WebP-format."; return; }
  resetExpenseReceipt();
  pendingExpenseReceipt = file;
  pendingExpenseReceiptUrl = URL.createObjectURL(file);
  $("#expense-receipt-image").src = pendingExpenseReceiptUrl;
  $("#expense-receipt-preview").classList.remove("hidden");
  status.className = "receipt-status reading";
  status.textContent = "Läser kvittot på din server… Det kan ta några sekunder.";
  try {
    const payload = await api(`/api/trips/${state.trip.id}/receipts/analyze`, { method: "POST", headers: { "Content-Type": file.type }, body: file });
    if (pendingExpenseReceipt !== file) return;
    const suggestion = payload.suggestion || {};
    const form = $("#expense-form");
    if (suggestion.title) form.elements.title.value = suggestion.title;
    if (suggestion.amount) form.elements.amount.value = suggestion.amount;
    if (suggestion.expenseDate) form.elements.expenseDate.value = suggestion.expenseDate;
    if (suggestion.category && [...form.elements.category.options].some((option) => option.value === suggestion.category)) form.elements.category.value = suggestion.category;
    updateSplitSummary();
    const found = [suggestion.title, suggestion.amount, suggestion.expenseDate].filter(Boolean).length;
    status.className = `receipt-status ${found ? "success" : "warning"}`;
    status.textContent = found ? `Förslag ifyllda (${payload.confidence || 0}% läskvalitet). Kontrollera namn, belopp och datum innan du sparar.` : "Kvittot bifogas, men texten kunde inte läsas tydligt. Fyll i uppgifterna manuellt.";
  } catch (error) {
    if (pendingExpenseReceipt !== file) return;
    status.className = "receipt-status warning";
    status.textContent = `${error.message} Kvittot kan fortfarande bifogas om du fyller i uppgifterna manuellt.`;
  }
});
$("#clear-expense-receipt").addEventListener("click", resetExpenseReceipt);
$("#expense-dialog").addEventListener("close", resetExpenseReceipt);

$("#receipt-file-input").addEventListener("change", async (event) => {
  const input = event.currentTarget;
  const file = input.files?.[0];
  const expenseId = input.dataset.expenseId;
  if (!file || !expenseId) return;
  if (file.size > 8 * 1024 * 1024) return toast("Kvittofilen får vara högst 8 MB");
  if (!["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(file.type)) return toast("Välj en JPG-, PNG-, WebP- eller PDF-fil");
  try {
    await api(`/api/expenses/${expenseId}/receipts`, { method: "POST", headers: { "Content-Type": file.type, "X-File-Name": encodeURIComponent(file.name) }, body: file });
    await refreshTrip();
    toast("Kvittot laddades upp");
  } catch (error) { toast(error.message); }
  finally { input.value = ""; }
});

$("#archive-button").addEventListener("click", async () => {
  const restoring = Boolean(state.trip.archivedAt);
  if (!confirm(restoring ? "Återställ resan och tillåt nya ändringar?" : "Arkivera resan? Alla utgifter och saldon bevaras.")) return;
  try { await api(`/api/trips/${state.trip.id}/archive`, { method: "POST", body: JSON.stringify({ archived: !restoring }) }); await loadDashboard(); if (restoring) await selectTrip(state.trip.id); else showDashboard(); toast(restoring ? "Resan återställdes" : "Resan arkiverades"); }
  catch (error) { toast(error.message); }
});

$("#delete-trip-button").addEventListener("click", async () => {
  if (!state.trip?.archivedAt) return toast("Arkivera resan först");
  if (!confirm("Ta bort resan från alla vanliga vyer? Utgifter och betalningar sparas, men uppladdade kvitton raderas permanent och kan inte återställas.")) return;
  try { await api(`/api/trips/${state.trip.id}/trash`, { method: "POST", body: JSON.stringify({ deleted: true }) }); await loadDashboard(); showDashboard(); toast("Resan flyttades till papperskorgen"); }
  catch (error) { toast(error.message); }
});

$("#invite-button").addEventListener("click", () => { $("#invite-output").classList.add("hidden"); $("#invite-qr").removeAttribute("src"); openDialog("invite-dialog"); });
$("#create-invite-button").addEventListener("click", async () => {
  try { const payload = await api(`/api/trips/${state.trip.id}/invitations`, { method: "POST", body: "{}" }); const link = new URL(payload.invitation.path, location.origin).href; $("#invite-link").value = link; $("#invite-qr").src = payload.invitation.qrDataUrl; $("#invite-expiry").textContent = `Gäller till ${formatDate(payload.invitation.expiresAt)}.`; $("#invite-output").classList.remove("hidden"); }
  catch (error) { toast(error.message); }
});
$("#copy-invite-button").addEventListener("click", async () => {
  const input = $("#invite-link");
  try { await copyText(input.value); toast("Inbjudningslänken kopierades"); }
  catch {
    input.focus(); input.select(); input.setSelectionRange(0, input.value.length);
    toast("Länken är markerad — välj Kopiera i webbläsaren");
  }
});

$("#dashboard-invite-friend").addEventListener("click", () => {
  $("#friend-invite-output").classList.add("hidden");
  $("#friend-invite-qr").removeAttribute("src");
  openDialog("friend-invite-dialog");
});
$("#create-friend-invite-button").addEventListener("click", async () => {
  try {
    const payload = await api("/api/friend-invitations", { method: "POST", body: "{}" });
    const link = new URL(payload.invitation.path, location.origin).href;
    $("#friend-invite-link").value = link;
    $("#friend-invite-qr").src = payload.invitation.qrDataUrl;
    $("#friend-invite-expiry").textContent = `Gäller till ${formatDate(payload.invitation.expiresAt)} och kan användas en gång.`;
    $("#friend-invite-output").classList.remove("hidden");
  } catch (error) { toast(error.message); }
});
$("#copy-friend-invite-button").addEventListener("click", async () => {
  const input = $("#friend-invite-link");
  try { await copyText(input.value); toast("Väninbjudan kopierades"); }
  catch { input.focus(); input.select(); input.setSelectionRange(0, input.value.length); toast("Länken är markerad — välj Kopiera i webbläsaren"); }
});

$("#trip-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget;
  try { const payload = await api("/api/trips", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) }); form.closest("dialog").close(); await loadDashboard(); await selectTrip(payload.trip.id); toast("Resan skapades — bjud nu in gänget"); openDialog("invite-dialog"); }
  catch (error) { showFormError(form, error); }
});

$("#person-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget;
  try { await api(`/api/trips/${state.trip.id}/participants`, { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) }); form.closest("dialog").close(); await refreshTrip(); toast("Gästen lades till"); }
  catch (error) { showFormError(form, error); }
});

$("#category-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget;
  try {
    const payload = await api("/api/categories", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    state.categories = payload.categories;
    form.reset(); form.elements.emoji.value = "🧾";
    renderCategoryDialog();
    renderCategorySelect(payload.createdSlug || $("#expense-form").elements.category.value);
    toast("Kategorin skapades");
  } catch (error) { showFormError(form, error); }
});

$("#expense-form").addEventListener("change", (event) => {
  if (event.target.name === "splitMode") renderSplitPeople();
  else {
    if (event.target.name === "splitPerson") event.target.closest(".split-person")?.classList.toggle("selected", event.target.checked);
    updateSplitSummary();
  }
});
$("#expense-form").addEventListener("input", updateSplitSummary);
$("#expense-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget; const data = Object.fromEntries(new FormData(form)); const selected = $$("input[name='splitPerson']:checked", form);
  data.entries = selected.map((checkbox) => ({ participantId: Number(checkbox.value), value: data[`splitValue-${checkbox.value}`] ?? 1 }));
  Object.keys(data).filter((key) => key.startsWith("splitValue-") || key === "splitPerson").forEach((key) => delete data[key]);
  const expenseId = form.dataset.expenseId;
  const path = expenseId ? `/api/expenses/${expenseId}` : `/api/trips/${state.trip.id}/expenses`;
  try {
    const receipt = pendingExpenseReceipt;
    const payload = await api(path, { method: expenseId ? "PATCH" : "POST", body: JSON.stringify(data) });
    let receiptError = null;
    if (!expenseId && receipt && payload.expenseId) {
      try { await api(`/api/expenses/${payload.expenseId}/receipts`, { method: "POST", headers: { "Content-Type": receipt.type, "X-File-Name": encodeURIComponent(receipt.name || "kvitto.jpg") }, body: receipt }); }
      catch (error) { receiptError = error; }
    }
    form.closest("dialog").close();
    await refreshTrip();
    toast(receiptError ? "Utgiften sparades, men kvittot kunde inte bifogas. Lägg till det under utgiften." : expenseId ? "Utgiften uppdaterades" : receipt ? "Utgiften och kvittot sparades" : "Utgiften delades exakt på öret");
  }
  catch (error) { showFormError(form, error); }
});

$("#payment-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget;
  try { await api(`/api/trips/${state.trip.id}/payments`, { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) }); form.closest("dialog").close(); await refreshTrip(); toast("Betalningen registrerades"); }
  catch (error) { showFormError(form, error); }
});

init();
