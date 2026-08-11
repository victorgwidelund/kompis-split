const state = { user: null, dashboard: null, trips: [], trip: null, tab: "overview", inviteToken: "", invitation: null };
const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const money = new Intl.NumberFormat("sv-SE", { style: "currency", currency: "SEK", maximumFractionDigits: 2 });
const dateFormat = new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "short", year: "numeric" });
const colors = ["#c7e6d2", "#f6ca67", "#bfc6fb", "#ffc6b7", "#d5c2e8", "#b9dcdf"];
const categories = { food: "🍝", travel: "🚆", stay: "🏡", fun: "🎟️", other: "🧾" };

function formatMoney(ore) { return money.format((Number(ore) || 0) / 100).replace("SEK", "kr"); }
function formatDate(value) {
  if (!value) return "Inga datum angivna";
  const date = String(value).includes("T") || String(value).includes(" ") ? new Date(String(value).replace(" ", "T") + (String(value).includes("Z") ? "" : "Z")) : new Date(`${value}T12:00:00`);
  return dateFormat.format(date);
}
function person(id) { return state.trip?.participants.find((item) => item.id === Number(id)); }
function initials(name) { return String(name || "?").split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase(); }
function avatar(item, index = 0) { return `<span class="avatar" style="background:${colors[index % colors.length]}">${escapeHtml(initials(item?.name))}</span>`; }
function escapeHtml(value) { const div = document.createElement("div"); div.textContent = String(value ?? ""); return div.innerHTML; }
function canManageTrip() { return ["owner", "admin"].includes(state.trip?.role); }
function canVoid(createdBy) { return canManageTrip() || Number(createdBy) === Number(state.user?.id); }
function emptyState(title, text) { return `<div class="empty"><strong>${title}</strong>${text}</div>`; }

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
    $("#auth-subtitle").textContent = "Skapa ditt eget konto för att gå med i resan.";
  } else if (mode === "login" && state.invitation) {
    $("#auth-subtitle").textContent = "Logga in så läggs resan till på ditt konto.";
  }
}

function showAuth(needsSetup) {
  $("#app").classList.add("hidden");
  $("#login-screen").classList.remove("hidden");
  const summary = $("#invite-summary");
  summary.classList.toggle("hidden", !state.invitation);
  if (state.invitation) summary.innerHTML = `<strong>${escapeHtml(state.invitation.inviterName)}</strong> har bjudit in dig till <strong>${escapeHtml(state.invitation.tripName)}</strong>.`;
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
    if (!session.authenticated) return showAuth(session.needsSetup);
    await finishAuthentication(session.user);
  } catch (error) { toast(error.message); }
}

