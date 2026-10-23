import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.47.10/+esm";

const app = document.getElementById("app");
const cfg = window.AT_SITE || {};
const CODE_RE = /^[A-Za-z0-9-]{4,32}$/;

const state = {
  poll: 0,
  card: null,
  preview: false,
  loadedCode: "",
  selected: new Set(),
  draft: null,
  flash: "",
  desk: {
    tab: "cards",
    session: null,
    cards: [],
    options: [],
    messages: [],
    thread: [],
    openId: "",
    note: "",
    bad: false,
    linkTouched: false
  }
};

const SAMPLE = {
  found: true,
  public_code: "SAMPLE",
  ref_no: "AT-000001",
  shop_name: "ASLEEPIUS TECH",
  slogan: "WE HEAL TECH",
  client_name: "NORTHSIDE DINER",
  prepared_for: "Maya",
  phone_display: "555-0100",
  emergency_label: "SYSTEM DOWN?",
  emergency_instruction: "CALL OR TEXT, ANY HOUR:",
  followup_line: "SCHEDULED CHECK-INS MONTHLY · EMERGENCIES: CALL OR TEXT ANYTIME",
  status: "loaded",
  contact: { name: "", phone: "", email: "" },
  orders: [
    { kind: "standard", problem: "Register frozen mid-rush", fix: "Handled the same day", price_cents: 0 },
    { kind: "custom", problem: "Patio speaker cuts out", fix: "Replace the cable end", price_cents: 8500 }
  ],
  options: [
    { key: "register", label: "Register frozen mid-rush", detail: "Handled the same day", price_cents: 15000 },
    { key: "wifi", label: "Dead Wi-Fi zones, dropped orders", detail: "Full-coverage install", price_cents: 24000 },
    { key: "menus", label: "Menu and price changes by hand", detail: "Digital menus, minutes not printers", price_cents: 9000 },
    { key: "backups", label: "No backups, one bad day from gone", detail: "Automatic, tested monthly", price_cents: 6000 }
  ],
  requests: [],
  messages: [
    { id: "m1", direction: "customer", body: "The patio speaker is cutting out again.", created_at: "2026-10-22T15:00:00Z" },
    { id: "m2", direction: "shop", body: "I can be there after the lunch rush.", created_at: "2026-10-22T15:10:00Z" }
  ]
};

function configured() {
  const url = String(cfg.supabaseUrl || "");
  const key = String(cfg.supabaseAnonKey || "");
  return url.startsWith("https://") && key.length > 20;
}

let supabase;
function client() {
  if (!supabase) supabase = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  return supabase;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[ch]));
}

function money(cents) {
  return "$" + ((Number(cents) || 0) / 100).toFixed(2);
}

