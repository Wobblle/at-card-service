/* A.T. Card Studio — design, print, and load service cards. */
(function () {
  const app = document.getElementById("app");
  const state = {
    ready: false,
    key: "",
    needsKey: false,
    template: null,
    settings: {},
    dirty: false,
    cards: []
  };
  let draft = null;
  let previewFill = false;
  let openCard = null;
  let orphans = [];
  let scanStop = null;
  let printJob = null;

  const STATUS = { new: "New", printed: "Printed", in_progress: "In progress", loaded: "Loaded" };
  const EVENTS = {
    minted: "Card made",
    printed: "Marked printed",
    edited: "Details saved",
    orders_saved: "Work orders saved",
    qr_confirmed: "QR matched this card",
    nfc_bound: "NFC sticker linked",
    loaded: "Loaded on the card",
    design_refreshed: "Design updated for the next print"
  };
  const LAYOUT = [
    ["show_client", "Client line"],
    ["show_date", "Date line"],
    ["show_statement", "Statement"],
    ["show_emergency", "Emergency block"],
    ["show_nfc", "NFC target"],
    ["show_front_footer", "Front footer"],
    ["show_table", "Problem table"],
    ["show_prepared", "Prepared-for line"],
    ["show_followup", "Follow-up line"],
    ["show_stamp", "Stamp"],
    ["show_qr", "QR code"],
    ["show_back_footer", "Back footer"]
  ];

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function clone(value) { return JSON.parse(JSON.stringify(value)); }

  function inches(px) { return (Number(px) / 660 * 3.5).toFixed(2) + " in"; }

  function when(iso) {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function setPath(obj, path, value) {
    const bits = path.split(".");
    let cursor = obj;
    for (let i = 0; i < bits.length - 1; i += 1) cursor = cursor[bits[i]];
    cursor[bits[bits.length - 1]] = value;
  }

  function currentRoute() {
    const path = location.pathname.replace(/\/$/, "") || "/";
    if (path === "/print") return { name: "print" };
    if (path === "/c") return { name: "public", code: "" };
    if (path.startsWith("/c/")) {
      return { name: "public", code: decodeURIComponent(path.slice(3)) };
    }
    const bits = (location.hash.replace(/^#/, "") || "/design").split("/").filter(Boolean);
    if (bits[0] === "cards" && bits[1]) return { name: "card", ref: decodeURIComponent(bits[1]) };
    if (bits[0] === "cards") return { name: "cards" };
    return { name: "design" };
  }

  function baseWarning(url) {
    if (!url || /localhost|127\.0\.0\.1/i.test(url)) {
      return "Use this computer's network address before you print. A phone cannot open localhost.";
    }
    if (url.startsWith("http://")) {
      return "Use the https address so Chrome on the phone can open the camera and write the sticker.";
    }
    return "";
  }

  async function api(path, opts) {
    opts = opts || {};
    const headers = {};
    const key = opts.key != null ? opts.key : state.key;
    if (key) headers["X-Studio-Key"] = key;
    let body;
    if (opts.body != null) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    let response;
    try {
      response = await fetch(path, { method: opts.method || "GET", headers: headers, body: body });
    } catch (err) {
      throw new Error("The studio server is not running. Start it with: python studio/server.py");
    }
    const text = await response.text();
    let data = {};
    if (text) {
      try { data = JSON.parse(text); } catch (err) { data = {}; }
    }
    if (!response.ok) {
      const error = new Error(data.error || "The studio could not do that.");
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function stopHardware() {
    if (scanStop) scanStop();
    scanStop = null;
  }

  function note(message, isError) {
    const node = document.getElementById("note");
    if (!node) return;
    node.textContent = message || "";
    node.className = isError ? "note bad" : "note";
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      return false;
    }
  }

  function padDraft(template) {
    if (!Array.isArray(template.letterhead_services)) template.letterhead_services = [];
    while (template.letterhead_services.length < 4) template.letterhead_services.push("");
    template.letterhead_services = template.letterhead_services.slice(0, 4);
    if (!Array.isArray(template.services_strip)) template.services_strip = [];
    if (!Array.isArray(template.catalog)) template.catalog = [];
    if (!template.layout) template.layout = {};
    if (!template.back) template.back = {};
    if (!template.statement) template.statement = { glyph: "IT", text: "", sub: "" };
    if (!template.emergency) template.emergency = { label: "", instruction: "", phone_display: "" };
    if (!template.nfc) template.nfc = { label: "", sub: "" };
  }

  function previewInstance() {
    const prefix = (draft.back && draft.back.ref_prefix) || "AT-";
    return {
      client_name: previewFill ? "NORTHSIDE DINER" : "",
      card_date: previewFill ? "OCT 22" : "",
      prepared_for: previewFill ? "MAYA R." : "",
      phone_display: "",
      ref_no: prefix + "______",
      qr_text: (state.settings.resolved_base || "") + "/c/PROOF",
      back_mode: "menu",
      order_rows: []
    };
  }

  function paintPreview() {
    const front = document.getElementById("preview-front");
    const back = document.getElementById("preview-back");
    if (!front || !back || !draft) return;
    const model = ATCard.present(draft, previewInstance());
    ATCard.mount(front, model, "front");
    ATCard.mount(back, model, "back");
    requestAnimationFrame(function () { ATCard.fitAll(); });
  }

  function paintChrome() {
    const warn = document.getElementById("head-warn");
    if (warn && state.settings) {
      const message = baseWarning(state.settings.resolved_base);
      warn.hidden = !message;
      warn.textContent = message;
    }
    const route = currentRoute();
    document.querySelectorAll("[data-nav]").forEach(function (link) {
      const on = link.dataset.nav === route.name || (link.dataset.nav === "cards" && route.name === "card");
      link.classList.toggle("on", on);
      if (link.dataset.nav === "design") link.textContent = state.dirty ? "Design *" : "Design";
    });
  }

  function shellHtml() {
    return (
      '<header class="top">' +
      '<div class="brand-lockup"><img src="/static/logo-mark.svg" alt="">' +
      '<div><div class="brand-name">ASLEEPIUS TECH</div><div class="studio-name">CARD STUDIO</div></div></div>' +
      '<nav class="nav"><a href="#/design" data-nav="design">Design</a>' +
      '<a href="#/cards" data-nav="cards">Cards</a></nav>' +
      '<button type="button" class="key" id="copy-key">Key <b id="key-val"></b></button>' +
      '<p class="head-warn" id="head-warn" hidden></p></header>' +
      '<div id="main"></div>' +
      '<p class="footer-note">Records stay in studio/data on this computer. Accounts, payment notes, and messages to your phone are already in the database for a later step.</p>'
    );
  }

  function ensureShell() {
    if (document.body.dataset.shell === "studio") {
      paintChrome();
      return;
    }
    document.body.dataset.shell = "studio";
    document.body.className = "studio";
    app.innerHTML = shellHtml();
    document.getElementById("key-val").textContent = state.key;
    document.getElementById("copy-key").onclick = async function () {
      const ok = await copyText(state.key);
      note(ok ? "Key copied." : "Select the key and copy it.");
    };
    app.querySelector(".nav").addEventListener("click", function (event) {
      const link = event.target.closest("a[data-nav]");
      if (!link || !state.dirty) return;
      if (!window.confirm("Leave without saving the design?")) event.preventDefault();
    });
    paintChrome();
  }

  function field(label, scope, value, max, hint) {
    return (
      '<label class="field"><span>' + esc(label) + '</span>' +
      '<input data-scope="' + esc(scope) + '" type="text" maxlength="' + max + '" value="' + esc(value || "") + '" autocomplete="off">' +
      (hint ? '<small>' + esc(hint) + '</small>' : '') + '</label>'
    );
  }

  function area(label, scope, value, max, hint) {
    return (
      '<label class="field"><span>' + esc(label) + '</span>' +
      '<textarea data-scope="' + esc(scope) + '" maxlength="' + max + '">' + esc(value || "") + '</textarea>' +
      (hint ? '<small>' + esc(hint) + '</small>' : '') + '</label>'
    );
  }

  function catalogHtml() {
    return draft.catalog.map(function (row, index) {
      return (
        '<div class="cat-row" data-key="' + esc(row.key) + '">' +
        '<input data-cat="problem" type="text" maxlength="80" value="' + esc(row.problem) + '" placeholder="Problem" autocomplete="off">' +
        '<input data-cat="fix" type="text" maxlength="72" value="' + esc(row.fix) + '" placeholder="What you do" autocomplete="off">' +
        '<div class="cat-actions"><label class="check"><input type="checkbox" data-cat="on_card"' + (row.on_card ? " checked" : "") + '> Print on the back</label>' +
        '<button type="button" class="tiny" data-act="up" data-list="catalog" data-index="' + index + '">Up</button>' +
        '<button type="button" class="tiny" data-act="down" data-list="catalog" data-index="' + index + '">Down</button>' +
        '<button type="button" class="tiny" data-act="remove-catalog" data-index="' + index + '">Remove</button></div></div>'
      );
    }).join("");
  }

  function stripHtml() {
    return draft.services_strip.map(function (item, index) {
      return (
        '<div class="strip-row"><input data-strip="' + index + '" type="text" maxlength="22" value="' + esc(item) + '" autocomplete="off">' +
        '<div class="row-actions"><button type="button" class="tiny" data-act="up" data-list="strip" data-index="' + index + '">Up</button>' +
        '<button type="button" class="tiny" data-act="remove-strip" data-index="' + index + '">Remove</button></div></div>'
      );
    }).join("");
  }

  function enforcePrintCap() {
    const boxes = Array.from(document.querySelectorAll("[data-cat=on_card]"));
    const used = boxes.filter(function (box) { return box.checked; }).length;
    boxes.forEach(function (box) {
      const row = box.closest(".cat-row");
      const problem = row.querySelector("[data-cat=problem]").value.trim();
      box.disabled = !box.checked && (used >= 4 || !problem);
    });
  }

  function designHtml() {
    const layout = draft.layout;
    const checks = LAYOUT.map(function (item) {
      const on = layout[item[0]] !== false;
      return '<label class="check"><input type="checkbox" data-scope="layout.' + item[0] + '"' + (on ? " checked" : "") + '> ' + esc(item[1]) + '</label>';
    }).join("");
    const letters = draft.letterhead_services.map(function (item, index) {
      return '<input data-letter="' + index + '" type="text" maxlength="28" value="' + esc(item) + '" autocomplete="off">';
    }).join("");
    return (
      '<div class="studio-grid"><div class="form-panel" id="design-form">' +
      '<p id="note" class="note"></p>' +
      '<h2 class="sec">Letterhead</h2>' +
      field("Business name", "business_name", draft.business_name, 40) +
      field("Form code", "form_code", draft.form_code, 24, "Prints at the top right.") +
      field("Est line", "est_line", draft.est_line, 24) +
      '<label class="field"><span>Services under the name</span>' + letters +
      '<small>Four short lines. Empty ones drop off the card.</small></label>' +
      field("Client label", "client_label", draft.client_label, 40) +
      field("Date label", "date_label", draft.date_label, 24) +
      '<h2 class="sec">Statement</h2>' +
      field("Box", "statement.glyph", draft.statement.glyph, 3, "Two or three letters.") +
      area("Statement", "statement.text", draft.statement.text, 280, "About two lines. Longer text is cut off at the card edge.") +
      field("Line under it", "statement.sub", draft.statement.sub, 140) +
      '<h2 class="sec">Emergency</h2>' +
      field("Label", "emergency.label", draft.emergency.label, 32) +
      field("Instruction", "emergency.instruction", draft.emergency.instruction, 48) +
      field("Phone printed on every card", "emergency.phone_display", draft.emergency.phone_display, 32, "Leave this blank to write the number by hand.") +
      '<h2 class="sec">NFC target</h2>' +
      field("Tap line", "nfc.label", draft.nfc.label, 32) +
      field("Second line", "nfc.sub", draft.nfc.sub, 64) +
      '<label class="range"><span>Target size <b id="nfc-read">' + inches(layout.nfc_size || 76) + '</b></span>' +
      '<input type="range" min="64" max="160" step="2" data-scope="layout.nfc_size" value="' + (layout.nfc_size || 76) + '">' +
      '<small>Match the sticker. The draft target is 0.40 in. A 25 mm sticker is about 0.98 in.</small></label>' +
      '<h2 class="sec">Front footer</h2><div id="strip-list">' + stripHtml() + '</div>' +
      '<button type="button" class="tiny" data-act="add-strip">Add a service</button>' +
      '<small>Seven short items fit the footer.</small>' +
      '<h2 class="sec">Back</h2>' +
      field("Title", "back.title", draft.back.title, 32) +
      field("Subtitle", "back.subtitle", draft.back.subtitle, 80) +
      field("Ref prefix", "back.ref_prefix", draft.back.ref_prefix, 8, "New cards number on from this, like AT-000001.") +
      field("Prepared-for label", "prepared_label", draft.prepared_label, 32) +
      field("Follow-up line", "back.followup_line", draft.back.followup_line, 90) +
      field("Stamp", "back.stamp", draft.back.stamp, 32) +
      field("QR label", "back.qr_label", draft.back.qr_label, 24) +
      field("Back footer", "back.footer", draft.back.footer, 72) +
      '<h2 class="sec">Standard orders</h2>' +
      '<p class="hint">Checked rows print on the back. Four fit. Every row can be picked when you load a card.</p>' +
      '<div id="catalog-list">' + catalogHtml() + '</div>' +
      '<button type="button" class="tiny" data-act="add-catalog">Add a standard order</button>' +
      '<h2 class="sec">Layout</h2>' +
      '<p class="hint">Type, rules, and placement stay on the card grid so a stack of cards still matches.</p>' +
      '<div class="checks">' + checks + '</div>' +
      '<label class="range"><span>QR size <b id="qr-read">' + inches(layout.qr_size || 112) + '</b></span>' +
      '<input type="range" min="84" max="140" step="2" data-scope="layout.qr_size" value="' + (layout.qr_size || 112) + '">' +
      '<small>Larger codes scan more easily. 112 px is about 0.59 in on the paper.</small></label>' +
      '<div class="savebar"><button type="button" class="primary" id="save-design">Save design</button>' +
      '<button type="button" class="ghost" data-act="proof">Print a proof</button>' +
      '<button type="button" class="ghost" data-act="download">Download JSON</button>' +
      '<button type="button" class="tiny" data-act="restore">Restore the A.T. draft</button></div>' +
      '</div><div class="preview-col"><label class="check"><input type="checkbox" id="preview-fill"' + (previewFill ? " checked" : "") + '> Show sample handwriting</label>' +
      '<div class="face"><div class="cap">FRONT</div><div id="preview-front"></div></div>' +
      '<div class="face"><div class="cap">BACK</div><div id="preview-back"></div></div></div></div>'
    );
  }

  function onDesignInput(event) {
    const input = event.target;
    if (input.id === "preview-fill") {
      previewFill = input.checked;
      paintPreview();
      return;
    }
    if (input.dataset.scope) {
      const value = input.type === "checkbox" ? input.checked : input.type === "range" ? Number(input.value) : input.value;
      setPath(draft, input.dataset.scope, value);
      if (input.dataset.scope === "layout.qr_size") document.getElementById("qr-read").textContent = inches(value);
      if (input.dataset.scope === "layout.nfc_size") document.getElementById("nfc-read").textContent = inches(value);
    } else if (input.dataset.letter != null) {
      draft.letterhead_services[Number(input.dataset.letter)] = input.value;
    } else if (input.dataset.strip != null) {
      draft.services_strip[Number(input.dataset.strip)] = input.value;
    } else if (input.dataset.cat) {
      const row = input.closest(".cat-row");
      const item = draft.catalog.find(function (entry) { return entry.key === row.dataset.key; });
      if (!item) return;
      item[input.dataset.cat] = input.type === "checkbox" ? input.checked : input.value;
      if (input.dataset.cat === "on_card" || input.dataset.cat === "problem") enforcePrintCap();
    } else return;
    state.dirty = true;
    paintChrome();
    paintPreview();
  }

  function moveList(list, index, dir) {
    const next = index + dir;
    if (next < 0 || next >= list.length) return false;
    const item = list.splice(index, 1)[0];
    list.splice(next, 0, item);
    return true;
  }

  async function saveDesign() {
    try {
      const data = await api("/api/template", { method: "PUT", body: draft });
      state.template = data.template;
      draft = clone(data.template);
      padDraft(draft);
      state.dirty = false;
      paintDesign();
      note("Design saved. New cards use this.");
    } catch (err) {
      note(err.message, true);
    }
  }

  function onDesignClick(event) {
    const button = event.target.closest("[data-act]");
    if (!button) return;
    const act = button.dataset.act;
    const index = Number(button.dataset.index);
    if (act === "add-catalog") {
      draft.catalog.push({ key: "s" + Math.random().toString(16).slice(2, 8), problem: "", fix: "", on_card: false });
    } else if (act === "remove-catalog") {
      draft.catalog.splice(index, 1);
    } else if (act === "add-strip") {
      if (draft.services_strip.length >= 8) return;
      draft.services_strip.push("");
    } else if (act === "remove-strip") {
      draft.services_strip.splice(index, 1);
    } else if (act === "up" || act === "down") {
      const list = button.dataset.list === "catalog" ? draft.catalog : draft.services_strip;
      if (!moveList(list, index, act === "up" ? -1 : 1)) return;
    } else if (act === "proof") {
      const model = ATCard.present(draft, previewInstance());
      const payload = JSON.stringify({ models: [model], title: "Proof" });
      sessionStorage.setItem("at-proof", payload);
      localStorage.setItem("at-proof", payload);
      window.open("/print?proof=1", "_blank");
      return;
    } else if (act === "download") {
      const blob = new Blob([JSON.stringify(state.template, null, 2)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = (state.template.client_id || "card") + ".json";
      link.click();
      URL.revokeObjectURL(link.href);
      return;
    } else if (act === "restore") {
      if (!window.confirm("Put the A.T. draft copy back? This replaces the saved design.")) return;
      api("/api/template/restore", { method: "POST", body: {} }).then(function (data) {
        state.template = data.template;
        draft = clone(data.template);
        padDraft(draft);
        state.dirty = false;
        paintDesign();
        note("Draft restored.");
      }).catch(function (err) { note(err.message, true); });
      return;
    } else return;
    state.dirty = true;
    paintDesign();
    paintChrome();
  }

  function paintDesign() {
    const main = document.getElementById("main");
    main.innerHTML = designHtml();
    main.oninput = onDesignInput;
    main.onclick = function (event) {
      if (event.target.id === "save-design") {
        saveDesign();
        return;
      }
      onDesignClick(event);
    };
    enforcePrintCap();
    paintPreview();
  }

  function designView() {
    if (!draft) {
      draft = clone(state.template);
      padDraft(draft);
    }
    paintDesign();
  }

  function paintCards(main) {
    const filter = paintCards.filter || "all";
    const query = (paintCards.query || "").toLowerCase();
    const cards = state.cards.filter(function (card) {
      if (filter !== "all" && card.status !== filter) return false;
      if (!query) return true;
      return (card.ref_no + " " + card.client_name + " " + card.public_code).toLowerCase().indexOf(query) !== -1;
    });
    const warning = baseWarning(state.settings.resolved_base);
    const rows = cards.map(function (card) {
      return (
        '<tr data-ref="' + esc(card.ref_no) + '"><td><input type="checkbox" data-pick="' + esc(card.ref_no) + '"' +
        (paintCards.picked && paintCards.picked[card.ref_no] ? " checked" : "") + '></td>' +
        '<td class="mono">' + esc(card.ref_no) + '</td><td>' + esc(card.client_name || "—") + '</td>' +
        '<td><span class="badge ' + esc(card.status) + '">' + esc(STATUS[card.status] || card.status) + '</span></td>' +
        '<td>' + card.order_count + '</td>' +
        '<td>' + (card.qr_confirmed_at ? "Matched" : "—") + '</td>' +
        '<td>' + (card.nfc_written_at ? "Linked" : "—") + '</td>' +
        '<td>' + (card.printed_at ? esc(when(card.printed_at)) : "—") + '</td></tr>'
      );
    }).join("");
    const filters = ["all", "new", "printed", "in_progress", "loaded"].map(function (name) {
      const label = name === "all" ? "All" : STATUS[name];
      return '<button type="button" class="tiny' + (filter === name ? " on" : "") + '" data-filter="' + name + '">' + label + '</button>';
    }).join("");
    main.innerHTML = (
      '<div class="page"><p id="note" class="note"></p>' +
      '<h2 class="sec">Link on the QR and the sticker</h2>' +
      '<label class="field"><span>Address</span>' +
      '<input id="base-url" type="text" value="' + esc(state.settings.public_base_url || "") + '" placeholder="' + esc(state.settings.suggested_base || "") + '" autocomplete="off">' +
      '<small>Blank uses ' + esc(state.settings.resolved_base || "") + '. Cards already printed keep the link they were made with.</small></label>' +
      (warning ? '<p class="note bad">' + esc(warning) + '</p>' : '') +
      '<div class="button-row"><button type="button" class="primary" id="save-base">Save link</button></div>' +
      '<h2 class="sec">Make a batch</h2>' +
      '<p class="hint">Each card gets the saved design, a ref number, and its own QR. ' +
      (state.dirty ? "The design has unsaved edits. New cards use the last saved design." : "Save the design first if you just changed it.") + '</p>' +
      '<div class="button-row end"><label class="field">How many<input id="batch-count" type="number" min="1" max="24" value="8"></label>' +
      '<button type="button" class="primary" id="make-batch">Make cards</button></div>' +
      '<h2 class="sec">Cards</h2><div class="filters">' + filters +
      '<input id="card-query" type="text" placeholder="Find a ref or client" value="' + esc(paintCards.query || "") + '" autocomplete="off"></div>' +
      '<div class="button-row"><button type="button" class="ghost" id="print-selected">Print selected</button>' +
      '<button type="button" class="ghost" id="print-new">Print new cards</button>' +
      '<button type="button" class="tiny" id="mark-selected">Mark selected printed</button></div>' +
      '<div class="table-wrap"><table class="list"><thead><tr><th></th><th>Ref</th><th>Client</th><th>State</th><th>Orders</th><th>QR</th><th>NFC</th><th>Printed</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="8">No cards in this list yet.</td></tr>') +
      '</tbody></table></div></div>'
    );
    main.oninput = function (event) {
      if (event.target.id === "card-query") {
        paintCards.query = event.target.value;
        const query = event.target.value.toLowerCase();
        document.querySelectorAll("tr[data-ref]").forEach(function (row) {
          row.hidden = !!query && row.textContent.toLowerCase().indexOf(query) === -1;
        });
      }
      if (event.target.dataset.pick) {
        paintCards.picked = paintCards.picked || {};
        paintCards.picked[event.target.dataset.pick] = event.target.checked;
      }
    };
    main.onclick = onCardsClick;
  }

  function selectedRefs() {
    return Object.keys(paintCards.picked || {}).filter(function (ref) { return paintCards.picked[ref]; });
  }

  function openPrint(refs) {
    if (!refs.length) {
      note("Select the cards to print.", true);
      return;
    }
    window.open("/print?refs=" + refs.map(encodeURIComponent).join(","), "_blank");
  }

  async function onCardsClick(event) {
    const filter = event.target.closest("[data-filter]");
    if (filter) {
      paintCards.filter = filter.dataset.filter;
      paintCards(document.getElementById("main"));
      return;
    }
    if (event.target.id === "save-base") {
      try {
        const data = await api("/api/settings", { method: "PUT", body: { public_base_url: document.getElementById("base-url").value.trim() } });
        state.settings = data.settings;
        paintChrome();
        paintCards(document.getElementById("main"));
        note("Link saved. Cards you make from here use it.");
      } catch (err) { note(err.message, true); }
      return;
    }
    if (event.target.id === "make-batch") {
      const count = Number(document.getElementById("batch-count").value);
      if (!Number.isInteger(count) || count < 1 || count > 24) {
        note("Make between 1 and 24 cards.", true);
        return;
      }
      event.target.disabled = true;
      try {
        await api("/api/cards/batch", { method: "POST", body: { count: count } });
        await cardsView();
        note("Made " + count + " cards.");
      } catch (err) {
        note(err.message, true);
        event.target.disabled = false;
      }
      return;
    }
    if (event.target.id === "print-selected") {
      openPrint(selectedRefs());
      return;
    }
    if (event.target.id === "print-new") {
      const refs = state.cards.filter(function (card) { return card.status === "new"; }).map(function (card) { return card.ref_no; });
      if (!refs.length) { note("No new cards to print.", true); return; }
      openPrint(refs);
      return;
    }
    if (event.target.id === "mark-selected") {
      const refs = selectedRefs();
      if (!refs.length) { note("Select the cards you printed.", true); return; }
      try {
        await api("/api/cards/printed", { method: "POST", body: { refs: refs } });
        await cardsView();
        note("Marked printed.");
      } catch (err) { note(err.message, true); }
      return;
    }
    if (event.target.closest("input, button, a, label")) return;
    const row = event.target.closest("tr[data-ref]");
    if (row) location.hash = "#/cards/" + encodeURIComponent(row.dataset.ref);
  }

  async function cardsView() {
    const main = document.getElementById("main");
    main.innerHTML = '<p class="booting">Loading cards…</p>';
    try {
      const data = await api("/api/cards");
      state.cards = data.cards;
      paintCards(main);
    } catch (err) {
      main.innerHTML = '<p class="note bad">' + esc(err.message) + '</p>';
    }
  }

  function customHtml(orders) {
    return orders.filter(function (order) { return order.kind === "custom"; }).map(function (order) {
      return (
        '<div class="custom-row"><input data-c="problem" type="text" maxlength="80" value="' + esc(order.problem) + '" placeholder="Custom problem" autocomplete="off">' +
        '<input data-c="fix" type="text" maxlength="72" value="' + esc(order.fix) + '" placeholder="What you will do" autocomplete="off">' +
        '<div class="cat-actions"><button type="button" class="tiny" data-act="remove-custom">Remove</button></div></div>'
      );
    }).join("");
  }

  function fillHtml(card) {
    const phone = card.phone_display || card.phone_effective || "";
    const known = new Set((card.catalog || []).map(function (row) { return row.key; }));
    orphans = card.orders.filter(function (order) {
      return order.kind === "standard" && !known.has(order.catalog_key);
    });
    const standards = (card.catalog || []).map(function (row) {
      const checked = card.orders.some(function (order) {
        return order.kind === "standard" && order.catalog_key === row.key;
      });
      return '<label class="check"><input type="checkbox" data-std="' + esc(row.key) + '"' + (checked ? " checked" : "") + '> ' +
        esc(row.problem) + (row.fix ? " — " + esc(row.fix) : "") + '</label>';
    }).join("");
    const orphanHtml = orphans.map(function (order, index) {
      return '<label class="check"><input type="checkbox" data-orphan="' + index + '" checked> ' + esc(order.problem) + '</label>';
    }).join("");
    return (
      '<p id="note" class="note"></p>' +
      '<p class="ref-line">' + esc(card.ref_no) + '</p>' +
      '<p class="hint"><span class="badge ' + esc(card.status) + '" id="card-state">' + esc(STATUS[card.status] || card.status) + '</span></p>' +
      '<label class="field"><span>Link on the QR and the sticker</span>' +
      '<input id="card-link" type="text" readonly value="' + esc(card.link) + '"></label>' +
      '<div class="button-row"><button type="button" class="tiny" data-act="copy-link">Copy link</button>' +
      '<a class="button" href="/print?refs=' + encodeURIComponent(card.ref_no) + '" target="_blank">Print this card</a></div>' +
      '<div id="fill-root">' +
      '<h2 class="sec">1. Fill out the card</h2>' +
      '<label class="field"><span>Client (business)</span><input id="f-client" type="text" maxlength="48" value="' + esc(card.client_name) + '" autocomplete="off"></label>' +
      '<label class="field"><span>Date</span><input id="f-date" type="text" maxlength="24" value="' + esc(card.card_date) + '" autocomplete="off"></label>' +
      '<label class="field"><span>Prepared for</span><input id="f-prepared" type="text" maxlength="48" value="' + esc(card.prepared_for) + '" autocomplete="off"></label>' +
      '<label class="field"><span>Phone on this card</span><input id="f-phone" type="text" maxlength="32" value="' + esc(phone) + '" autocomplete="off">' +
      '<small>From the design unless you type a different number.</small></label>' +
      '<label class="field"><span>Shop note, not printed</span><textarea id="f-notes" maxlength="400">' + esc(card.notes) + '</textarea></label>' +
      '<label class="field"><span>Back of the next print</span><select id="f-back">' +
      '<option value="menu"' + (card.back_mode !== "orders" ? " selected" : "") + '>Standard menu</option>' +
      '<option value="orders"' + (card.back_mode === "orders" ? " selected" : "") + '>This card\'s work orders</option></select>' +
      '<small>The sticker always opens the work orders. This choice changes a reprint. Four orders fit on the paper.</small></label>' +
      '<h2 class="sec">2. Work orders</h2>' +
      '<div class="checks">' + (standards || '<p class="hint">No standard orders in the design yet.</p>') + orphanHtml + '</div>' +
      '<div id="custom-list">' + customHtml(card.orders) + '</div>' +
      '<button type="button" class="tiny" data-act="add-custom">Add a custom order</button>' +
      '<div class="button-row"><button type="button" class="primary" data-act="save">Save</button></div>' +
      '<ol class="steps">' +
      '<li id="step-fill"><strong>Fill out the card</strong></li>' +
      '<li id="step-orders"><strong>Add a work order</strong><p class="hint">Standard rows come from the design. Custom rows are for this job.</p></li>' +
      '<li id="step-qr"><strong>Scan the QR</strong>' +
      '<div class="button-row"><button type="button" class="ghost" data-act="scan">Scan QR</button>' +
      '<button type="button" class="tiny" data-act="stop-scan">Stop camera</button></div>' +
      '<video id="scan-video" class="video-box" hidden playsinline></video>' +
      '<div class="button-row"><input id="scan-paste" type="text" placeholder="Or paste the link or the card code" autocomplete="off">' +
      '<button type="button" class="tiny" data-act="paste-qr">Match</button></div></li>' +
      '<li id="step-nfc"><strong>Scan the NFC sticker</strong>' +
      '<p class="hint">Writing the sticker works in Chrome on Android, on the https link. Hold the sticker to the phone when Chrome asks.</p>' +
      '<div class="button-row"><button type="button" class="ghost" data-act="nfc">Write sticker</button></div>' +
      '<div class="button-row"><input id="f-uid" type="text" placeholder="Or paste the sticker id" autocomplete="off" value="' + esc(card.nfc_uid || "") + '">' +
      '<button type="button" class="tiny" data-act="uid">Save sticker id</button></div></li>' +
      '<li id="step-load"><strong>Load the work onto the card</strong>' +
      '<div class="button-row"><button type="button" class="primary" data-act="load" id="load-btn">Load onto the card</button>' +
      '<button type="button" class="ghost" data-act="load-skip" id="load-skip">Load without the sticker</button></div>' +
      '<p id="load-why" class="hint"></p></li></ol></div>' +
      '<h2 class="sec">History</h2><ul class="history" id="history"></ul>' +
      '<div class="button-row"><button type="button" class="tiny" data-act="refresh-design">Apply the saved design to the next print</button>' +
      '<button type="button" class="tiny" data-act="mark-printed">Mark printed</button>' +
      (card.loaded_at ? '' : '<button type="button" class="tiny" data-act="delete">Delete this card</button>') +
      '</div>'
    );
  }

  function domOrderCount() {
    const root = document.getElementById("fill-root");
    if (!root) return 0;
    let count = root.querySelectorAll("[data-std]:checked, [data-orphan]:checked").length;
    root.querySelectorAll(".custom-row").forEach(function (row) {
      if (row.querySelector("[data-c=problem]").value.trim()) count += 1;
    });
    return count;
  }

  function paintSteps(card) {
    const fill = ["f-client", "f-date", "f-prepared"].some(function (id) {
      const node = document.getElementById(id);
      return node && node.value.trim();
    });
    const map = {
      "step-fill": fill,
      "step-orders": domOrderCount() > 0,
      "step-qr": !!card.qr_confirmed_at,
      "step-nfc": !!card.nfc_written_at,
      "step-load": !!card.loaded_at
    };
    Object.keys(map).forEach(function (id) {
      const node = document.getElementById(id);
      if (node) node.classList.toggle("done", map[id]);
    });
    const load = document.getElementById("load-btn");
    const skip = document.getElementById("load-skip");
    const why = document.getElementById("load-why");
    const stateNode = document.getElementById("card-state");
    if (stateNode) {
      stateNode.textContent = STATUS[card.status] || card.status;
      stateNode.className = "badge " + card.status;
    }
    if (!load || !why) return;
    if (card.loaded_at) {
      load.hidden = true;
      skip.hidden = true;
      why.textContent = "Loaded " + when(card.loaded_at) + ". Save again to change what a tap opens.";
      return;
    }
    load.hidden = false;
    const readyOrders = map["step-orders"];
    const readyQr = map["step-qr"];
    const readyNfc = map["step-nfc"];
    load.disabled = !(readyOrders && readyQr && readyNfc);
    skip.hidden = readyNfc;
    skip.disabled = !(readyOrders && readyQr);
    if (!readyOrders) why.textContent = "Add a work order to load this card.";
    else if (!readyQr) why.textContent = "Scan the QR on this card, or paste its link.";
    else if (!readyNfc) why.textContent = "Write the sticker, or load without it.";
    else why.textContent = "Ready to load.";
  }

  function paintHistory(card) {
    const node = document.getElementById("history");
    if (!node) return;
    if (!card.events.length) {
      node.innerHTML = "<li>No history yet.</li>";
      return;
    }
    node.innerHTML = card.events.map(function (event) {
      return "<li><span>" + esc(when(event.created_at)) + "</span> " + esc(EVENTS[event.kind] || event.kind) + "</li>";
    }).join("");
  }

  function readOrders(root) {
    const orders = [];
    root.querySelectorAll("[data-std]").forEach(function (box) {
      if (!box.checked) return;
      const row = (openCard.catalog || []).find(function (item) { return item.key === box.dataset.std; });
      if (!row) return;
      orders.push({ kind: "standard", catalog_key: row.key, problem: row.problem, fix: row.fix, notes: "" });
    });
    root.querySelectorAll("[data-orphan]").forEach(function (box) {
      if (!box.checked) return;
      const order = orphans[Number(box.dataset.orphan)];
      if (order) orders.push(order);
    });
    root.querySelectorAll(".custom-row").forEach(function (row) {
      orders.push({
        kind: "custom",
        catalog_key: "",
        problem: row.querySelector("[data-c=problem]").value,
        fix: row.querySelector("[data-c=fix]").value,
        notes: ""
      });
    });
    return orders;
  }

  function detailInstance(card) {
    const typed = document.getElementById("f-phone").value.trim();
    const designPhone = ((card.snapshot.emergency || {}).phone_display || "").trim();
    return {
      client_name: document.getElementById("f-client").value,
      card_date: document.getElementById("f-date").value,
      prepared_for: document.getElementById("f-prepared").value,
      phone_display: typed === designPhone ? "" : typed,
      ref_no: card.ref_no,
      qr_text: card.link,
      back_mode: document.getElementById("f-back").value,
      order_rows: readOrders(document.getElementById("fill-root")).map(function (order) {
        return { problem: order.problem, fix: order.fix };
      })
    };
  }

  function paintDetailPreview() {
    const front = document.getElementById("detail-front");
    if (!front || !openCard) return;
    const model = ATCard.present(openCard.snapshot, detailInstance(openCard));
    ATCard.mount(front, model, "front");
    ATCard.mount(document.getElementById("detail-back"), model, "back");
    requestAnimationFrame(function () { ATCard.fitAll(); });
  }

  async function saveFill() {
    const root = document.getElementById("fill-root");
    const fields = {
      client_name: document.getElementById("f-client").value,
      card_date: document.getElementById("f-date").value,
      prepared_for: document.getElementById("f-prepared").value,
      phone_display: document.getElementById("f-phone").value,
      notes: document.getElementById("f-notes").value,
      back_mode: document.getElementById("f-back").value
    };
    await api("/api/cards/" + encodeURIComponent(openCard.ref_no), { method: "PATCH", body: fields });
    const data = await api("/api/cards/" + encodeURIComponent(openCard.ref_no) + "/orders", {
      method: "PUT",
      body: { orders: readOrders(root) }
    });
    openCard = data.card;
    paintSteps(openCard);
    paintHistory(openCard);
    paintDetailPreview();
    return openCard;
  }

  function adopt(card) {
    openCard = card;
    paintSteps(card);
    paintHistory(card);
    paintDetailPreview();
  }

  async function startCamera() {
    stopHardware();
    if (!("BarcodeDetector" in window) || !navigator.mediaDevices) {
      throw new Error("This browser has no QR scanner. Paste the link from the code.");
    }
    const video = document.getElementById("scan-video");
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    video.hidden = false;
    video.srcObject = stream;
    await video.play();
    const detector = new BarcodeDetector({ formats: ["qr_code"] });
    let stopped = false;
    let hit = false;
    const timer = setInterval(async function () {
      if (stopped || hit) return;
      try {
        const codes = await detector.detect(video);
        if (codes[0] && codes[0].rawValue) {
          hit = true;
          const value = codes[0].rawValue;
          stopHardware();
          try { await matchQr(value); } catch (err) { note(err.message, true); }
        }
      } catch (err) { /* keep scanning */ }
    }, 400);
    scanStop = function () {
      stopped = true;
      clearInterval(timer);
      stream.getTracks().forEach(function (track) { track.stop(); });
      video.hidden = true;
    };
  }

  async function matchQr(scanned) {
    const data = await api("/api/cards/" + encodeURIComponent(openCard.ref_no) + "/confirm-qr", {
      method: "POST",
      body: { scanned: scanned }
    });
    adopt(data.card);
    note("QR matches " + data.card.ref_no + ".");
  }

  async function writeSticker() {
    if (!("NDEFReader" in window)) {
      throw new Error("Writing the sticker works in Chrome on Android, on the https link.");
    }
    const ndef = new NDEFReader();
    let uid = "";
    try {
      await ndef.scan();
      ndef.onreading = function (event) { uid = event.serialNumber || uid; };
    } catch (err) { /* write can still ask for a tap */ }
    await ndef.write({ records: [{ recordType: "url", data: openCard.link }] });
    await new Promise(function (resolve) { setTimeout(resolve, 700); });
    const data = await api("/api/cards/" + encodeURIComponent(openCard.ref_no) + "/bind-nfc", {
      method: "POST",
      body: { uid: uid, written: true }
    });
    adopt(data.card);
    note(uid ? "Sticker linked." : "Link written. The sticker id was not reported.");
  }

  async function onFillClick(event) {
    const button = event.target.closest("[data-act]");
    if (!button) return;
    const act = button.dataset.act;
    try {
      if (act === "save") {
        await saveFill();
        note("Saved.");
      } else if (act === "add-custom") {
        const orders = readOrders(document.getElementById("fill-root"));
        orders.push({ kind: "custom", catalog_key: "", problem: "", fix: "", notes: "" });
        openCard.orders = orders;
        document.getElementById("custom-list").innerHTML = customHtml(orders);
        const inputs = document.querySelectorAll("#custom-list [data-c=problem]");
        if (inputs.length) inputs[inputs.length - 1].focus();
        paintSteps(openCard);
      } else if (act === "remove-custom") {
        const row = button.closest(".custom-row");
        const rows = Array.from(document.querySelectorAll(".custom-row"));
        const index = rows.indexOf(row);
        const orders = readOrders(document.getElementById("fill-root"));
        const customIndexes = [];
        orders.forEach(function (order, orderIndex) { if (order.kind === "custom") customIndexes.push(orderIndex); });
        orders.splice(customIndexes[index], 1);
        openCard.orders = orders;
        document.getElementById("custom-list").innerHTML = customHtml(orders);
        paintSteps(openCard);
      } else if (act === "copy-link") {
        const ok = await copyText(openCard.link);
        note(ok ? "Link copied." : "Select the link and copy it.");
      } else if (act === "scan") {
        await saveFill();
        await startCamera();
        note("Point the camera at this card's QR.");
      } else if (act === "stop-scan") {
        stopHardware();
      } else if (act === "paste-qr") {
        await saveFill();
        await matchQr(document.getElementById("scan-paste").value);
      } else if (act === "nfc") {
        await saveFill();
        await writeSticker();
      } else if (act === "uid") {
        const uid = document.getElementById("f-uid").value.trim();
        if (!uid) throw new Error("Paste the sticker id, or use Write sticker.");
        await saveFill();
        const data = await api("/api/cards/" + encodeURIComponent(openCard.ref_no) + "/bind-nfc", {
          method: "POST",
          body: { uid: uid, written: true }
        });
        adopt(data.card);
        note("Sticker id saved.");
      } else if (act === "load" || act === "load-skip") {
        await saveFill();
        const data = await api("/api/cards/" + encodeURIComponent(openCard.ref_no) + "/load", {
          method: "POST",
          body: {}
        });
        adopt(data.card);
        note("Loaded. A scan of this card now opens the work.");
      } else if (act === "refresh-design") {
        if (!window.confirm("Use the saved design on the next print of this card?")) return;
        await saveFill();
        const data = await api("/api/cards/" + encodeURIComponent(openCard.ref_no) + "/refresh-design", { method: "POST", body: {} });
        paintCard(data.card);
        note("Next print uses the saved design.");
      } else if (act === "mark-printed") {
        await api("/api/cards/printed", { method: "POST", body: { refs: [openCard.ref_no] } });
        const data = await api("/api/cards/" + encodeURIComponent(openCard.ref_no));
        adopt(data.card);
        note("Marked printed.");
      } else if (act === "delete") {
        if (!window.confirm("Delete " + openCard.ref_no + "?")) return;
        await api("/api/cards/" + encodeURIComponent(openCard.ref_no), { method: "DELETE" });
        location.hash = "#/cards";
      }
    } catch (err) {
      note(err.message, true);
    }
  }

  function paintCard(card) {
    openCard = card;
    const main = document.getElementById("main");
    const preview = (
      '<div class="detail-preview"><div class="face"><div class="cap">FRONT</div><div id="detail-front"></div></div>' +
      '<div class="face"><div class="cap">BACK</div><div id="detail-back"></div></div></div>'
    );
    if (document.body.dataset.shell === "studio") {
      main.innerHTML = '<div class="card-detail"><div>' + fillHtml(card) + '</div>' + preview + '</div>';
    } else {
      main.innerHTML = '<div class="phone-wrap"><header class="phone-head"><img src="/static/logo-mark.svg" alt="">' +
        '<div><div class="brand-name">ASLEEPIUS TECH</div><div class="phone-kicker">CARD SETUP</div></div></header>' +
        fillHtml(card) +
        (card.loaded_at ? '<button type="button" class="ghost" id="view-customer">View as the customer</button>' : '') +
        '</div>';
      const view = document.getElementById("view-customer");
      if (view) view.onclick = function () {
        sessionStorage.removeItem("at-operator");
        draw();
      };
    }
    const root = document.getElementById("fill-root");
    root.oninput = function () {
      paintSteps(openCard);
      paintDetailPreview();
    };
    root.onclick = onFillClick;
    main.onclick = function (event) {
      if (event.target.closest("#fill-root")) return;
      onFillClick(event);
    };
    paintSteps(card);
    paintHistory(card);
    paintDetailPreview();
  }

  async function cardView(ref) {
    const main = document.getElementById("main");
    main.innerHTML = '<p class="booting">Opening ' + esc(ref) + '…</p>';
    try {
      const data = await api("/api/cards/" + encodeURIComponent(ref));
      paintCard(data.card);
    } catch (err) {
      main.innerHTML = '<div class="page"><p class="note bad">' + esc(err.message) + '</p><p><a href="#/cards">Back to cards</a></p></div>';
    }
  }

  function telHref(phone) {
    const digits = String(phone || "").replace(/[^\d+]/g, "");
    return digits ? "tel:" + digits : "";
  }

  function renderCustomer(pub) {
    document.body.dataset.shell = "public";
    document.body.className = "public";
    const call = telHref(pub.phone_display);
    const orders = (pub.orders || []).map(function (order) {
      return '<li><span><span class="kind">' + (order.kind === "custom" ? "CUSTOM" : "STANDARD") + '</span><br><b>' +
        esc(order.problem) + '</b><i>' + esc(order.fix) + '</i></span></li>';
    }).join("");
    app.innerHTML = (
      '<div class="phone-wrap"><header class="phone-head"><img src="/static/logo-mark.svg" alt="">' +
      '<div><div class="brand-name">' + esc(pub.business_name) + '</div><div class="phone-kicker">' + esc(pub.slogan || "") + '</div></div></header>' +
      (pub.client_name ? '<p class="ref-line">' + esc(pub.client_name) + '</p>' : '') +
      '<p><span class="hl"><b>' + esc(pub.emergency_label) + '</b></span></p>' +
      '<p class="mono">' + esc(pub.emergency_instruction) + '</p>' +
      (call ? '<a class="call" href="' + esc(call) + '">' + esc(pub.phone_display) + '</a><a class="text-link" href="sms:' + esc(call.replace("tel:", "")) + '">Text this number</a>' : '<p class="hint">The phone number is printed on the card.</p>') +
      '<h2 class="sec">On this card</h2><ul class="order-list">' + orders + '</ul>' +
      (pub.followup_line ? '<p class="hint">' + esc(pub.followup_line) + '</p>' : '') +
      '<p class="mono">' + esc(pub.ref_no) + (pub.prepared_for ? ' · ' + esc(pub.prepared_for) : '') + '</p>' +
      '<button type="button" class="tiny" id="operator">Operator</button></div>'
    );
    document.getElementById("operator").onclick = function () {
      sessionStorage.setItem("at-operator", "1");
      draw();
    };
  }

  function renderGate(pub, message) {
    document.body.dataset.shell = "public";
    document.body.className = "public";
    const title = pub && pub.activated ? "Operator" : "This card is not loaded yet";
    const ref = pub && pub.ref_no ? pub.ref_no : "";
    app.innerHTML = (
      '<div class="gate"><img src="/static/logo-mark.svg" alt="" width="48" height="48">' +
      '<h1 class="brand-name">' + esc(title) + '</h1>' +
      (ref ? '<p class="mono">' + esc(ref) + '</p>' : '') +
      '<p class="hint">Enter the studio key from the computer to fill this card and load the work.</p>' +
      (message ? '<p class="note bad">' + esc(message) + '</p>' : '') +
      '<label class="field"><span>Studio key</span><input id="gate-key" type="text" autocomplete="off"></label>' +
      '<button type="button" class="primary" id="gate-go">Unlock</button></div>'
    );
    document.getElementById("gate-go").onclick = async function () {
      const key = document.getElementById("gate-key").value.trim();
      try {
        const data = await api("/api/unlock", { method: "POST", body: { key: key }, key: "" });
        state.key = data.studio_key;
        localStorage.setItem("at_studio_key", data.studio_key);
        sessionStorage.setItem("at-operator", "1");
        draw();
      } catch (err) {
        renderGate(pub, err.message);
      }
    };
  }

  async function drawPublic(code) {
    if (!code) {
      document.body.className = "public";
      app.innerHTML = '<div class="gate"><p>Scan a card QR to open it.</p></div>';
      return;
    }
    let pub;
    try {
      pub = await api("/api/p/" + encodeURIComponent(code), { key: "" });
    } catch (err) {
      document.body.className = "public";
      app.innerHTML = '<div class="gate"><p class="note bad">' + esc(err.message) + '</p></div>';
      return;
    }
    const operator = sessionStorage.getItem("at-operator") === "1" || !pub.activated;
    if (pub.activated && !operator) {
      renderCustomer(pub);
      return;
    }
    const key = localStorage.getItem("at_studio_key") || "";
    if (!key) {
      renderGate(pub);
      return;
    }
    try {
      state.key = key;
      const data = await api("/api/cards/" + encodeURIComponent(code), { key: key });
      document.body.dataset.shell = "public";
      document.body.className = "public";
      app.innerHTML = '<div id="main"></div>';
      paintCard(data.card);
    } catch (err) {
      if (err.status === 401) {
        localStorage.removeItem("at_studio_key");
        renderGate(pub, "That key does not match.");
      } else renderGate(pub, err.message);
    }
  }

  function chunk(list, size) {
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  }

  function crops() {
    return ["tl", "tr", "bl", "br"].map(function (corner) {
      return '<i class="crop h ' + corner + '"></i><i class="crop v ' + corner + '"></i>';
    }).join("");
  }

  function sheetHtml(models, side, mirror, label) {
    const cells = models.map(function (model) {
      return '<div class="cell"><div class="slot-wrap">' + crops() + '<div class="fit-slot print-slot" data-side="' + side + '"></div></div>' +
        '<div class="cell-cap no-print">' + esc(model.back.ref_no) + " · " + side + '</div></div>';
    }).join("");
    return '<section class="sheet"><p class="cap no-print">' + esc(label) + '</p><div class="sheet-grid' +
      (mirror ? " mirror" : "") + '">' + cells + '</div></section>';
  }

  function renderPrintJob() {
    const side = printJob.side;
    const mirror = printJob.mirror;
    const groups = chunk(printJob.models, 8);
    let html = "";
    groups.forEach(function (group, index) {
      const span = (index * 8 + 1) + "–" + (index * 8 + group.length);
      if (side !== "back") html += sheetHtml(group, "front", false, "Fronts " + span);
      if (side !== "front") html += sheetHtml(group, "back", mirror, "Backs " + span);
    });
    const banner = (
      '<div class="print-banner no-print"><p class="hint">In the print dialog, set scale to 100%, paper to letter, and turn headers off. ' +
      'Print the fronts, flip the paper left to right so the top edge stays the top edge, then print the backs.</p>' +
      '<div class="row"><label class="field">Sheets<select id="print-side">' +
      '<option value="both"' + (side === "both" ? " selected" : "") + '>Fronts and backs</option>' +
      '<option value="front"' + (side === "front" ? " selected" : "") + '>Fronts</option>' +
      '<option value="back"' + (side === "back" ? " selected" : "") + '>Backs</option></select></label>' +
      '<label class="check"><input type="checkbox" id="print-mirror"' + (mirror ? " checked" : "") + '> Mirror the backs</label>' +
      '<button type="button" class="primary" id="do-print">Print</button>' +
      (printJob.proof ? '' : '<button type="button" class="ghost" id="do-mark">Mark these printed</button>') +
      '</div><p id="note" class="note"></p></div>'
    );
    app.innerHTML = banner + html;
    const slots = app.querySelectorAll(".print-slot");
    let cursor = 0;
    groups.forEach(function (group) {
      if (side !== "back") {
        group.forEach(function (model) {
          ATCard.mount(slots[cursor], model, "front");
          cursor += 1;
        });
      }
      if (side !== "front") {
        group.forEach(function (model) {
          ATCard.mount(slots[cursor], model, "back");
          cursor += 1;
        });
      }
    });
    requestAnimationFrame(function () { ATCard.fitAll(); });
    document.getElementById("print-side").onchange = function (event) {
      printJob.side = event.target.value;
      renderPrintJob();
    };
    document.getElementById("print-mirror").onchange = function (event) {
      printJob.mirror = event.target.checked;
      renderPrintJob();
    };
    document.getElementById("do-print").onclick = function () { window.print(); };
    const mark = document.getElementById("do-mark");
    if (mark) mark.onclick = async function () {
      try {
        await api("/api/cards/printed", { method: "POST", body: { refs: printJob.refs }, key: localStorage.getItem("at_studio_key") || "" });
        note("Marked printed.");
      } catch (err) { note(err.message, true); }
    };
  }

  async function drawPrint() {
    stopHardware();
    document.body.dataset.shell = "print";
    document.body.className = "print-mode";
    const params = new URLSearchParams(location.search);
    if (params.get("proof") === "1") {
      const raw = sessionStorage.getItem("at-proof") || localStorage.getItem("at-proof");
      if (!raw) {
        app.innerHTML = '<p class="booting">Open the proof from the design page.</p>';
        return;
      }
      const stored = JSON.parse(raw);
      printJob = { models: stored.models, side: "both", mirror: true, proof: true, refs: [] };
      renderPrintJob();
      return;
    }
    const refs = (params.get("refs") || "").split(",").filter(Boolean).map(decodeURIComponent);
    if (!refs.length) {
      app.innerHTML = '<p class="booting">Choose cards in the studio, then print them.</p>';
      return;
    }
    const key = localStorage.getItem("at_studio_key") || state.key;
    try {
      const cards = await Promise.all(refs.map(function (ref) {
        return api("/api/cards/" + encodeURIComponent(ref), { key: key });
      }));
      printJob = {
        refs: refs,
        proof: false,
        side: "both",
        mirror: true,
        models: cards.map(function (data) {
          const card = data.card;
          return ATCard.present(card.snapshot, {
            client_name: card.client_name,
            card_date: card.card_date,
            prepared_for: card.prepared_for,
            phone_display: card.phone_display,
            ref_no: card.ref_no,
            qr_text: card.link,
            back_mode: card.back_mode,
            order_rows: card.orders
          });
        })
      };
      renderPrintJob();
    } catch (err) {
      app.innerHTML = '<p class="booting">' + esc(err.message) + '</p>';
    }
  }

  function drawKeyGate() {
    document.body.dataset.shell = "gate";
    document.body.className = "studio";
    app.innerHTML = (
      '<div class="gate"><img src="/static/logo-mark.svg" alt="" width="48" height="48">' +
      '<div class="brand-name">CARD STUDIO</div>' +
      '<p class="hint">Enter the studio key from the computer that is running the server.</p>' +
      '<p id="note" class="note"></p>' +
      '<label class="field"><span>Studio key</span><input id="gate-key" type="text" autocomplete="off"></label>' +
      '<button type="button" class="primary" id="gate-go">Unlock</button></div>'
    );
    document.getElementById("gate-go").onclick = async function () {
      try {
        const data = await api("/api/unlock", {
          method: "POST",
          body: { key: document.getElementById("gate-key").value.trim() },
          key: ""
        });
        state.key = data.studio_key;
        state.needsKey = false;
        localStorage.setItem("at_studio_key", data.studio_key);
        document.body.dataset.shell = "";
        draw();
      } catch (err) { note(err.message, true); }
    };
  }

  async function bootStudio() {
    const stored = localStorage.getItem("at_studio_key") || "";
    const data = await api("/api/bootstrap", { key: stored });
    state.template = data.template;
    state.settings = data.settings;
    state.needsKey = !!data.needs_key;
    if (data.studio_key) {
      state.key = data.studio_key;
      state.needsKey = false;
      localStorage.setItem("at_studio_key", data.studio_key);
    } else {
      state.key = "";
    }
    state.ready = true;
  }

  async function draw() {
    stopHardware();
    const route = currentRoute();
    if (route.name === "print") return drawPrint();
    if (route.name === "public") return drawPublic(route.code);
    document.body.className = "studio";
    if (!state.ready) {
      app.innerHTML = '<p class="booting">Opening the studio…</p>';
      try {
        await bootStudio();
      } catch (err) {
        app.innerHTML = '<p class="booting">' + esc(err.message) + '</p>';
        return;
      }
    }
    if (state.needsKey) return drawKeyGate();
    ensureShell();
    if (route.name === "cards") return cardsView();
    if (route.name === "card") return cardView(route.ref);
    return designView();
  }

  window.addEventListener("hashchange", function () { draw(); });
  window.addEventListener("beforeunload", function (event) {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });
  window.addEventListener("beforeprint", function () { ATCard.fitAll(); });
  window.addEventListener("resize", function () { ATCard.fitAll(); });
  if (window.ResizeObserver) new ResizeObserver(function () { ATCard.fitAll(); }).observe(document.body);
  document.addEventListener("keydown", function (event) {
    if ((event.ctrlKey || event.metaKey) && event.key === "s" && currentRoute().name === "design") {
      event.preventDefault();
      saveDesign();
    }
  });
  draw();
})();
