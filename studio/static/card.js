/* Renders the A.T. card from a design plus one card's details. */
const ATCard = (function () {
  const DRAFT_W = 660;

  function clamp(value, low, high, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(low, Math.min(high, number));
  }

  function safeHex(value, fallback) {
    return /^#[0-9A-Fa-f]{6}$/.test(value || "") ? value : fallback;
  }

  function hexToRgba(hex, alpha) {
    const value = safeHex(hex, "#004353").slice(1);
    const number = parseInt(value, 16);
    const red = (number >> 16) & 255;
    const green = (number >> 8) & 255;
    const blue = number & 255;
    return "rgba(" + red + "," + green + "," + blue + "," + alpha + ")";
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null && text !== "") node.textContent = text;
    return node;
  }

  function dots(list) {
    return (list || []).filter(Boolean).join("\u00A0·\u00A0");
  }

  function qrMarkup(text, ink, paper) {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const quiet = 2;
    const size = count + quiet * 2;
    let path = "";
    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) {
        if (qr.isDark(row, col)) path += "M" + (col + quiet) + " " + (row + quiet) + "h1v1h-1z";
      }
    }
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + " " + size +
      '" shape-rendering="crispEdges" role="img" aria-label="QR code">' +
      '<rect width="' + size + '" height="' + size + '" fill="' + paper + '"/>' +
      '<path d="' + path + '" fill="' + ink + '"/></svg>'
    );
  }

  function present(template, instance) {
    template = template || {};
    instance = instance || {};
    const back = template.back || {};
    const emergency = template.emergency || {};
    const statement = template.statement || {};
    const nfc = template.nfc || {};
    const layoutIn = template.layout || {};
    const layout = {
      show_client: layoutIn.show_client !== false,
      show_date: layoutIn.show_date !== false,
      show_statement: layoutIn.show_statement !== false,
      show_emergency: layoutIn.show_emergency !== false,
      show_nfc: layoutIn.show_nfc !== false,
      show_front_footer: layoutIn.show_front_footer !== false,
      show_table: layoutIn.show_table !== false,
      show_prepared: layoutIn.show_prepared !== false,
      show_followup: layoutIn.show_followup !== false,
      show_stamp: layoutIn.show_stamp !== false,
      show_qr: layoutIn.show_qr !== false,
      show_back_footer: layoutIn.show_back_footer !== false,
      qr_size: clamp(layoutIn.qr_size, 84, 140, 112),
      nfc_size: clamp(layoutIn.nfc_size, 64, 160, 76)
    };
    const themeIn = template.theme || {};
    const theme = {
      ink: safeHex(themeIn.ink, "#004353"),
      paper: safeHex(themeIn.paper, "#FBFAF2"),
      highlight: safeHex(themeIn.highlight, "#F5DCDE"),
      stamp: safeHex(themeIn.stamp, "#B95C6B"),
      bullseye: safeHex(themeIn.bullseye, "#EFAEB6")
    };
    let rows = (template.catalog || []).filter(function (row) { return row.on_card; }).map(function (row) {
      return { problem: row.problem, fix: row.fix };
    });
    if (instance.back_mode === "orders" && instance.order_rows && instance.order_rows.length) {
      rows = instance.order_rows.map(function (row) {
        return { problem: row.problem, fix: row.fix };
      });
    }
    const phone = (instance.phone_display || emergency.phone_display || "").trim();
    const prefix = back.ref_prefix || "AT-";
    return {
      theme: theme,
      layout: layout,
      business_name: template.business_name || "",
      form_code: template.form_code || "",
      est_line: template.est_line || "",
      letterhead_services: template.letterhead_services || [],
      client_label: template.client_label || "CLIENT (BUSINESS):",
      date_label: template.date_label || "DATE:",
      client_name: instance.client_name || "",
      card_date: instance.card_date || "",
      statement: {
        glyph: (statement.glyph || "IT").slice(0, 3),
        text: statement.text || "",
        sub: statement.sub || ""
      },
      emergency: {
        label: emergency.label || "SYSTEM DOWN?",
        instruction: emergency.instruction || "",
        phone: phone
      },
      nfc: { label: nfc.label || "TAP PHONE HERE", sub: nfc.sub || "" },
      services_strip: template.services_strip || [],
      back: {
        title: back.title || "SERVICE RECORD",
        subtitle: back.subtitle || "",
        ref_no: instance.ref_no || (prefix + "______"),
        rows: rows.slice(0, 4),
        prepared_label: template.prepared_label || "PREPARED FOR:",
        prepared_for: instance.prepared_for || "",
        followup_line: back.followup_line || "",
        stamp: back.stamp || "",
        qr_label: back.qr_label || "NO TAP? SCAN",
        footer: back.footer || ""
      },
      qr_text: instance.qr_text || ""
    };
  }

  function applyTheme(draft, theme) {
    draft.style.setProperty("--ink", theme.ink);
    draft.style.setProperty("--paper", theme.paper);
    draft.style.setProperty("--highlight", theme.highlight);
    draft.style.setProperty("--stamp", theme.stamp);
    draft.style.setProperty("--bullseye", theme.bullseye);
    draft.style.setProperty("--line", hexToRgba(theme.ink, 0.65));
    draft.style.setProperty("--line-soft", hexToRgba(theme.ink, 0.45));
    draft.style.setProperty("--rule-faint", hexToRgba(theme.ink, 0.08));
  }

  function addFooter(card, text, qrSize, showQr) {
    if (!text) return;
    const foot = el("div", "foot mono", text);
    if (showQr) {
      const pad = (qrSize + 18) + "px";
      foot.style.paddingRight = pad;
      foot.style.paddingLeft = pad;
    }
    card.appendChild(foot);
  }

  function renderFront(model) {
    const card = el("div", "card");
    const head = el("div", "head");
    const logo = el("div", "logo");
    const img = document.createElement("img");
    img.src = "/static/logo-mark.svg";
    img.alt = "";
    logo.appendChild(img);
    head.appendChild(logo);
    const titles = el("div");
    titles.appendChild(el("div", "name", model.business_name));
    titles.appendChild(el("div", "sub mono", dots(model.letterhead_services)));
    head.appendChild(titles);
    const form = el("div", "form mono");
    form.appendChild(document.createTextNode(model.form_code));
    form.appendChild(document.createElement("br"));
    form.appendChild(document.createTextNode(model.est_line));
    head.appendChild(form);
    card.appendChild(head);
    card.appendChild(el("div", "rule"));

    if (model.layout.show_client || model.layout.show_date) {
      const fields = el("div", "fields mono");
      if (model.layout.show_client) {
        fields.appendChild(el("span", "", model.client_label));
        fields.appendChild(el("span", "blank" + (model.client_name ? " filled" : ""), model.client_name));
      }
      if (model.layout.show_date) {
        fields.appendChild(el("span", "", model.date_label));
        const date = el("span", "blank" + (model.layout.show_client ? " date" : "") + (model.card_date ? " filled" : ""), model.card_date);
        fields.appendChild(date);
      }
      card.appendChild(fields);
    }

    if (model.layout.show_statement) {
      const row = el("div", "state-row");
      row.appendChild(el("div", "glyph", model.statement.glyph));
      const text = el("div", "statement", model.statement.text);
      if (model.statement.sub) text.appendChild(el("div", "subline mono", model.statement.sub));
      row.appendChild(text);
      card.appendChild(row);
    }

    if (model.layout.show_emergency || model.layout.show_nfc) {
      const mid = el("div", "midrow");
      if (model.layout.show_emergency) {
        const block = el("div", "emerg-block");
        const line = el("div", "emerg");
        const hl = el("span", "hl");
        hl.appendChild(el("b", "", model.emergency.label));
        line.appendChild(hl);
        block.appendChild(line);
        if (model.emergency.instruction) block.appendChild(el("div", "emerg-note mono", model.emergency.instruction));
        block.appendChild(el("div", "phone mono", model.emergency.phone || "\u00A0"));
        mid.appendChild(block);
      }
      if (model.layout.show_nfc) {
        const tap = el("div", "tap");
        const target = el("div", "target");
        target.style.width = model.layout.nfc_size + "px";
        target.style.height = model.layout.nfc_size + "px";
        tap.appendChild(target);
        const lab = el("div", "taplab mono");
        lab.appendChild(document.createTextNode(model.nfc.label));
        lab.appendChild(document.createElement("br"));
        lab.appendChild(document.createTextNode(model.nfc.sub));
        tap.appendChild(lab);
        mid.appendChild(tap);
      }
      card.appendChild(mid);
    }

    if (model.layout.show_front_footer) addFooter(card, dots(model.services_strip), 0, false);
    return card;
  }

  function renderBack(model) {
    const card = el("div", "card ruled");
    const head = el("div", "head");
    const titles = el("div");
    titles.appendChild(el("div", "name back-title", model.back.title));
    if (model.back.subtitle) titles.appendChild(el("div", "sub mono", model.back.subtitle));
    head.appendChild(titles);
    const form = el("div", "form mono");
    form.appendChild(document.createTextNode("REF NO."));
    form.appendChild(document.createElement("br"));
    form.appendChild(document.createTextNode(model.back.ref_no));
    head.appendChild(form);
    card.appendChild(head);

    if (model.layout.show_table && model.back.rows.length) {
      const table = document.createElement("table");
      table.className = "chart";
      if (model.layout.show_qr) table.style.paddingRight = Math.max(0, model.layout.qr_size - 72) + "px";
      model.back.rows.forEach(function (row) {
        const tr = document.createElement("tr");
        const problem = document.createElement("td");
        const box = el("span", "box");
        problem.appendChild(box);
        problem.appendChild(document.createTextNode(row.problem || ""));
        const fix = el("td", "fix", row.fix || "");
        tr.appendChild(problem);
        tr.appendChild(fix);
        table.appendChild(tr);
      });
      card.appendChild(table);
    }

    if (model.layout.show_prepared) {
      const fields = el("div", "fields mono");
      fields.style.marginTop = "14px";
      if (model.layout.show_qr) fields.style.maxWidth = "calc(100% - " + (model.layout.qr_size + 30) + "px)";
      else fields.style.maxWidth = "70%";
      fields.appendChild(el("span", "", model.back.prepared_label));
      fields.appendChild(el("span", "blank" + (model.back.prepared_for ? " filled" : ""), model.back.prepared_for));
      card.appendChild(fields);
    }

    if (model.layout.show_followup && model.back.followup_line) {
      const follow = el("div", "followup mono", model.back.followup_line);
      if (model.layout.show_qr) follow.style.maxWidth = "calc(100% - " + (model.layout.qr_size + 24) + "px)";
      card.appendChild(follow);
    }

    const qrSize = model.layout.qr_size;
    if (model.layout.show_stamp && model.back.stamp) {
      const stamp = el("div", "stamp mono", model.back.stamp);
      stamp.style.right = (model.layout.show_qr ? 22 + qrSize + 26 : 22) + "px";
      card.appendChild(stamp);
    }

    if (model.layout.show_qr) {
      const qr = el("div", "qr");
      qr.style.width = qrSize + "px";
      qr.style.height = qrSize + "px";
      qr.style.right = "22px";
      qr.style.bottom = "40px";
      if (model.qr_text) {
        try {
          qr.innerHTML = qrMarkup(model.qr_text, model.theme.ink, model.theme.paper);
        } catch (err) {
          qr.classList.add("qr-empty");
          qr.textContent = "QR";
        }
      } else {
        qr.classList.add("qr-empty");
        qr.textContent = "QR";
      }
      card.appendChild(qr);
      const lab = el("div", "qrlab mono", model.back.qr_label);
      lab.style.width = qrSize + "px";
      lab.style.right = "22px";
      card.appendChild(lab);
    }

    if (model.layout.show_back_footer) addFooter(card, model.back.footer, qrSize, model.layout.show_qr);
    return card;
  }

  function renderDraft(model, side) {
    const draft = el("div", "draft");
    applyTheme(draft, model.theme);
    draft.appendChild(side === "back" ? renderBack(model) : renderFront(model));
    return draft;
  }

  function mount(slot, model, side) {
    slot.innerHTML = "";
    slot.classList.add("fit-slot");
    slot.appendChild(renderDraft(model, side));
  }

  function fitSlot(slot) {
    const draft = slot.querySelector(".draft");
    if (!draft || slot.clientWidth < 20) return;
    draft.style.transform = "scale(" + (slot.clientWidth / DRAFT_W) + ")";
  }

  function fitAll() {
    document.querySelectorAll(".fit-slot").forEach(fitSlot);
  }

  return { present: present, mount: mount, fitSlot: fitSlot, fitAll: fitAll };
})();
