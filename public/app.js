const state = { trips: [], trip: null, tab: "overview" };
const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const money = new Intl.NumberFormat("sv-SE", { style: "currency", currency: "SEK", maximumFractionDigits: 2 });
const dateFormat = new Intl.DateTimeFormat("en-SE", { day: "numeric", month: "short", year: "numeric" });
const colors = ["#c7e6d2", "#f6ca67", "#bfc6fb", "#ffc6b7", "#d5c2e8", "#b9dcdf"];
const categories = { food: "🍝", travel: "🚆", stay: "🏡", fun: "🎟️", other: "🧾" };

function formatMoney(cents) { return money.format((Number(cents) || 0) / 100).replace("SEK", "kr"); }
function formatDate(value) { return value ? dateFormat.format(new Date(`${value}T12:00:00`)) : "No dates set"; }
function person(id) { return state.trip?.participants.find((item) => item.id === Number(id)); }
function initials(name) { return String(name).split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase(); }
function avatar(item, index = 0) { return `<span class="avatar" style="background:${colors[index % colors.length]}">${initials(item.name)}</span>`; }
function escapeHtml(value) { const div = document.createElement("div"); div.textContent = String(value ?? ""); return div.innerHTML; }

let toastTimer;
function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 2600);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== "/api/login") {
    $("#app").classList.add("hidden");
    $("#login-screen").classList.remove("hidden");
  }
  if (!response.ok) throw new Error(payload.error || "Something went wrong");
  return payload;
}

async function init() {
  try {
    const session = await api("/api/session");
    if (!session.authenticated) {
      $("#login-screen").classList.remove("hidden");
      return;
    }
    await enterApp();
  } catch (error) {
    toast(error.message);
  }
}

async function enterApp() {
  $("#login-screen").classList.add("hidden");
  $("#app").classList.remove("hidden");
  await loadTrips();
  const hashId = Number(location.hash.match(/trip-(\d+)/)?.[1]);
  if (hashId && state.trips.some((trip) => trip.id === hashId)) await selectTrip(hashId);
}

async function loadTrips() {
  const payload = await api("/api/trips");
  state.trips = payload.trips;
  renderTripList();
  if (!state.trip) {
    $("#welcome").classList.remove("hidden");
    $("#trip-view").classList.add("hidden");
  }
}

function renderTripList() {
  $("#trip-count").textContent = state.trips.length;
  $("#trip-list").innerHTML = state.trips.map((trip, index) => `
    <button class="trip-link ${state.trip?.id === trip.id ? "active" : ""}" data-trip-id="${trip.id}">
      <span class="trip-emoji">${["✦", "⌁", "◇", "◉"][index % 4]}</span>
      <span><strong>${escapeHtml(trip.name)}</strong><small>${trip.participantCount} friends · ${formatMoney(trip.totalCents)}</small></span>
    </button>
  `).join("");
}

async function selectTrip(id) {
  const payload = await api(`/api/trips/${id}`);
  state.trip = payload.trip;
  location.hash = `trip-${id}`;
  $("#welcome").classList.add("hidden");
  $("#trip-view").classList.remove("hidden");
  renderTripList();
  renderTrip();
}

async function refreshTrip() {
  if (!state.trip) return;
  const payload = await api(`/api/trips/${state.trip.id}`);
  state.trip = payload.trip;
  await loadTrips();
  renderTrip();
}

function renderTrip() {
  const trip = state.trip;
  if (!trip) return;
  $("#trip-name").textContent = trip.name;
  $("#trip-date").textContent = trip.startDate ? `${formatDate(trip.startDate)}${trip.endDate ? ` — ${formatDate(trip.endDate)}` : ""}` : "TRIP IN PROGRESS";
  $("#total-spent").textContent = formatMoney(trip.totalCents);
  $("#expense-count").textContent = trip.expenses.length === 1 ? "1 expense logged" : `${trip.expenses.length} expenses logged`;
  const openAmount = trip.settlements.reduce((sum, item) => sum + item.amountCents, 0);
  $("#to-settle").textContent = formatMoney(openAmount);
  $("#settle-caption").textContent = trip.settlements.length ? `${trip.settlements.length} payment${trip.settlements.length === 1 ? "" : "s"} left` : "Everyone is even";
  $("#settlement-count").textContent = trip.settlements.length;
  $("#people-count").textContent = `${trip.participants.length} ${trip.participants.length === 1 ? "friend" : "friends"}`;
  $("#avatar-stack").innerHTML = trip.participants.slice(0, 5).map(avatar).join("");
  renderExpenses();
  renderBalances();
  renderSettlements();
  renderPeople();
  setTab(state.tab);
}