async function enterApp() {
  $("#login-screen").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#sidebar-user-name").textContent = state.user.name;
  $("#sidebar-user-email").textContent = state.user.email;
  $("#dashboard-greeting").textContent = `Hej, ${state.user.name.split(/\s+/)[0]}!`;
  await loadDashboard();
  const hashId = Number(location.hash.match(/^#trip-(\d+)$/)?.[1]);
  if (hashId && state.trips.some((trip) => trip.id === hashId)) await selectTrip(hashId);
  else showDashboard(false);
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
  $("#dashboard-expenses").innerHTML = state.dashboard.recentExpenses.length ? state.dashboard.recentExpenses.map((expense) => `<button class="expense-row dashboard-expense" data-trip-id="${expense.tripId}"><span class="category-icon">${categories[expense.category] || categories.other}</span><span class="expense-main"><strong>${escapeHtml(expense.title)}</strong><small>${escapeHtml(expense.tripName)} · ${escapeHtml(expense.payerName)} · ${formatDate(expense.expenseDate)}</small></span><span class="expense-amount">${formatMoney(expense.amountCents)}</span></button>`).join("") : emptyState("Inga utgifter ännu", "De senaste utgifterna från dina aktiva resor visas här.");
  $("#dashboard-archive-panel").classList.toggle("hidden", archived.length === 0);
  $("#dashboard-archive").innerHTML = archived.map((trip, index) => tripButton(trip, index)).join("");
}

function showDashboard(updateHash = true) {
  state.trip = null;
  $("#trip-view").classList.add("hidden");
  $("#dashboard-view").classList.remove("hidden");
  if (updateHash) history.replaceState(null, "", location.pathname);
  renderTripLists();
}

async function selectTrip(id) {
  const payload = await api(`/api/trips/${id}`);
  state.trip = payload.trip;
  location.hash = `trip-${id}`;
  $("#dashboard-view").classList.add("hidden");
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
  const remove = allowAction && canVoid(expense.createdBy) && !state.trip.archivedAt;
  return `<article class="expense-row"><span class="category-icon">${categories[expense.category] || categories.other}</span><div class="expense-main"><strong>${escapeHtml(expense.title)}</strong><small>${escapeHtml(payer?.name || "Okänd")} betalade · ${formatDate(expense.expenseDate)} · delat mellan ${expense.shares.length}</small></div><div class="expense-amount">${formatMoney(expense.amountCents)}</div>${remove ? `<button class="delete-button" data-delete-expense="${expense.id}" aria-label="Ta bort ${escapeHtml(expense.title)} från beräkningen" title="Ta bort från beräkningen">×</button>` : ""}</article>`;
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

function openExpenseDialog() {
  if (!state.trip?.participants.length) { toast("Lägg till minst en person först"); return openPersonDialog(); }
  const form = $("#expense-form"); form.reset(); form.elements.expenseDate.value = new Date().toISOString().slice(0, 10);
  form.elements.payerId.innerHTML = state.trip.participants.map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join("");
  renderSplitPeople(); openDialog("expense-dialog");
}

function renderSplitPeople() {
  const form = $("#expense-form"); const mode = form.elements.splitMode.value; const count = state.trip.participants.length; const amountOre = Math.round(Number(form.elements.amount.value || 0) * 100);
  function defaultValue(index) {
    if (mode === "shares") return "1";
    if (mode === "percentage") { const base = Math.floor(10000 / count) / 100; return (index === count - 1 ? 100 - base * (count - 1) : base).toFixed(2); }
    if (mode === "exact" && amountOre > 0) { const base = Math.floor(amountOre / count); const ore = index === 0 ? base + (amountOre - base * count) : base; return (ore / 100).toFixed(2); }
    return "";
  }
  $("#split-people").innerHTML = state.trip.participants.map((item, index) => `<label class="split-person"><input type="checkbox" name="splitPerson" value="${item.id}" checked />${avatar(item, index)}<span>${escapeHtml(item.name)}</span>${mode === "equal" ? "<span></span>" : `<input class="value-input" name="splitValue-${item.id}" type="number" min="0" step="${mode === "shares" ? "0.1" : "0.01"}" value="${defaultValue(index)}" aria-label="${mode} för ${escapeHtml(item.name)}" />`}</label>`).join("");
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
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const input = document.createElement("textarea"); input.value = text; input.setAttribute("readonly", ""); input.style.position = "fixed"; input.style.opacity = "0"; document.body.append(input); input.select(); document.execCommand("copy"); input.remove();
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
  const deleteExpense = event.target.closest("[data-delete-expense]");
  if (deleteExpense && confirm("Ta bort utgiften från beräkningen? Originalposten sparas i historiken.")) { try { await api(`/api/expenses/${deleteExpense.dataset.deleteExpense}`, { method: "DELETE", body: "{}" }); await refreshTrip(); toast("Utgiften togs bort från beräkningen"); } catch (error) { toast(error.message); } return; }
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
[$("#new-trip-button"), $("#mobile-new-trip"), $("#dashboard-new-trip")].forEach((button) => button.addEventListener("click", () => { $("#trip-form").reset(); openDialog("trip-dialog"); }));
[$("#add-person-button"), $("#summary-add-person"), $("#people-add-button")].forEach((button) => button.addEventListener("click", openPersonDialog));
[$("#add-expense-button"), $("#expenses-add-button")].forEach((button) => button.addEventListener("click", openExpenseDialog));

$("#archive-button").addEventListener("click", async () => {
  const restoring = Boolean(state.trip.archivedAt);
  if (!confirm(restoring ? "Återställ resan och tillåt nya ändringar?" : "Arkivera resan? Alla utgifter och saldon bevaras.")) return;
  try { await api(`/api/trips/${state.trip.id}/archive`, { method: "POST", body: JSON.stringify({ archived: !restoring }) }); await loadDashboard(); if (restoring) await selectTrip(state.trip.id); else showDashboard(); toast(restoring ? "Resan återställdes" : "Resan arkiverades"); }
  catch (error) { toast(error.message); }
});

$("#invite-button").addEventListener("click", () => { $("#invite-output").classList.add("hidden"); openDialog("invite-dialog"); });
$("#create-invite-button").addEventListener("click", async () => {
  try { const payload = await api(`/api/trips/${state.trip.id}/invitations`, { method: "POST", body: "{}" }); const link = new URL(payload.invitation.path, location.origin).href; $("#invite-link").value = link; $("#invite-expiry").textContent = `Gäller till ${formatDate(payload.invitation.expiresAt)}.`; $("#invite-output").classList.remove("hidden"); }
  catch (error) { toast(error.message); }
});
$("#copy-invite-button").addEventListener("click", async () => { await copyText($("#invite-link").value); toast("Inbjudningslänken kopierades"); });

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

$("#expense-form").addEventListener("change", (event) => { if (event.target.name === "splitMode") renderSplitPeople(); else updateSplitSummary(); });
$("#expense-form").addEventListener("input", updateSplitSummary);
$("#expense-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget; const data = Object.fromEntries(new FormData(form)); const selected = $$("input[name='splitPerson']:checked", form);
  data.entries = selected.map((checkbox) => ({ participantId: Number(checkbox.value), value: data[`splitValue-${checkbox.value}`] ?? 1 }));
  Object.keys(data).filter((key) => key.startsWith("splitValue-") || key === "splitPerson").forEach((key) => delete data[key]);
  try { await api(`/api/trips/${state.trip.id}/expenses`, { method: "POST", body: JSON.stringify(data) }); form.closest("dialog").close(); await refreshTrip(); toast("Utgiften delades exakt på öret"); }
  catch (error) { showFormError(form, error); }
});

$("#payment-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget;
  try { await api(`/api/trips/${state.trip.id}/payments`, { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) }); form.closest("dialog").close(); await refreshTrip(); toast("Betalningen registrerades"); }
  catch (error) { showFormError(form, error); }
});

init();
