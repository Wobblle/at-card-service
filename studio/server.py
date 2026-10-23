#!/usr/bin/env python3
"""A.T. Card Studio.

    python studio/server.py

On this computer:  http://localhost:8734
On a phone:        the https address printed at startup (certificate warning once).
"""

from __future__ import annotations

import datetime
import json
import os
import re
import secrets
import shutil
import socket
import sqlite3
import ssl
import subprocess
import sys
import threading
import traceback
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent
PACKAGE = ROOT.parent
DATA = ROOT / "data"
DB_PATH = DATA / "at.db"
SCHEMA = ROOT / "schema.sql"
STATIC = ROOT / "static"
SEED_PATH = PACKAGE / "clients" / "asleepius-tech.json"

HTTP_PORT = 8734
HTTPS_PORT = 8735
ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
TOKEN_RE = re.compile(r"[A-Za-z0-9-]{4,32}")
KEY_RE = re.compile(r"^[a-z0-9-]{1,40}$")
HEX_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")

LOCK = threading.Lock()
CONN: sqlite3.Connection | None = None
HTTPS_OK = False
LAN_IP = "127.0.0.1"

THEME = {
    "ink": "#004353",
    "paper": "#FBFAF2",
    "highlight": "#F5DCDE",
    "stamp": "#B95C6B",
    "bullseye": "#EFAEB6",
}

LAYOUT = {
    "show_client": True,
    "show_date": True,
    "show_statement": True,
    "show_emergency": True,
    "show_nfc": True,
    "show_front_footer": True,
    "show_table": True,
    "show_prepared": True,
    "show_followup": True,
    "show_stamp": True,
    "show_qr": True,
    "show_back_footer": True,
    "qr_size": 112,
    "nfc_size": 76,
}


class StudioError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def lan_ip() -> str:
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
        sock.close()
        if ip and not ip.startswith("127."):
            return ip
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip and not ip.startswith("127."):
                return ip
    except OSError:
        pass
    return "127.0.0.1"


def find_openssl() -> Path | None:
    for candidate in (
        Path(r"C:\Program Files\Git\usr\bin\openssl.exe"),
        Path(r"C:\Program Files (x86)\Git\usr\bin\openssl.exe"),
    ):
        if candidate.exists():
            return candidate
    found = shutil.which("openssl")
    return Path(found) if found else None


def ensure_cert(ip: str) -> bool:
    cert = DATA / "cert.pem"
    key = DATA / "key.pem"
    stamp = DATA / "cert-ip.txt"
    if cert.exists() and key.exists() and stamp.exists() and stamp.read_text(encoding="utf-8").strip() == ip:
        return True
    openssl = find_openssl()
    if openssl is None:
        print("OpenSSL was not found. The phone link will stay on http, so NFC write stays off.", flush=True)
        return False
    ips = ["127.0.0.1"]
    if ip not in ips:
        ips.append(ip)
    san = "subjectAltName=" + ",".join(["DNS:localhost"] + [f"IP:{item}" for item in ips])
    env = os.environ.copy()
    env["MSYS_NO_PATHCONV"] = "1"
    result = subprocess.run(
        [
            str(openssl), "req", "-x509", "-newkey", "rsa:2048", "-sha256",
            "-days", "825", "-nodes",
            "-keyout", str(key), "-out", str(cert),
            "-subj", "/CN=localhost",
            "-addext", san,
        ],
        capture_output=True, text=True, env=env,
    )
    if result.returncode != 0:
        print(result.stderr.strip() or "Could not create the phone certificate.", flush=True)
        return False
    stamp.write_text(ip, encoding="utf-8")
    return True


@contextmanager
def db_session():
    if CONN is None:
        raise StudioError("Database is not open", 500)
    with LOCK:
        try:
            yield CONN
            CONN.commit()
        except Exception:
            CONN.rollback()
            raise


def init_db() -> None:
    global CONN
    DATA.mkdir(parents=True, exist_ok=True)
    CONN = sqlite3.connect(DB_PATH, check_same_thread=False)
    CONN.row_factory = sqlite3.Row
    CONN.execute("PRAGMA foreign_keys = ON")
    CONN.execute("PRAGMA journal_mode = WAL")
    CONN.executescript(SCHEMA.read_text(encoding="utf-8"))
    CONN.execute("PRAGMA user_version = 1")
    if CONN.execute("SELECT COUNT(*) AS c FROM templates").fetchone()["c"] == 0:
        data = default_template()
        CONN.execute(
            "INSERT INTO templates (id, name, data, updated_at) VALUES (1, ?, ?, ?)",
            (data["business_name"], json.dumps(data, ensure_ascii=False), now_iso()),
        )
        replace_catalog(CONN, data["catalog"])
    if CONN.execute("SELECT 1 FROM settings WHERE key = 'studio_key'").fetchone() is None:
        CONN.execute(
            "INSERT INTO settings (key, value) VALUES ('studio_key', ?)",
            (secrets.token_hex(4),),
        )
    if CONN.execute("SELECT 1 FROM settings WHERE key = 'public_base_url'").fetchone() is None:
        CONN.execute("INSERT INTO settings (key, value) VALUES ('public_base_url', '')")
    if CONN.execute("SELECT 1 FROM settings WHERE key = 'next_ref'").fetchone() is None:
        CONN.execute("INSERT INTO settings (key, value) VALUES ('next_ref', '1')")
    CONN.commit()