function expenseRow(expense, canDelete = true) {
  const payer = person(expense.payerId);
  return `<article class="expense-row">
    <span class="category-icon">${categories[expense.category] || categories.other}</span>
    <div class="expense-main"><strong>${escapeHtml(expense.title)}</strong><small>${escapeHtml(payer?.name || "Unknown")} paid · ${formatDate(expense.expenseDate)} · ${expense.shares.length} shared</small></div>
    <div class="expense-amount">${formatMoney(expense.amountCents)}</div>
    ${canDelete ? `<button class="delete-button" data-delete-expense="${expense.id}" aria-label="Delete ${escapeHtml(expense.title)}" title="Delete expense">×</button>` : ""}
  </article>`;
}

function emptyState(title, text) { return `<div class="empty"><strong>${title}</strong>${text}</div>`; }

function renderExpenses() {
  const expenses = state.trip.expenses;
  $("#recent-expenses").innerHTML = expenses.length ? expenses.slice(0, 4).map((expense) => expenseRow(expense, false)).join("") : emptyState("Nothing spent yet", "Add the first expense when someone picks up the bill.");
  $("#all-expenses").innerHTML = expenses.length ? expenses.map((expense) => expenseRow(expense)).join("") : emptyState("No receipts, no problem", "Your expenses will appear here.");
}

function renderBalances() {
  const people = state.trip.participants;
  $("#balance-list").innerHTML = people.length ? people.map((item, index) => {
    const balance = Number(state.trip.balances[item.id] || 0);
    const caption = balance > 0 ? "gets back" : balance < 0 ? "owes" : "is even";
    return `<div class="balance-row">${avatar(item, index)}<div class="balance-name"><strong>${escapeHtml(item.name)}</strong><small>${caption}</small></div><strong class="${balance > 0 ? "positive" : balance < 0 ? "negative" : ""}">${balance === 0 ? "—" : formatMoney(Math.abs(balance))}</strong></div>`;
  }).join("") : emptyState("Add your crew", "Balances appear once friends join.");
}

function swishUrl(settlement) {
  const recipient = person(settlement.toId);
  const phone = recipient?.swishPhone?.replace(/\D/g, "") || "";
  if (!phone) return "";
  const data = {
    version: 1,
    payee: { value: phone, editable: false },
    amount: { value: settlement.amountCents / 100, editable: false },
    message: { value: state.trip.name.slice(0, 50), editable: true },
  };
  return `swish://payment?data=${encodeURIComponent(JSON.stringify(data))}`;
}

function renderSettlements() {
  const settlements = state.trip.settlements;
  $("#settlement-list").innerHTML = settlements.length ? settlements.map((item) => {
    const from = person(item.fromId);
    const to = person(item.toId);
    const link = swishUrl(item);
    return `<article class="settlement-card">
      <div class="settlement-route"><div>${avatar(from, item.fromId)}<strong>${escapeHtml(from.name)}</strong></div><span class="route-arrow">→</span><div>${avatar(to, item.toId)}<strong>${escapeHtml(to.name)}</strong></div></div>
      <div class="settlement-amount"><small>should pay</small><strong>${formatMoney(item.amountCents)}</strong></div>
      <div class="settlement-actions">
        <button class="button ${link ? "primary" : "ghost"}" data-swish-from="${item.fromId}" data-swish-to="${item.toId}" data-swish-amount="${item.amountCents}" ${link ? `data-swish-url="${escapeHtml(link)}"` : ""}>${link ? "Open Swish" : "Copy details"}</button>
        <button class="button ghost" data-record-from="${item.fromId}" data-record-to="${item.toId}" data-record-amount="${item.amountCents}">Mark paid</button>
      </div>
    </article>`;
  }).join("") : `<div class="panel" style="grid-column:1/-1">${emptyState("All settled up ✦", "No one owes anything right now.")}</div>`;

  $("#payment-list").innerHTML = state.trip.payments.length ? state.trip.payments.map((payment) => `<article class="expense-row"><span class="category-icon">✓</span><div class="expense-main"><strong>${escapeHtml(person(payment.fromId)?.name)} paid ${escapeHtml(person(payment.toId)?.name)}</strong><small>${escapeHtml(payment.note || "Payment")} · ${new Date(`${payment.paidAt}Z`).toLocaleDateString("en-SE")}</small></div><div class="expense-amount positive">${formatMoney(payment.amountCents)}</div><button class="delete-button" data-delete-payment="${payment.id}" aria-label="Undo payment" title="Undo payment">×</button></article>`).join("") : emptyState("No payments recorded", "Completed Swish payments will appear here.");
}