function when(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function digits(phone) {
  return String(phone || "").replace(/[^\d+]/g, "");
}

function dollarsToCents(value) {
  const raw = String(value || "").trim().replace(/^\$/, "");
  if (!raw) return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;
  return Math.round(Number(raw) * 100);
}

function currentRoute() {
  const params = new URLSearchParams(location.search);
  const hash = location.hash.replace(/^#\/?/, "");
  if (hash === "desk" || params.get("desk") === "1") return { name: "desk" };
  if (params.get("preview") === "1") return { name: "card", code: "SAMPLE", preview: true };
  const path = location.pathname.match(/\/c\/([A-Za-z0-9-]+)\/?$/);
  const fromHash = hash.startsWith("c/") ? hash.slice(2) : "";
  const code = (params.get("c") || fromHash || (path && path[1]) || "").trim();
  return { name: "card", code, preview: false };
}

function siteLink(code) {
  let path = location.pathname;
  if (path.endsWith("/index.html")) path = path.slice(0, -"/index.html".length);
  if (!path.endsWith("/")) path += "/";
  return location.origin + path + "?c=" + encodeURIComponent(code);
}

function makeCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function stopPoll() {
  if (state.poll) clearInterval(state.poll);
  state.poll = 0;
}

function say(node, message, bad) {
  if (!node) return;
  node.textContent = message || "";
  node.classList.toggle("bad", Boolean(bad));
}

function selectedTotal() {
  const keys = state.selected;
  return (state.card.options || []).reduce((sum, option) => {
    return keys.has(option.key) ? sum + Number(option.price_cents || 0) : sum;
  }, 0);
}

function paintTotal() {
  const total = document.getElementById("total");
  const label = document.getElementById("total-label");
  if (!total || !label) return;
  const count = state.selected.size;
  label.textContent = count ? count + " selected" : "Nothing selected";
  total.textContent = money(selectedTotal());
}

function threadHtml(messages, viewer) {
  if (!messages.length) return '<p class="hint">No messages yet. A question sent here stays on this card.</p>';
  const mine = viewer === "shop" ? "shop" : "customer";
  return messages.map((message) => {
    const who = message.direction === mine ? "You" : (message.direction === "shop" ? "Shop" : "Customer");
    return (
      '<article class="bubble ' + (message.direction === "shop" ? "shop" : "customer") + '">' +
      '<div class="who">' + esc(who) + " · " + esc(when(message.created_at)) + "</div>" +
      "<div>" + esc(message.body) + "</div></article>"
    );
  }).join("");
}

function paintThread(messages) {
  const thread = document.getElementById("thread");
  if (!thread) return;
  const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 48;
  thread.innerHTML = threadHtml(messages || []);
  if (nearBottom) thread.scrollTop = thread.scrollHeight;
}

function savedHtml(requests) {
  if (!requests || !requests.length) return "";
  const status = { awaiting_payment: "Waiting on payment", paid: "Paid", closed: "Closed" };
  return "<h2>Saved on this card</h2>" + requests.map((request) => {
    const lines = (request.lines || []).map((line) => (
      "<li><span class=\"line\"><span>" + esc(line.label) + "</span><b class=\"price\">" + money(line.price_cents) + "</b></span></li>"
    )).join("");
    const who = [request.contact_name, request.contact_phone, request.contact_email].filter(Boolean).join(" · ");
    return '<article><div class="meta">' + esc(status[request.status] || request.status) + " · " + esc(when(request.created_at)) + "</div>" +
      "<ul class=\"orders\">" + lines + "</ul>" +
      '<div class="total-bar"><span>Request total</span><b>' + money(request.total_cents) + "</b></div>" +
      (who ? '<p class="hint">' + esc(who) + "</p>" : "") +
      (request.note ? '<p class="hint">' + esc(request.note) + "</p>" : "") +
      "</article>";
  }).join("");
}

function paintSaved(requests) {
  const node = document.getElementById("saved");
  if (node) node.innerHTML = savedHtml(requests);
}

function orderHtml(orders) {
  if (!orders.length) return '<p class="hint">Nothing is loaded on this card yet.</p>';
  return "<ul class=\"orders\">" + orders.map((order) => (
    "<li><span class=\"kind\">" + (order.kind === "custom" ? "Custom" : "Standard") + "</span>" +
    "<span class=\"line\"><b>" + esc(order.problem) + "</b>" +
    (Number(order.price_cents) > 0 ? '<b class="price">' + money(order.price_cents) + "</b>" : "") +
    "</span><i>" + esc(order.fix) + "</i></li>"
  )).join("") + "</ul>";
}

function choiceHtml(options) {
  return options.map((option) => (
    '<label class="choice"><input type="checkbox" value="' + esc(option.key) + '"' +
    (state.selected.has(option.key) ? " checked" : "") + ">" +
    "<span><b>" + esc(option.label) + "</b><i>" + esc(option.detail) + "</i></span>" +
    '<b class="price">' + money(option.price_cents) + "</b></label>"
  )).join("");
}

function renderCard(card) {
  const draft = state.draft || {
    name: (card.contact && card.contact.name) || "",
    phone: (card.contact && card.contact.phone) || "",
    email: (card.contact && card.contact.email) || "",
    note: "",
    message: ""
  };
  state.draft = draft;
  const call = digits(card.phone_display);
  const options = card.options || [];
  document.title = (card.client_name ? card.client_name + " · " : "") + (card.shop_name || "Asleepius Tech");
  app.innerHTML = (
    '<div class="phone">' +
    (state.preview ? '<p class="sample">Sample card. Nothing on this screen is saved.</p>' : "") +
    '<header class="head"><img src="logo-mark.svg" alt="">' +
    "<div><div class=\"brand\">" + esc(card.shop_name) + "</div><div class=\"kicker\">" + esc(card.slogan) + "</div></div></header>" +
    (card.client_name ? '<p class="client">' + esc(card.client_name) + "</p>" : "") +
    "<p><span class=\"hl\"><b>" + esc(card.emergency_label) + "</b></span></p>" +
    '<p class="mono">' + esc(card.emergency_instruction) + "</p>" +
    (call
      ? '<a class="call" href="tel:' + esc(call) + '">' + esc(card.phone_display) + "</a>" +
        '<a class="text" href="sms:' + esc(call) + '">Text this number</a>'
      : '<p class="hint">The phone number is printed on the card.</p>') +
    "<h2>On this card</h2>" + orderHtml(card.orders || []) +
    '<div id="saved">' + savedHtml(card.requests) + "</div>" +
    (options.length
      ? "<h2>Add work</h2><p class=\"hint\">Check what you need. The total is the work you are about to send.</p>" +
        '<div class="choices" id="options">' + choiceHtml(options) + "</div>" +
        '<div class="total-bar"><span id="total-label">Nothing selected</span><b id="total">$0.00</b></div>' +
        '<form id="pay-form"><h2>Your details</h2>' +
        "<p class=\"hint\">Nothing is charged on this step. Your name and contact are saved on the card, and a tap brings you back to request work or send a message.</p>" +
        '<label><span>Name</span><input id="contact-name" autocomplete="name" value="' + esc(draft.name) + '"></label>' +
        '<label><span>Phone</span><input id="contact-phone" autocomplete="tel" inputmode="tel" value="' + esc(draft.phone) + '"></label>' +
        '<label><span>Email</span><input id="contact-email" autocomplete="email" inputmode="email" value="' + esc(draft.email) + '"></label>' +
        '<label><span>Note</span><textarea id="request-note">' + esc(draft.note) + "</textarea></label>" +
        '<button class="primary" type="submit">Continue to pay</button><p id="pay-note" class="note"></p></form>'
      : "<h2>Add work</h2><p class=\"hint\">The shop has not posted choices yet. You can still send a message.</p>") +
    '<section class="widget"><h2>Message the shop</h2><div class="thread" id="thread">' + threadHtml(card.messages || []) + "</div>" +
    '<form id="msg-form"><label><span>Message</span><textarea id="msg-body" maxlength="2000">' + esc(draft.message) + "</textarea></label>" +
    '<button class="primary" type="submit">Send</button><p id="msg-note" class="note"></p></form></section>' +
    (card.followup_line ? '<p class="follow">' + esc(card.followup_line) + "</p>" : "") +
    '<p class="mono">' + esc(card.ref_no) + (card.prepared_for ? " · " + esc(card.prepared_for) : "") + "</p></div>"
  );
  paintTotal();
  const thread = document.getElementById("thread");
  if (thread) thread.scrollTop = thread.scrollHeight;
  if (state.flash) {
    say(document.getElementById("pay-note"), state.flash, false);
    state.flash = "";
  }
  const optionsNode = document.getElementById("options");
  if (optionsNode) optionsNode.addEventListener("change", onChoose);
  const pay = document.getElementById("pay-form");
  if (pay) pay.addEventListener("submit", onPay);
  document.getElementById("msg-form").addEventListener("submit", onMessage);
}

function rememberDraft() {
  const name = document.getElementById("contact-name");
  state.draft = {
    name: name ? name.value : (state.draft && state.draft.name) || "",
    phone: name ? document.getElementById("contact-phone").value : (state.draft && state.draft.phone) || "",
    email: name ? document.getElementById("contact-email").value : (state.draft && state.draft.email) || "",
    note: name ? document.getElementById("request-note").value : "",
    message: (document.getElementById("msg-body") || {}).value || ""
  };
}

function onChoose(event) {
  const box = event.target;
  if (!box || box.type !== "checkbox") return;
  if (box.checked) state.selected.add(box.value);
  else state.selected.delete(box.value);
  paintTotal();
}

async function onPay(event) {
  event.preventDefault();
  rememberDraft();
  const note = document.getElementById("pay-note");
  const button = event.target.querySelector("button");
  const keys = Array.from(state.selected);
  const draft = state.draft;
  if (!keys.length) return say(note, "Choose at least one option.", true);
  if (!draft.name.trim()) return say(note, "Enter a name.", true);
  if (!draft.phone.trim() && !draft.email.trim()) return say(note, "Enter a phone or email.", true);
  button.disabled = true;
  if (state.preview) {
    state.card.requests.unshift({
      id: String(Date.now()),
      status: "awaiting_payment",
      total_cents: selectedTotal(),
      contact_name: draft.name.trim(),
      contact_phone: draft.phone.trim(),
      contact_email: draft.email.trim(),
      note: draft.note.trim(),
      created_at: new Date().toISOString(),
      lines: (state.card.options || []).filter((option) => state.selected.has(option.key)).map((option) => ({
        label: option.label,
        price_cents: option.price_cents
      }))
    });
    state.card.contact = { name: draft.name.trim(), phone: draft.phone.trim(), email: draft.email.trim() };
    state.selected.clear();
    state.draft = { name: draft.name.trim(), phone: draft.phone.trim(), email: draft.email.trim(), note: "", message: draft.message };
    state.flash = "Saved on this sample. A live card stores the name, contact, and total.";
    renderCard(state.card);
    return;
  }
  const { data, error } = await client().rpc("save_request", {
    code: state.card.public_code,
    option_keys: keys,
    note: draft.note.trim(),
    contact_name: draft.name.trim(),
    contact_phone: draft.phone.trim(),
    contact_email: draft.email.trim()
  });
  button.disabled = false;
  if (error) return say(note, error.message, true);
  state.card = data;
  state.selected.clear();
  state.draft = {
    name: data.contact.name,
    phone: data.contact.phone,
    email: data.contact.email,
    note: "",
    message: ""
  };
  state.flash = "Saved on this card. Nothing was charged. Tap the card any time to add a request or send a message.";
  renderCard(state.card);
}

async function onMessage(event) {
  event.preventDefault();
  const note = document.getElementById("msg-note");
  const body = document.getElementById("msg-body").value.trim();
  const button = event.target.querySelector("button");
  if (!body) return say(note, "Write a message.", true);
  button.disabled = true;
  if (state.preview) {
    state.card.messages.push({ id: String(Date.now()), direction: "customer", body, created_at: new Date().toISOString() });
    document.getElementById("msg-body").value = "";
    if (state.draft) state.draft.message = "";
    paintThread(state.card.messages);
    button.disabled = false;
    say(note, "Sent on this sample. A live card stores it.");
    return;
  }
  const { data, error } = await client().rpc("send_message", { code: state.card.public_code, body });
  button.disabled = false;
  if (error) return say(note, error.message, true);
  state.card = data;
  document.getElementById("msg-body").value = "";
  paintThread(data.messages);
  paintSaved(data.requests);
  say(note, "Sent. It stays on this card.");
}

function startPoll() {
  stopPoll();
  if (state.preview || !state.card) return;
  state.poll = window.setInterval(async () => {
    if (currentRoute().name !== "card" || document.hidden) return;
    const { data, error } = await client().rpc("open_card", { code: state.card.public_code });
    if (error || !data || !data.found) return;
    state.card.messages = data.messages;
    state.card.requests = data.requests;
    paintThread(data.messages);
    paintSaved(data.requests);
  }, 12000);
}

async function showCard(route) {
  stopPoll();
  if (!route.code) {
    document.title = "Asleepius Tech";
    app.innerHTML = (
      '<div class="gate"><div class="gate-mark"><img src="logo-mark.svg" alt="" width="52" height="52">' +
      '<div><div class="brand">Asleepius Tech</div><div class="kicker">We heal tech</div></div></div>' +
      "<h1>Tap or scan your card</h1>" +
      "<p>The link on the card opens the work, the total, and a message to the shop.</p>" +
      '<p><a class="tiny" href="?desk=1">Shop desk</a></p></div>'
    );
    return;
  }
  if (route.preview) {
    state.preview = true;
    if (state.loadedCode !== "SAMPLE") {
      state.card = JSON.parse(JSON.stringify(SAMPLE));
      state.loadedCode = "SAMPLE";
      state.selected = new Set();
      state.draft = null;
    }
    renderCard(state.card);
    return;
  }
  state.preview = false;
  if (!configured()) {
    app.innerHTML = '<div class="gate"><h1>This card page is not connected yet</h1><p>The shop still needs to connect the card book.</p></div>';
    return;
  }
  if (!CODE_RE.test(route.code)) {
    app.innerHTML = '<div class="gate"><h1>That card link is not valid</h1></div>';
    return;
  }
  if (state.loadedCode !== route.code.toUpperCase()) {
    state.loadedCode = route.code.toUpperCase();
    state.selected = new Set();
    state.draft = null;
    state.card = null;
  }
  app.innerHTML = '<div class="gate"><p class="mono">Opening the card…</p></div>';
  const { data, error } = await client().rpc("open_card", { code: route.code });
  const now = currentRoute();
  if (now.name !== "card" || now.preview || now.code.toUpperCase() !== route.code.toUpperCase()) return;
  if (error) {
    app.innerHTML = '<div class="gate"><p class="note bad">' + esc(error.message) + "</p></div>";
    return;
  }
  if (!data || !data.found) {
    app.innerHTML = '<div class="gate"><h1>This card is not in the book yet</h1><p class="mono">' + esc(route.code.toUpperCase()) + "</p><p>Ask the shop to add this card id.</p></div>";
    return;
  }
  state.card = data;
  renderCard(data);
  startPoll();
}

function setupHtml() {
  return (
    '<div class="gate"><div class="brand">Shop desk</div>' +
    "<h1>Connect the card book</h1>" +
    "<ol><li>In Supabase, open SQL and run <b>site/supabase/schema.sql</b>.</li>" +
    "<li>Authentication → Users → Add user. Auto-confirm it, then turn off public signups.</li>" +
    "<li>Project Settings → API. Put the project URL and the anon key in <b>site/config.js</b>.</li>" +
    "<li>Publish the <b>site</b> folder with GitHub Pages.</li></ol>" +
    "<p class=\"hint\">The service role key stays in Supabase.</p></div>"
  );
}

function workRowHtml() {
  return (
    '<div class="work-row"><label><span>Kind</span><select data-kind><option value="standard">Standard</option><option value="custom">Custom</option></select></label>' +
    '<label><span>Problem</span><input data-problem></label>' +
    '<label><span>Fix</span><input data-fix></label>' +
    '<label><span>Price</span><input data-price inputmode="decimal" placeholder="0.00"></label>' +
    '<button type="button" class="tiny" data-action="remove-row">Remove</button></div>'
  );
}

function renderDesk() {
  document.title = "Shop desk · Asleepius Tech";
  if (!configured()) {
    app.innerHTML = setupHtml();
    return;
  }
  if (!state.desk.session) {
    app.innerHTML = (
      '<div class="gate"><div class="brand">Shop desk</div><h1>Shop sign in</h1>' +
      "<p class=\"hint\">Use the user you added in Supabase. Customers do not create accounts here.</p>" +
      '<form id="login"><label><span>Email</span><input id="login-email" type="email" autocomplete="username"></label>' +
      '<label><span>Password</span><input id="login-password" type="password" autocomplete="current-password"></label>' +
      '<button class="primary" type="submit">Sign in</button><p id="desk-note" class="note"></p></form></div>'
    );
    document.getElementById("login").addEventListener("submit", onLogin);
    return;
  }
  const tab = state.desk.tab;
  app.innerHTML = (
    '<div class="desk"><div class="row"><div><div class="brand">Shop desk</div><div class="kicker">' + esc(state.desk.session.user.email || "") + "</div></div>" +
    '<button type="button" class="ghost" id="sign-out">Sign out</button></div>' +
    '<div class="tabs">' +
    ["cards", "options", "messages"].map((name) => (
      '<button type="button" class="tab' + (tab === name ? " on" : "") + '" data-tab="' + name + '">' + name + "</button>"
    )).join("") +
    "</div><p id=\"desk-note\" class=\"note" + (state.desk.bad ? " bad" : "") + "\">" + esc(state.desk.note) + "</p>" +
    '<div id="desk-main">' + (tab === "options" ? optionsHtml() : tab === "messages" ? inboxHtml() : cardsHtml()) + "</div></div>"
  );
  document.getElementById("sign-out").onclick = onSignOut;
  app.querySelector(".tabs").onclick = (event) => {
    const button = event.target.closest("[data-tab]");
    if (!button) return;
    state.desk.tab = button.dataset.tab;
    state.desk.note = "";
    renderDesk();
  };
  const main = document.getElementById("desk-main");
  main.addEventListener("click", onDeskClick);
  main.addEventListener("submit", onDeskSubmit);
  const link = document.getElementById("card-link");
  if (link) link.addEventListener("input", () => { state.desk.linkTouched = true; });
  const code = document.getElementById("card-code");
  if (code) code.addEventListener("input", () => {
    if (!state.desk.linkTouched) {
      const next = document.getElementById("card-link");
      if (next) next.value = siteLink(code.value.trim().toUpperCase());
    }
  });
}

function cardsHtml() {
  const open = state.desk.cards.find((card) => card.id === state.desk.openId);
  const seed = makeCode();
  state.desk.linkTouched = false;
  return (
    '<form id="new-card" class="panel"><h2>New card</h2>' +
    "<p class=\"hint\">You set the business and the card. The customer adds their name and contact when they continue to pay.</p>" +
    '<label><span>Business</span><input id="business" required></label>' +
    '<div class="row"><label><span>Contact name</span><input id="contact-name"></label>' +
    '<label><span>Phone</span><input id="contact-phone"></label>' +
    '<label><span>Email</span><input id="contact-email"></label></div>' +
    '<label><span>Prepared for</span><input id="prepared-for"></label>' +
    '<label><span>Number printed on the card</span><input id="phone-display"></label>' +
    '<div class="row"><label><span>Card id</span><input id="card-code" required value="' + esc(seed) + '"></label>' +
    '<button type="button" class="ghost" data-action="new-code">New id</button></div>' +
    '<label><span>Link for the QR and the sticker</span><input id="card-link" required value="' + esc(siteLink(seed)) + '"></label>' +
    "<h2>Work on this card</h2><div id=\"new-rows\">" + workRowHtml() + "</div>" +
    '<button type="button" class="tiny" data-action="add-row">Add a line</button>' +
    '<button class="primary" type="submit">Save card</button></form>' +
    "<h2>Cards</h2>" +
    (state.desk.cards.length ? state.desk.cards.map(cardSummary).join("") : '<p class="hint">No cards yet.</p>') +
    (open ? openCardHtml(open) : "")
  );
}

function cardSummary(card) {
  const business = card.accounts ? card.accounts.business_name : card.client_name;
  return (
    '<article class="card-row"><div><b>' + esc(card.ref_no) + "</b> · " + esc(business || "Untitled") +
    '<div class="meta">' + esc(card.public_code) + " · " + esc(card.status) + "</div></div>" +
    '<button type="button" class="tiny" data-action="open-card" data-id="' + esc(card.id) + '">Open</button></article>'
  );
}

function openCardHtml(card) {
  const account = card.accounts || {};
  const orders = (card.work_orders || []).slice().sort((a, b) => a.sort_order - b.sort_order);
  return (
    '<section class="panel" id="open-card" data-id="' + esc(card.id) + '"><h2>' + esc(card.ref_no) + "</h2>" +
    '<label><span>Link</span><input id="open-link" readonly value="' + esc(card.custom_link) + '"></label>' +
    '<button type="button" class="ghost" data-action="copy-link">Copy link</button>' +
    '<form id="save-account"><label><span>Business</span><input name="business_name" value="' + esc(account.business_name || "") + '"></label>' +
    '<label><span>Client line on the card</span><input name="client_name" value="' + esc(card.client_name || "") + '"></label>' +
    '<label><span>Contact name</span><input name="contact_name" value="' + esc(account.contact_name || "") + '"></label>' +
    '<label><span>Phone</span><input name="phone" value="' + esc(account.phone || "") + '"></label>' +
    '<label><span>Email</span><input name="email" value="' + esc(account.email || "") + '"></label>' +
    '<label><span>Number printed on the card</span><input name="phone_display" value="' + esc(card.phone_display || "") + '"></label>' +
    '<button class="primary" type="submit">Save details</button></form>' +
    "<h2>Work</h2>" + orderHtml(orders) +
    '<form id="add-work" class="work-row"><label><span>Kind</span><select name="kind"><option value="standard">Standard</option><option value="custom">Custom</option></select></label>' +
    '<label><span>Problem</span><input name="problem" required></label>' +
    '<label><span>Fix</span><input name="fix"></label>' +
    '<label><span>Price</span><input name="price" inputmode="decimal" placeholder="0.00"></label>' +
    '<button class="primary" type="submit">Add</button></form>' +
    "<h2>Messages</h2><div class=\"thread\">" + threadHtml(state.desk.thread, "shop") + "</div>" +
    '<form id="reply"><label><span>Reply</span><textarea name="body" required></textarea></label>' +
    '<button class="primary" type="submit">Send reply</button></form></section>'
  );
}

function optionsHtml() {
  if (!state.desk.options.length) return '<p class="hint">Run the SQL so the standard choices exist, then set a price.</p>';
  return (
    '<form id="save-options"><p class="hint">Prices are dollars. 150.00 is stored as 15000 cents. The customer page uses these numbers and cannot type its own price.</p>' +
    state.desk.options.map((option) => (
      '<div class="option-row"><label><span class="plain">' + esc(option.label) + '</span><i class="hint">' + esc(option.detail) + "</i></label>" +
      '<label><span>Price</span><input data-key="' + esc(option.key) + '" value="' + (Number(option.price_cents) / 100).toFixed(2) + '"></label>' +
      '<label class="meta"><input type="checkbox" data-active="' + esc(option.key) + '"' + (option.active ? " checked" : "") + "> Shown</label></div>"
    )).join("") +
    '<button class="primary" type="submit">Save prices</button></form>'
  );
}

function inboxHtml() {
  if (!state.desk.messages.length) return '<p class="hint">No messages yet.</p>';
  return state.desk.messages.map((message) => {
    const card = message.cards || {};
    return (
      '<article class="msg-row"><div class="meta">' + esc(card.ref_no || "") + " · " + esc(card.client_name || card.public_code || "") +
      " · " + (message.direction === "shop" ? "Shop" : "Customer") + " · " + esc(when(message.created_at)) + "</div>" +
      "<p>" + esc(message.body) + "</p>" +
      (card.id ? '<button type="button" class="tiny" data-action="open-card" data-id="' + esc(card.id) + '">Open card</button>' : "") +
      "</article>"
    );
  }).join("");
}

function deskNote(message, bad) {
  state.desk.note = message || "";
  state.desk.bad = Boolean(bad);
  const node = document.getElementById("desk-note");
  if (node) say(node, state.desk.note, state.desk.bad);
}

async function onLogin(event) {
  event.preventDefault();
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const { data, error } = await client().auth.signInWithPassword({ email, password });
  if (error) return say(document.getElementById("desk-note"), error.message, true);
  state.desk.session = data.session;
  await loadDesk();
}

async function onSignOut() {
  await client().auth.signOut();
  state.desk.session = null;
  state.desk.cards = [];
  state.desk.openId = "";
  renderDesk();
}

async function loadDesk() {
  const db = client();
  const [cards, options, messages] = await Promise.all([
    db.from("cards").select("id, public_code, ref_no, client_name, prepared_for, phone_display, custom_link, status, account_id, accounts(id, business_name, contact_name, phone, email), work_orders(id, kind, problem, fix, price_cents, sort_order)").order("created_at", { ascending: false }),
    db.from("service_options").select("key, label, detail, price_cents, active, sort_order").order("sort_order"),
    db.from("messages").select("id, direction, body, created_at, card_id, cards(id, public_code, ref_no, client_name)").order("created_at", { ascending: false }).limit(40)
  ]);
  const failed = cards.error || options.error || messages.error;
  if (failed) {
    deskNote(failed.message, true);
    renderDesk();
    return;
  }
  state.desk.cards = cards.data || [];
  state.desk.options = options.data || [];
  state.desk.messages = messages.data || [];
  if (state.desk.openId) await loadThread(state.desk.openId);
  renderDesk();
  const open = document.getElementById("open-card");
  if (open) open.scrollIntoView({ block: "start" });
}

async function loadThread(cardId) {
  const { data, error } = await client().from("messages").select("id, direction, body, created_at").eq("card_id", cardId).order("created_at");
  state.desk.thread = error ? [] : (data || []);
}

function onDeskClick(event) {
  const action = event.target.closest("[data-action]");
  if (!action) return;
  if (action.dataset.action === "add-row") {
    document.getElementById("new-rows").insertAdjacentHTML("beforeend", workRowHtml());
  }
  if (action.dataset.action === "remove-row") action.closest(".work-row").remove();
  if (action.dataset.action === "new-code") {
    const code = makeCode();
    document.getElementById("card-code").value = code;
    if (!state.desk.linkTouched) document.getElementById("card-link").value = siteLink(code);
  }
  if (action.dataset.action === "copy-link") {
    const value = document.getElementById("open-link").value;
    navigator.clipboard.writeText(value).then(
      () => deskNote("Link copied."),
      () => deskNote(value)
    );
  }
  if (action.dataset.action === "open-card") {
    state.desk.openId = action.dataset.id;
    state.desk.tab = "cards";
    loadThread(action.dataset.id).then(renderDesk);
  }
}

async function onDeskSubmit(event) {
  event.preventDefault();
  const form = event.target;
  if (form.id === "new-card") return createCard(form);
  if (form.id === "save-account") return saveAccount(form);
  if (form.id === "add-work") return addWork(form);
  if (form.id === "reply") return sendReply(form);
  if (form.id === "save-options") return saveOptions(form);
}

async function createCard(form) {
  const button = form.querySelector("button[type=submit]");
  const code = document.getElementById("card-code").value.trim().toUpperCase();
  const business = document.getElementById("business").value.trim();
  const link = document.getElementById("card-link").value.trim();
  if (!CODE_RE.test(code)) return deskNote("The card id needs 4 to 32 letters or numbers.", true);
  if (!business) return deskNote("Enter the business.", true);
  if (!link) return deskNote("Enter the link that goes on the QR and the sticker.", true);
  const rows = Array.from(document.querySelectorAll("#new-rows .work-row")).map((row, index) => ({
    kind: row.querySelector("[data-kind]").value,
    problem: row.querySelector("[data-problem]").value.trim(),
    fix: row.querySelector("[data-fix]").value.trim(),
    price: row.querySelector("[data-price]").value,
    sort_order: index
  })).filter((row) => row.problem || row.fix || String(row.price).trim());
  const orders = [];
  for (const row of rows) {
    if (!row.problem) return deskNote("Each work line needs a problem.", true);
    const cents = dollarsToCents(row.price);
    if (cents === null) return deskNote("Enter prices like 150 or 150.00.", true);
    orders.push({ kind: row.kind, problem: row.problem, fix: row.fix, price_cents: cents, sort_order: row.sort_order });
  }
  button.disabled = true;
  const db = client();
  const ref = await db.rpc("next_ref");
  if (ref.error) {
    button.disabled = false;
    return deskNote(ref.error.message, true);
  }
  const account = await db.from("accounts").insert({
    business_name: business,
    contact_name: document.getElementById("contact-name").value.trim(),
    phone: document.getElementById("contact-phone").value.trim(),
    email: document.getElementById("contact-email").value.trim()
  }).select("id").single();
  if (account.error) {
    button.disabled = false;
    return deskNote(account.error.message, true);
  }
  const card = await db.from("cards").insert({
    public_code: code,
    ref_no: ref.data,
    account_id: account.data.id,
    client_name: business,
    prepared_for: document.getElementById("prepared-for").value.trim(),
    phone_display: document.getElementById("phone-display").value.trim(),
    custom_link: link,
    status: orders.length ? "loaded" : "new",
    loaded_at: orders.length ? new Date().toISOString() : null
  }).select("id").single();
  if (card.error) {
    button.disabled = false;
    return deskNote(/duplicate/i.test(card.error.message) ? "That card id is already used." : card.error.message, true);
  }
  if (orders.length) {
    const saved = await db.from("work_orders").insert(orders.map((order) => Object.assign({ card_id: card.data.id }, order)));
    if (saved.error) {
      button.disabled = false;
      return deskNote(saved.error.message, true);
    }
  }
  state.desk.openId = card.data.id;
  state.desk.linkTouched = false;
  deskNote("Card saved. Put this link on the QR and the sticker: " + link);
  await loadDesk();
}

async function saveAccount(form) {
  const card = state.desk.cards.find((item) => item.id === state.desk.openId);
  if (!card) return;
  const data = new FormData(form);
  const business = String(data.get("business_name") || "").trim();
  if (!business) return deskNote("Enter the business.", true);
  const db = client();
  if (card.account_id) {
    const account = await db.from("accounts").update({
      business_name: business,
      contact_name: String(data.get("contact_name") || "").trim(),
      phone: String(data.get("phone") || "").trim(),
      email: String(data.get("email") || "").trim(),
      updated_at: new Date().toISOString()
    }).eq("id", card.account_id);
    if (account.error) return deskNote(account.error.message, true);
  }
  const saved = await db.from("cards").update({
    client_name: String(data.get("client_name") || "").trim(),
    phone_display: String(data.get("phone_display") || "").trim(),
    updated_at: new Date().toISOString()
  }).eq("id", card.id);
  if (saved.error) return deskNote(saved.error.message, true);
  deskNote("Details saved.");
  await loadDesk();
}

async function addWork(form) {
  const card = state.desk.cards.find((item) => item.id === state.desk.openId);
  if (!card) return;
  const data = new FormData(form);
  const problem = String(data.get("problem") || "").trim();
  const cents = dollarsToCents(data.get("price"));
  if (!problem) return deskNote("Enter the problem.", true);
  if (cents === null) return deskNote("Enter prices like 150 or 150.00.", true);
  const sort = (card.work_orders || []).length;
  const saved = await client().from("work_orders").insert({
    card_id: card.id,
    kind: data.get("kind") || "standard",
    problem,
    fix: String(data.get("fix") || "").trim(),
    price_cents: cents,
    sort_order: sort
  });
  if (saved.error) return deskNote(saved.error.message, true);
  if (card.status === "new") {
    await client().from("cards").update({ status: "loaded", loaded_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", card.id);
  }
  deskNote("Work added.");
  await loadDesk();
}

async function sendReply(form) {
  const card = state.desk.cards.find((item) => item.id === state.desk.openId);
  if (!card) return;
  const body = String(new FormData(form).get("body") || "").trim();
  if (!body) return deskNote("Write a reply.", true);
  const saved = await client().from("messages").insert({
    card_id: card.id,
    account_id: card.account_id,
    direction: "shop",
    body
  });
  if (saved.error) return deskNote(saved.error.message, true);
  deskNote("Reply sent.");
  await loadDesk();
}

async function saveOptions(form) {
  const updates = Array.from(form.querySelectorAll("[data-key]")).map((input) => {
    const cents = dollarsToCents(input.value);
    const active = form.querySelector('[data-active="' + input.dataset.key + '"]');
    return { key: input.dataset.key, cents, active: Boolean(active && active.checked) };
  });
  if (updates.some((item) => item.cents === null)) return deskNote("Enter prices like 150 or 150.00.", true);
  for (const item of updates) {
    const saved = await client().from("service_options").update({ price_cents: item.cents, active: item.active }).eq("key", item.key);
    if (saved.error) return deskNote(saved.error.message, true);
  }
  deskNote("Prices saved.");
  await loadDesk();
}

async function showDesk() {
  stopPoll();
  if (!configured()) {
    renderDesk();
    return;
  }
  const { data } = await client().auth.getSession();
  state.desk.session = data.session;
  if (!data.session) {
    renderDesk();
    return;
  }
  app.innerHTML = '<div class="gate"><p class="mono">Opening the desk…</p></div>';
  await loadDesk();
}

async function boot() {
  stopPoll();
  const route = currentRoute();
  if (route.name === "desk") await showDesk();
  else await showCard(route);
}

window.addEventListener("hashchange", boot);
boot();