def setting(conn: sqlite3.Connection, key: str) -> str:
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return "" if row is None else row["value"]


def suggested_base() -> str:
    if HTTPS_OK and LAN_IP != "127.0.0.1":
        return f"https://{LAN_IP}:{HTTPS_PORT}"
    if LAN_IP != "127.0.0.1":
        return f"http://{LAN_IP}:{HTTP_PORT}"
    return f"http://127.0.0.1:{HTTP_PORT}"


def resolved_base(conn: sqlite3.Connection) -> str:
    stored = setting(conn, "public_base_url").strip().rstrip("/")
    return stored or suggested_base()


def clean_text(value, limit: int, label: str, allow_empty: bool = False, multiline: bool = False) -> str:
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise StudioError(f"{label} needs to be text.")
    value = value.replace("\r\n", "\n").strip()
    if not multiline:
        value = " ".join(value.split())
    if any(ord(ch) < 32 and ch not in "\n\t" for ch in value):
        raise StudioError(f"{label} has a character the card cannot print.")
    if len(value) > limit:
        raise StudioError(f"{label} is too long (max {limit}).")
    if not value and not allow_empty:
        raise StudioError(f"{label} is required.")
    return value


def clean_bool(value, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    raise StudioError("A layout switch was not yes or no.")


def clamp_int(value, low: int, high: int, default: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        try:
            value = int(value)
        except (TypeError, ValueError):
            return default
    return max(low, min(high, value))


def default_template() -> dict:
    raw = json.loads(SEED_PATH.read_text(encoding="utf-8"))
    catalog = []
    for index, row in enumerate(raw["back"]["rows"]):
        catalog.append({
            "key": f"std-{index + 1}",
            "problem": row["problem"],
            "fix": row["fix"],
            "on_card": True,
        })
    return normalize_template({
        "business_name": raw["business_name"],
        "client_id": raw["client_id"],
        "form_code": raw["form_code"],
        "est_line": raw["est_line"],
        "letterhead_services": raw["letterhead_services"],
        "client_label": "CLIENT (BUSINESS):",
        "date_label": "DATE:",
        "prepared_label": "PREPARED FOR:",
        "statement": raw["statement"],
        "emergency": raw["emergency"],
        "nfc": {"label": raw["nfc"]["label"], "sub": raw["nfc"]["sub"]},
        "services_strip": raw["services_strip"],
        "back": {
            "title": raw["back"]["title"],
            "subtitle": raw["back"]["subtitle"],
            "ref_prefix": raw["back"]["ref_prefix"],
            "followup_line": raw["back"]["followup_line"],
            "footer": raw["back"]["footer"],
            "stamp": raw["back"]["stamp"],
            "qr_label": raw["back"]["qr_label"],
        },
        "layout": dict(LAYOUT),
        "catalog": catalog,
        "theme": raw.get("theme") or dict(THEME),
    })


def normalize_template(data: dict) -> dict:
    if not isinstance(data, dict):
        raise StudioError("The design needs to be a form.")
    theme_in = data.get("theme") if isinstance(data.get("theme"), dict) else {}
    theme = dict(THEME)
    for key in THEME:
        value = theme_in.get(key)
        if isinstance(value, str) and HEX_RE.match(value):
            theme[key] = value.upper() if value[1:].isupper() else value

    layout_in = data.get("layout") if isinstance(data.get("layout"), dict) else {}
    layout = dict(LAYOUT)
    for key, default in LAYOUT.items():
        if key in ("qr_size", "nfc_size"):
            continue
        layout[key] = clean_bool(layout_in.get(key), default)
    layout["qr_size"] = clamp_int(layout_in.get("qr_size"), 84, 140, LAYOUT["qr_size"])
    layout["nfc_size"] = clamp_int(layout_in.get("nfc_size"), 64, 160, LAYOUT["nfc_size"])

    services = data.get("letterhead_services") or []
    if not isinstance(services, list):
        raise StudioError("Letterhead services need to be a list.")
    letterhead = []
    for item in services[:4]:
        text = clean_text(item, 28, "Letterhead service", allow_empty=True)
        if text:
            letterhead.append(text)

    strip = data.get("services_strip") or []
    if not isinstance(strip, list):
        raise StudioError("Footer services need to be a list.")
    services_strip = []
    for item in strip[:8]:
        text = clean_text(item, 22, "Footer service", allow_empty=True)
        if text:
            services_strip.append(text)

    catalog_in = data.get("catalog") or []
    if not isinstance(catalog_in, list):
        raise StudioError("Standard orders need to be a list.")
    if len(catalog_in) > 24:
        raise StudioError("Keep the standard list to 24 orders.")
    catalog = []
    seen = set()
    on_card = 0
    for item in catalog_in:
        if not isinstance(item, dict):
            continue
        problem = clean_text(item.get("problem"), 80, "Standard order", allow_empty=True)
        fix = clean_text(item.get("fix"), 72, "Standard fix", allow_empty=True)
        if not problem:
            continue
        key = str(item.get("key") or "")
        if not KEY_RE.match(key) or key in seen:
            key = "s" + secrets.token_hex(3)
        seen.add(key)
        printed = clean_bool(item.get("on_card"), False)
        if printed:
            on_card += 1
        catalog.append({"key": key, "problem": problem, "fix": fix, "on_card": printed})
    if on_card > 4:
        raise StudioError("The back of the card fits 4 printed rows. Leave the extras off the card. They can still be standard orders.")

    statement = data.get("statement") if isinstance(data.get("statement"), dict) else {}
    emergency = data.get("emergency") if isinstance(data.get("emergency"), dict) else {}
    nfc = data.get("nfc") if isinstance(data.get("nfc"), dict) else {}
    back = data.get("back") if isinstance(data.get("back"), dict) else {}
    prefix = clean_text(back.get("ref_prefix") or "AT-", 8, "Ref prefix", allow_empty=True).upper()
    prefix = re.sub(r"[^A-Z0-9-]", "", prefix) or "AT-"

    return {
        "business_name": clean_text(data.get("business_name"), 40, "Business name"),
        "client_id": clean_text(data.get("client_id") or "asleepius-tech", 40, "Client id"),
        "form_code": clean_text(data.get("form_code"), 24, "Form code", allow_empty=True),
        "est_line": clean_text(data.get("est_line"), 24, "Est line", allow_empty=True),
        "letterhead_services": letterhead,
        "client_label": clean_text(data.get("client_label") or "CLIENT (BUSINESS):", 40, "Client label"),
        "date_label": clean_text(data.get("date_label") or "DATE:", 24, "Date label"),
        "prepared_label": clean_text(data.get("prepared_label") or "PREPARED FOR:", 32, "Prepared label"),
        "statement": {
            "glyph": clean_text(statement.get("glyph") or "IT", 3, "Glyph").upper(),
            "text": clean_text(statement.get("text"), 280, "Statement", allow_empty=True),
            "sub": clean_text(statement.get("sub"), 140, "Statement line", allow_empty=True),
        },
        "emergency": {
            "label": clean_text(emergency.get("label") or "SYSTEM DOWN?", 32, "Emergency label"),
            "instruction": clean_text(emergency.get("instruction") or "CALL OR TEXT, ANY HOUR:", 48, "Emergency line"),
            "phone_display": clean_text(emergency.get("phone_display"), 32, "Phone", allow_empty=True),
        },
        "nfc": {
            "label": clean_text(nfc.get("label") or "TAP PHONE HERE", 32, "NFC label"),
            "sub": clean_text(nfc.get("sub") or "YOUR SERVICE PACKAGE IS ON THIS CARD", 64, "NFC line"),
        },
        "services_strip": services_strip,
        "back": {
            "title": clean_text(back.get("title") or "SERVICE RECORD", 32, "Back title"),
            "subtitle": clean_text(back.get("subtitle"), 80, "Back subtitle", allow_empty=True),
            "ref_prefix": prefix,
            "followup_line": clean_text(back.get("followup_line"), 90, "Follow-up line", allow_empty=True),
            "footer": clean_text(back.get("footer"), 72, "Back footer", allow_empty=True),
            "stamp": clean_text(back.get("stamp"), 32, "Stamp", allow_empty=True),
            "qr_label": clean_text(back.get("qr_label") or "NO TAP? SCAN", 24, "QR label"),
        },
        "layout": layout,
        "catalog": catalog,
        "theme": theme,
    }


def replace_catalog(conn: sqlite3.Connection, catalog: list) -> None:
    conn.execute("DELETE FROM service_catalog")
    for index, row in enumerate(catalog):
        conn.execute(
            "INSERT INTO service_catalog (key, problem, fix, on_card, sort_order) VALUES (?, ?, ?, ?, ?)",
            (row["key"], row["problem"], row["fix"], 1 if row["on_card"] else 0, index),
        )


def load_template(conn: sqlite3.Connection) -> dict:
    row = conn.execute("SELECT data FROM templates WHERE id = 1").fetchone()
    if row is None:
        return default_template()
    return json.loads(row["data"])


def save_template(conn: sqlite3.Connection, data: dict) -> dict:
    data = normalize_template(data)
    payload = json.dumps(data, ensure_ascii=False)
    updated = now_iso()
    if conn.execute("SELECT 1 FROM templates WHERE id = 1").fetchone():
        conn.execute(
            "UPDATE templates SET name = ?, data = ?, updated_at = ? WHERE id = 1",
            (data["business_name"], payload, updated),
        )
    else:
        conn.execute(
            "INSERT INTO templates (id, name, data, updated_at) VALUES (1, ?, ?, ?)",
            (data["business_name"], payload, updated),
        )
    replace_catalog(conn, data["catalog"])
    return data


def live_catalog(conn: sqlite3.Connection) -> list:
    rows = conn.execute(
        "SELECT key, problem, fix, on_card FROM service_catalog ORDER BY sort_order, key"
    ).fetchall()
    return [
        {"key": row["key"], "problem": row["problem"], "fix": row["fix"], "on_card": bool(row["on_card"])}
        for row in rows
    ]


def studio_key(conn: sqlite3.Connection) -> str:
    return setting(conn, "studio_key")


def keys_match(got: str, expected: str) -> bool:
    if not got or not expected or len(got) != len(expected):
        return False
    return secrets.compare_digest(got, expected)


def new_code(conn: sqlite3.Connection) -> str:
    for _ in range(30):
        code = "".join(secrets.choice(ALPHABET) for _ in range(8))
        if conn.execute("SELECT 1 FROM cards WHERE public_code = ?", (code,)).fetchone() is None:
            return code
    raise StudioError("Could not mint a card code.", 500)


def allocate_ref(conn: sqlite3.Connection, prefix: str) -> str:
    number = int(setting(conn, "next_ref") or "1")
    while True:
        ref = f"{prefix}{number:06d}"
        if conn.execute("SELECT 1 FROM cards WHERE ref_no = ?", (ref,)).fetchone() is None:
            break
        number += 1
    conn.execute("UPDATE settings SET value = ? WHERE key = 'next_ref'", (str(number + 1),))
    return ref


def add_event(conn: sqlite3.Connection, card_id: int, kind: str, detail: str = "") -> None:
    conn.execute(
        "INSERT INTO card_events (card_id, kind, detail, created_at) VALUES (?, ?, ?, ?)",
        (card_id, kind, detail[:200], now_iso()),
    )


def orders_for(conn: sqlite3.Connection, card_id: int) -> list:
    rows = conn.execute(
        "SELECT kind, catalog_key, problem, fix, notes FROM work_orders WHERE card_id = ? ORDER BY sort_order, id",
        (card_id,),
    ).fetchall()
    return [
        {
            "kind": row["kind"],
            "catalog_key": row["catalog_key"] or "",
            "problem": row["problem"],
            "fix": row["fix"],
            "notes": row["notes"],
        }
        for row in rows
    ]


def order_count(conn: sqlite3.Connection, card_id: int) -> int:
    return conn.execute("SELECT COUNT(*) AS c FROM work_orders WHERE card_id = ?", (card_id,)).fetchone()["c"]


def recompute_status(row: sqlite3.Row, count: int) -> str:
    if row["loaded_at"]:
        return "loaded"
    if row["client_name"] or row["prepared_for"] or row["card_date"] or row["phone_display"] or row["notes"] or count:
        return "in_progress"
    if row["printed_at"]:
        return "printed"
    return "new"


def phone_effective(row: sqlite3.Row, snapshot: dict) -> str:
    if row["phone_display"]:
        return row["phone_display"]
    emergency = snapshot.get("emergency") or {}
    return emergency.get("phone_display") or ""


def card_link(row: sqlite3.Row) -> str:
    return row["link_base"].rstrip("/") + "/c/" + row["public_code"]


def brief(conn: sqlite3.Connection, row: sqlite3.Row) -> dict:
    count = order_count(conn, row["id"])
    return {
        "ref_no": row["ref_no"],
        "public_code": row["public_code"],
        "status": row["status"],
        "client_name": row["client_name"],
        "printed_at": row["printed_at"],
        "loaded_at": row["loaded_at"],
        "nfc_uid": row["nfc_uid"],
        "nfc_written_at": row["nfc_written_at"],
        "qr_confirmed_at": row["qr_confirmed_at"],
        "order_count": count,
        "link": card_link(row),
        "created_at": row["created_at"],
    }


def card_out(conn: sqlite3.Connection, row: sqlite3.Row) -> dict:
    snapshot = json.loads(row["snapshot"])
    events = conn.execute(
        "SELECT kind, detail, created_at FROM card_events WHERE card_id = ? ORDER BY id DESC LIMIT 20",
        (row["id"],),
    ).fetchall()
    return {
        "ref_no": row["ref_no"],
        "public_code": row["public_code"],
        "status": row["status"],
        "client_name": row["client_name"],
        "prepared_for": row["prepared_for"],
        "card_date": row["card_date"],
        "phone_display": row["phone_display"],
        "phone_effective": phone_effective(row, snapshot),
        "notes": row["notes"],
        "back_mode": row["back_mode"],
        "link_base": row["link_base"],
        "link": card_link(row),
        "nfc_uid": row["nfc_uid"],
        "nfc_written_at": row["nfc_written_at"],
        "qr_confirmed_at": row["qr_confirmed_at"],
        "printed_at": row["printed_at"],
        "loaded_at": row["loaded_at"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "snapshot": snapshot,
        "orders": orders_for(conn, row["id"]),
        "events": [{"kind": event["kind"], "detail": event["detail"], "created_at": event["created_at"]} for event in events],
        "catalog": live_catalog(conn),
    }


def find_card(conn: sqlite3.Connection, token: str) -> sqlite3.Row:
    token = unquote(token).strip().upper()
    if not TOKEN_RE.fullmatch(token):
        raise StudioError("That card id is not valid.", 404)
    row = conn.execute(
        "SELECT * FROM cards WHERE public_code = ? OR ref_no = ?",
        (token, token),
    ).fetchone()
    if row is None:
        raise StudioError("No card with that code.", 404)
    return row


def touch_status(conn: sqlite3.Connection, card_id: int) -> None:
    row = conn.execute("SELECT * FROM cards WHERE id = ?", (card_id,)).fetchone()
    status = recompute_status(row, order_count(conn, card_id))
    conn.execute(
        "UPDATE cards SET status = ?, updated_at = ? WHERE id = ?",
        (status, now_iso(), card_id),
    )


def clean_orders(items) -> list:
    if not isinstance(items, list):
        raise StudioError("Work orders need to be a list.")
    if len(items) > 20:
        raise StudioError("A card holds up to 20 work orders. The printed back shows the first 4.")
    cleaned = []
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise StudioError("A work order was incomplete.")
        kind = item.get("kind")
        if kind not in ("standard", "custom"):
            raise StudioError("Each work order is standard or custom.")
        label = f"Order {index + 1}"
        problem = clean_text(item.get("problem"), 80, label, allow_empty=True)
        fix = clean_text(item.get("fix"), 72, label + " fix", allow_empty=True)
        notes = clean_text(item.get("notes") or "", 200, "Order note", allow_empty=True)
        if not problem:
            continue
        catalog_key = ""
        if kind == "standard":
            catalog_key = str(item.get("catalog_key") or "")
            if catalog_key and not KEY_RE.match(catalog_key):
                catalog_key = ""
        cleaned.append({
            "kind": kind,
            "catalog_key": catalog_key,
            "problem": problem,
            "fix": fix,
            "notes": notes,
        })
    return cleaned


def replace_orders(conn: sqlite3.Connection, card_id: int, orders: list) -> None:
    conn.execute("DELETE FROM work_orders WHERE card_id = ?", (card_id,))
    created = now_iso()
    for index, order in enumerate(orders):
        conn.execute(
            """INSERT INTO work_orders
               (card_id, kind, catalog_key, problem, fix, notes, sort_order, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (card_id, order["kind"], order["catalog_key"] or None, order["problem"], order["fix"], order["notes"], index, created),
        )


def settings_out(conn: sqlite3.Connection) -> dict:
    return {
        "public_base_url": setting(conn, "public_base_url"),
        "resolved_base": resolved_base(conn),
        "suggested_base": suggested_base(),
        "https": HTTPS_OK,
        "lan_ip": LAN_IP,
    }


def clean_base(value: str) -> str:
    value = clean_text(value, 200, "Card link", allow_empty=True)
    if not value:
        return ""
    if not (value.startswith("http://") or value.startswith("https://")):
        raise StudioError("The card link starts with http:// or https://")
    if " " in value:
        raise StudioError("The card link cannot contain a space.")
    return value.rstrip("/")


def scan_matches(scanned: str, row: sqlite3.Row) -> bool:
    raw = (scanned or "").strip()
    if not raw:
        return False
    upper = raw.upper()
    if upper == row["public_code"] or upper == row["ref_no"]:
        return True
    parsed = urlparse(raw)
    if parsed.scheme and parsed.path:
        segment = [part for part in parsed.path.split("/") if part]
        if segment and segment[-1].upper() == row["public_code"]:
            return True
    return False


class StudioServer(ThreadingHTTPServer):
    allow_reuse_address = True


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def do_GET(self) -> None:
        self.dispatch()

    def do_POST(self) -> None:
        self.dispatch()

    def do_PUT(self) -> None:
        self.dispatch()

    def do_PATCH(self) -> None:
        self.dispatch()

    def do_DELETE(self) -> None:
        self.dispatch()

    def dispatch(self) -> None:
        try:
            self.route()
        except StudioError as exc:
            self.send_json(exc.status, {"error": str(exc)})
        except Exception:
            traceback.print_exc()
            self.send_json(500, {"error": "The studio hit an error. The details are in the server window."})

    def route(self) -> None:
        path = urlparse(self.path).path
        method = self.command
        if method == "GET" and (path == "/" or path == "/print" or path.startswith("/c/") or path == "/c"):
            self.serve_index()
            return
        if method == "GET" and path.startswith("/static/"):
            self.serve_static(path)
            return
        if path == "/api/bootstrap" and method == "GET":
            self.bootstrap()
            return
        if path == "/api/unlock" and method == "POST":
            self.unlock()
            return
        if path == "/api/template" and method == "PUT":
            self.require_key()
            self.put_template()
            return
        if path == "/api/template/restore" and method == "POST":
            self.require_key()
            self.restore_template()
            return
        if path == "/api/settings" and method == "PUT":
            self.require_key()
            self.put_settings()
            return
        if path == "/api/cards" and method == "GET":
            self.require_key()
            self.list_cards()
            return
        if path == "/api/cards/batch" and method == "POST":
            self.require_key()
            self.batch_cards()
            return
        if path == "/api/cards/printed" and method == "POST":
            self.require_key()
            self.mark_printed()
            return
        public = re.fullmatch(r"/api/p/([^/]+)", path)
        if public and method == "GET":
            self.public_card(public.group(1))
            return
        action = re.fullmatch(r"/api/cards/([^/]+)/(orders|confirm-qr|bind-nfc|load|refresh-design)", path)
        if action:
            self.require_key()
            token, name = action.group(1), action.group(2)
            if name == "orders" and method == "PUT":
                self.put_orders(token)
                return
            if name == "confirm-qr" and method == "POST":
                self.confirm_qr(token)
                return
            if name == "bind-nfc" and method == "POST":
                self.bind_nfc(token)
                return
            if name == "load" and method == "POST":
                self.load_card(token)
                return
            if name == "refresh-design" and method == "POST":
                self.refresh_design(token)
                return
        single = re.fullmatch(r"/api/cards/([^/]+)", path)
        if single:
            self.require_key()
            token = single.group(1)
            if method == "GET":
                self.get_card(token)
                return
            if method == "PATCH":
                self.patch_card(token)
                return
            if method == "DELETE":
                self.delete_card(token)
                return
        self.send_json(404, {"error": "Not found"})

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length > 1_000_000:
            raise StudioError("That upload is too large.")
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}
        try:
            data = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise StudioError("The studio could not read that form.") from exc
        if not isinstance(data, dict):
            raise StudioError("The studio could not read that form.")
        return data

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def require_key(self) -> None:
        with db_session() as conn:
            expected = studio_key(conn)
        got = self.headers.get("X-Studio-Key", "")
        if not keys_match(got, expected):
            raise StudioError("Studio key required.", 401)

    def client_is_local(self) -> bool:
        return self.client_address[0] in ("127.0.0.1", "::1")

    def bootstrap(self) -> None:
        with db_session() as conn:
            key = studio_key(conn)
            allowed = self.client_is_local() or keys_match(self.headers.get("X-Studio-Key", ""), key)
            self.send_json(200, {
                "studio_key": key if allowed else None,
                "needs_key": not allowed,
                "template": load_template(conn),
                "settings": settings_out(conn),
            })

    def unlock(self) -> None:
        body = self.read_json()
        with db_session() as conn:
            key = studio_key(conn)
        if keys_match(str(body.get("key") or ""), key):
            self.send_json(200, {"ok": True, "studio_key": key})
            return
        self.send_json(401, {"error": "That key does not match."})

    def put_template(self) -> None:
        data = self.read_json()
        with db_session() as conn:
            saved = save_template(conn, data)
        self.send_json(200, {"template": saved})

    def restore_template(self) -> None:
        with db_session() as conn:
            saved = save_template(conn, default_template())
        self.send_json(200, {"template": saved})

    def put_settings(self) -> None:
        body = self.read_json()
        base = clean_base(str(body.get("public_base_url") or ""))
        with db_session() as conn:
            conn.execute("UPDATE settings SET value = ? WHERE key = 'public_base_url'", (base,))
            payload = settings_out(conn)
        self.send_json(200, {"settings": payload})

    def list_cards(self) -> None:
        with db_session() as conn:
            rows = conn.execute("SELECT * FROM cards ORDER BY ref_no").fetchall()
            cards = [brief(conn, row) for row in rows]
        self.send_json(200, {"cards": cards})

    def batch_cards(self) -> None:
        body = self.read_json()
        count = body.get("count")
        if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= 24:
            raise StudioError("Make between 1 and 24 cards at a time.")
        made = []
        with db_session() as conn:
            template = load_template(conn)
            base = resolved_base(conn)
            prefix = template["back"]["ref_prefix"]
            snapshot = json.dumps(template, ensure_ascii=False)
            created = now_iso()
            for _ in range(count):
                ref = allocate_ref(conn, prefix)
                code = new_code(conn)
                conn.execute(
                    """INSERT INTO cards (
                        public_code, ref_no, template_id, snapshot, status, link_base, created_at, updated_at
                    ) VALUES (?, ?, 1, ?, 'new', ?, ?, ?)""",
                    (code, ref, snapshot, base, created, created),
                )
                card_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
                add_event(conn, card_id, "minted", ref)
                row = conn.execute("SELECT * FROM cards WHERE id = ?", (card_id,)).fetchone()
                made.append(brief(conn, row))
        self.send_json(200, {"cards": made})

    def mark_printed(self) -> None:
        body = self.read_json()
        refs = body.get("refs")
        if not isinstance(refs, list) or not refs:
            raise StudioError("Choose the cards you printed.")
        updated = []
        with db_session() as conn:
            for ref in refs[:48]:
                row = find_card(conn, str(ref))
                if not row["printed_at"]:
                    conn.execute(
                        "UPDATE cards SET printed_at = ?, updated_at = ? WHERE id = ?",
                        (now_iso(), now_iso(), row["id"]),
                    )
                    add_event(conn, row["id"], "printed", row["ref_no"])
                    touch_status(conn, row["id"])
                fresh = conn.execute("SELECT * FROM cards WHERE id = ?", (row["id"],)).fetchone()
                updated.append(brief(conn, fresh))
        self.send_json(200, {"cards": updated})

    def get_card(self, token: str) -> None:
        with db_session() as conn:
            row = find_card(conn, token)
            payload = card_out(conn, row)
        self.send_json(200, {"card": payload})

    def patch_card(self, token: str) -> None:
        body = self.read_json()
        with db_session() as conn:
            row = find_card(conn, token)
            client_name = clean_text(body.get("client_name", row["client_name"]), 48, "Client", allow_empty=True)
            prepared = clean_text(body.get("prepared_for", row["prepared_for"]), 48, "Prepared for", allow_empty=True)
            card_date = clean_text(body.get("card_date", row["card_date"]), 24, "Date", allow_empty=True)
            phone = clean_text(body.get("phone_display", row["phone_display"]), 32, "Phone", allow_empty=True)
            notes = clean_text(body.get("notes", row["notes"]), 400, "Shop note", allow_empty=True, multiline=True)
            back_mode = body.get("back_mode", row["back_mode"])
            if back_mode not in ("menu", "orders"):
                raise StudioError("The back is either the menu or this job.")
            snapshot = json.loads(row["snapshot"])
            template_phone = (snapshot.get("emergency") or {}).get("phone_display") or ""
            if phone == template_phone:
                phone = ""
            conn.execute(
                """UPDATE cards SET client_name = ?, prepared_for = ?, card_date = ?, phone_display = ?,
                   notes = ?, back_mode = ?, updated_at = ? WHERE id = ?""",
                (client_name, prepared, card_date, phone, notes, back_mode, now_iso(), row["id"]),
            )
            add_event(conn, row["id"], "edited", client_name)
            touch_status(conn, row["id"])
            fresh = conn.execute("SELECT * FROM cards WHERE id = ?", (row["id"],)).fetchone()
            payload = card_out(conn, fresh)
        self.send_json(200, {"card": payload})

    def delete_card(self, token: str) -> None:
        with db_session() as conn:
            row = find_card(conn, token)
            if row["loaded_at"]:
                raise StudioError("This card is loaded. The sticker still opens it, so the record stays.")
            conn.execute("DELETE FROM cards WHERE id = ?", (row["id"],))
        self.send_json(200, {"ok": True})

    def put_orders(self, token: str) -> None:
        body = self.read_json()
        orders = clean_orders(body.get("orders"))
        with db_session() as conn:
            row = find_card(conn, token)
            replace_orders(conn, row["id"], orders)
            add_event(conn, row["id"], "orders_saved", f"{len(orders)} orders")
            touch_status(conn, row["id"])
            fresh = conn.execute("SELECT * FROM cards WHERE id = ?", (row["id"],)).fetchone()
            payload = card_out(conn, fresh)
        self.send_json(200, {"card": payload})

    def confirm_qr(self, token: str) -> None:
        body = self.read_json()
        with db_session() as conn:
            row = find_card(conn, token)
            if not scan_matches(str(body.get("scanned") or ""), row):
                raise StudioError("That scan belongs to a different card.")
            if not row["qr_confirmed_at"]:
                conn.execute(
                    "UPDATE cards SET qr_confirmed_at = ?, updated_at = ? WHERE id = ?",
                    (now_iso(), now_iso(), row["id"]),
                )
                add_event(conn, row["id"], "qr_confirmed", row["ref_no"])
            fresh = conn.execute("SELECT * FROM cards WHERE id = ?", (row["id"],)).fetchone()
            payload = card_out(conn, fresh)
        self.send_json(200, {"card": payload})

    def bind_nfc(self, token: str) -> None:
        body = self.read_json()
        uid = clean_text(str(body.get("uid") or ""), 64, "NFC id", allow_empty=True).upper()
        written = bool(body.get("written"))
        if uid and not re.fullmatch(r"[0-9A-F:.\- ]{4,64}", uid):
            raise StudioError("The NFC id should be the sticker's hex serial.")
        if not uid and not written:
            raise StudioError("Scan the sticker, or mark that the link was written.")
        with db_session() as conn:
            row = find_card(conn, token)
            conn.execute(
                "UPDATE cards SET nfc_uid = ?, nfc_written_at = ?, updated_at = ? WHERE id = ?",
                (uid, now_iso(), now_iso(), row["id"]),
            )
            add_event(conn, row["id"], "nfc_bound", uid or "written")
            fresh = conn.execute("SELECT * FROM cards WHERE id = ?", (row["id"],)).fetchone()
            payload = card_out(conn, fresh)
        self.send_json(200, {"card": payload})

    def load_card(self, token: str) -> None:
        body = self.read_json()
        with db_session() as conn:
            row = find_card(conn, token)
            count = order_count(conn, row["id"])
            if count < 1:
                raise StudioError("Add a work order before loading this card.")
            if not row["qr_confirmed_at"] and not body.get("skip_qr"):
                raise StudioError("Scan the QR on this card before loading it.")
            if not row["loaded_at"]:
                detail = "Loaded."
                if not row["nfc_written_at"]:
                    detail = "Loaded without a sticker."
                conn.execute(
                    "UPDATE cards SET loaded_at = ?, updated_at = ? WHERE id = ?",
                    (now_iso(), now_iso(), row["id"]),
                )
                add_event(conn, row["id"], "loaded", detail)
            touch_status(conn, row["id"])
            fresh = conn.execute("SELECT * FROM cards WHERE id = ?", (row["id"],)).fetchone()
            payload = card_out(conn, fresh)
        self.send_json(200, {"card": payload})

    def refresh_design(self, token: str) -> None:
        with db_session() as conn:
            row = find_card(conn, token)
            template = load_template(conn)
            conn.execute(
                "UPDATE cards SET snapshot = ?, updated_at = ? WHERE id = ?",
                (json.dumps(template, ensure_ascii=False), now_iso(), row["id"]),
            )
            add_event(conn, row["id"], "design_refreshed", "snapshot")
            fresh = conn.execute("SELECT * FROM cards WHERE id = ?", (row["id"],)).fetchone()
            payload = card_out(conn, fresh)
        self.send_json(200, {"card": payload})

    def public_card(self, token: str) -> None:
        with db_session() as conn:
            row = find_card(conn, token)
            snapshot = json.loads(row["snapshot"])
            if not row["loaded_at"]:
                self.send_json(200, {
                    "activated": False,
                    "ref_no": row["ref_no"],
                    "public_code": row["public_code"],
                    "business_name": snapshot.get("business_name") or "",
                })
                return
            emergency = snapshot.get("emergency") or {}
            back = snapshot.get("back") or {}
            self.send_json(200, {
                "activated": True,
                "ref_no": row["ref_no"],
                "public_code": row["public_code"],
                "business_name": snapshot.get("business_name") or "",
                "client_name": row["client_name"],
                "prepared_for": row["prepared_for"],
                "card_date": row["card_date"],
                "phone_display": phone_effective(row, snapshot),
                "emergency_label": emergency.get("label") or "SYSTEM DOWN?",
                "emergency_instruction": emergency.get("instruction") or "CALL OR TEXT, ANY HOUR:",
                "followup_line": back.get("followup_line") or "",
                "slogan": "WE HEAL TECH",
                "orders": [
                    {"kind": order["kind"], "problem": order["problem"], "fix": order["fix"]}
                    for order in orders_for(conn, row["id"])
                ],
                "loaded_at": row["loaded_at"],
            })

    def serve_index(self) -> None:
        self.serve_file(STATIC / "index.html")

    def serve_static(self, path: str) -> None:
        rel = unquote(path[len("/static/"):])
        target = (STATIC / rel).resolve()
        if not target.is_relative_to(STATIC.resolve()) or not target.is_file():
            self.send_json(404, {"error": "Not found"})
            return
        self.serve_file(target)

    def serve_file(self, path: Path) -> None:
        types = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".svg": "image/svg+xml",
            ".json": "application/json; charset=utf-8",
        }
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", types.get(path.suffix.lower(), "application/octet-stream"))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    global HTTPS_OK, LAN_IP
    init_db()
    LAN_IP = lan_ip()
    HTTPS_OK = ensure_cert(LAN_IP)
    with db_session() as conn:
        key = studio_key(conn)
        base = resolved_base(conn)
    httpd = StudioServer(("0.0.0.0", HTTP_PORT), Handler)
    print("", flush=True)
    print("A.T. Card Studio", flush=True)
    print(f"  On this computer:  http://localhost:{HTTP_PORT}", flush=True)
    if HTTPS_OK and LAN_IP != "127.0.0.1":
        print(f"  On your phone:     https://{LAN_IP}:{HTTPS_PORT}", flush=True)
        print("  Accept the certificate warning once. After that, the camera and NFC sticker work.", flush=True)
    else:
        print(f"  Card links use:    {base}", flush=True)
        print("  Phone NFC needs the https address. Set it on the Cards page if this one is wrong.", flush=True)
    print(f"  Studio key:        {key}", flush=True)
    print("", flush=True)
    if HTTPS_OK:
        httpsd = StudioServer(("0.0.0.0", HTTPS_PORT), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(DATA / "cert.pem", DATA / "key.pem")
        httpsd.socket = context.wrap_socket(httpsd.socket, server_side=True)
        threading.Thread(target=httpsd.serve_forever, daemon=True).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.", flush=True)


if __name__ == "__main__":
    main()