function renderPeople() {
  $("#people-list").innerHTML = state.trip.participants.length ? state.trip.participants.map((item, index) => `<article class="person-card">${avatar(item, index)}<strong>${escapeHtml(item.name)}</strong><small>${item.swishPhone ? `Swish ${escapeHtml(item.swishPhone)}` : "No Swish number"}</small></article>`).join("") : emptyState("Who’s coming?", "Add friends to start splitting expenses.");
}

function setTab(tab) {
  state.tab = tab;
  $$(".tab").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  $$(".tab-panel").forEach((panel) => panel.classList.add("hidden"));
  $(`#tab-${tab}`).classList.remove("hidden");
}

function openDialog(id) {
  const dialog = $(`#${id}`);
  $(".form-error", dialog).textContent = "";
  dialog.showModal();
}

function openPersonDialog() {
  if (!state.trip) return toast("Create a trip first");
  $("#person-form").reset();
  openDialog("person-dialog");
}

function openExpenseDialog() {
  if (!state.trip?.participants.length) {
    toast("Add at least one friend first");
    return openPersonDialog();
  }
  const form = $("#expense-form");
  form.reset();
  form.elements.expenseDate.value = new Date().toISOString().slice(0, 10);
  form.elements.payerId.innerHTML = state.trip.participants.map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join("");
  renderSplitPeople();
  openDialog("expense-dialog");
}

function renderSplitPeople() {
  const form = $("#expense-form");
  const mode = form.elements.splitMode.value;
  const count = state.trip.participants.length;
  const amountCents = Math.round(Number(form.elements.amount.value || 0) * 100);
  function defaultValue(index) {
    if (mode === "shares") return "1";
    if (mode === "percentage") {
      const base = Math.floor((10000 / count)) / 100;
      return (index === count - 1 ? 100 - base * (count - 1) : base).toFixed(2);
    }
    if (mode === "exact" && amountCents > 0) {
      const base = Math.floor(amountCents / count);
      const cents = index === 0 ? base + (amountCents - base * count) : base;
      return (cents / 100).toFixed(2);
    }
    return "";
  }
  $("#split-people").innerHTML = state.trip.participants.map((item, index) => `<label class="split-person"><input type="checkbox" name="splitPerson" value="${item.id}" checked />${avatar(item, index)}<span>${escapeHtml(item.name)}</span>${mode === "equal" ? "<span></span>" : `<input class="value-input" name="splitValue-${item.id}" type="number" min="0" step="${mode === "shares" ? "0.1" : "0.01"}" value="${defaultValue(index)}" aria-label="${mode} for ${escapeHtml(item.name)}" />`}</label>`).join("");
  updateSplitSummary();
}

function updateSplitSummary() {
  const form = $("#expense-form");
  const selected = $$("input[name='splitPerson']:checked", form);
  const amount = Number(form.elements.amount.value || 0);
  const mode = form.elements.splitMode.value;
  let text = `${selected.length} ${selected.length === 1 ? "person" : "people"} selected`;
  if (mode === "equal" && selected.length && amount) text += ` · about ${money.format(amount / selected.length).replace("SEK", "kr")} each`;
  if (mode === "percentage") {
    const total = selected.reduce((sum, checkbox) => sum + Number(form.elements[`splitValue-${checkbox.value}`]?.value || 0), 0);
    text += ` · ${total.toFixed(2).replace(/\.00$/, "")}% assigned`;
  }
  if (mode === "exact") {
    const total = selected.reduce((sum, checkbox) => sum + Number(form.elements[`splitValue-${checkbox.value}`]?.value || 0), 0);
    text += ` · ${money.format(total).replace("SEK", "kr")} assigned`;
  }
  $("#split-summary").textContent = text;
}

function showFormError(form, error) { $(".form-error", form).textContent = error.message; }

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api("/api/login", { method: "POST", body: JSON.stringify({ password: form.elements.password.value }) });
    form.reset();
    $("#login-error").textContent = "";
    await enterApp();
  } catch (error) { $("#login-error").textContent = error.message; }
});

$("#logout-button").addEventListener("click", async () => { await api("/api/logout", { method: "POST" }); location.reload(); });

document.addEventListener("click", async (event) => {
  const tripLink = event.target.closest("[data-trip-id]");
  if (tripLink) return selectTrip(Number(tripLink.dataset.tripId));
  const tab = event.target.closest("[data-tab]");
  if (tab) return setTab(tab.dataset.tab);
  const goTab = event.target.closest("[data-go-tab]");
  if (goTab) return setTab(goTab.dataset.goTab);
  const close = event.target.closest(".dialog-close");
  if (close) return close.closest("dialog").close();

  const deleteExpense = event.target.closest("[data-delete-expense]");
  if (deleteExpense && confirm("Delete this expense? This cannot be undone.")) {
    try { await api(`/api/expenses/${deleteExpense.dataset.deleteExpense}`, { method: "DELETE" }); await refreshTrip(); toast("Expense deleted"); } catch (error) { toast(error.message); }
  }
  const deletePayment = event.target.closest("[data-delete-payment]");
  if (deletePayment && confirm("Undo this recorded payment?")) {
    try { await api(`/api/payments/${deletePayment.dataset.deletePayment}`, { method: "DELETE" }); await refreshTrip(); toast("Payment removed"); } catch (error) { toast(error.message); }
  }
  const swish = event.target.closest("[data-swish-from]");
  if (swish) {
    const from = person(swish.dataset.swishFrom);
    const to = person(swish.dataset.swishTo);
    const details = `${from.name} pays ${to.name} ${formatMoney(swish.dataset.swishAmount)} — ${state.trip.name}`;
    if (swish.dataset.swishUrl) {
      location.href = swish.dataset.swishUrl;
      setTimeout(() => navigator.clipboard?.writeText(details), 700);
    } else {
      await navigator.clipboard?.writeText(details);
      toast(`Copied payment details. Add ${to.name}’s Swish number to enable one-tap payments.`);
    }
  }
  const record = event.target.closest("[data-record-from]");
  if (record) {
    const form = $("#payment-form");
    form.reset();
    form.elements.fromId.value = record.dataset.recordFrom;
    form.elements.toId.value = record.dataset.recordTo;
    form.elements.amount.value = (Number(record.dataset.recordAmount) / 100).toFixed(2);
    $("#payment-route").textContent = `${person(record.dataset.recordFrom).name} → ${person(record.dataset.recordTo).name}`;
    openDialog("payment-dialog");
  }
});

[$("#new-trip-button"), $("#mobile-new-trip"), $("#welcome-new-trip")].forEach((button) => button.addEventListener("click", () => { $("#trip-form").reset(); openDialog("trip-dialog"); }));
[$("#add-person-button"), $("#summary-add-person"), $("#people-add-button")].forEach((button) => button.addEventListener("click", openPersonDialog));
[$("#add-expense-button"), $("#expenses-add-button")].forEach((button) => button.addEventListener("click", openExpenseDialog));
$("#back-to-trips").addEventListener("click", () => { state.trip = null; location.hash = ""; $("#trip-view").classList.add("hidden"); $("#welcome").classList.remove("hidden"); });

$("#trip-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const data = Object.fromEntries(new FormData(form));
    const payload = await api("/api/trips", { method: "POST", body: JSON.stringify(data) });
    form.closest("dialog").close();
    await loadTrips();
    await selectTrip(payload.trip.id);
    toast("Trip created — now add your friends");
    openPersonDialog();
  } catch (error) { showFormError(form, error); }
});

$("#person-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api(`/api/trips/${state.trip.id}/participants`, { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    form.closest("dialog").close();
    await refreshTrip();
    toast("Friend added");
  } catch (error) { showFormError(form, error); }
});

$("#expense-form").addEventListener("change", (event) => {
  if (event.target.name === "splitMode") renderSplitPeople();
  else updateSplitSummary();
});
$("#expense-form").addEventListener("input", updateSplitSummary);
$("#expense-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  const selected = $$("input[name='splitPerson']:checked", form);
  data.entries = selected.map((checkbox) => ({ participantId: Number(checkbox.value), value: data[`splitValue-${checkbox.value}`] ?? 1 }));
  Object.keys(data).filter((key) => key.startsWith("splitValue-") || key === "splitPerson").forEach((key) => delete data[key]);
  try {
    await api(`/api/trips/${state.trip.id}/expenses`, { method: "POST", body: JSON.stringify(data) });
    form.closest("dialog").close();
    await refreshTrip();
    toast("Expense split down to the öre");
  } catch (error) { showFormError(form, error); }
});

$("#payment-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api(`/api/trips/${state.trip.id}/payments`, { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    form.closest("dialog").close();
    await refreshTrip();
    toast("Payment recorded");
  } catch (error) { showFormError(form, error); }
});

init();
