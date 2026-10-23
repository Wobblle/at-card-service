# Asleepius Tech (A.T.) — Brand & Card Spec

The complete design reference for the A.T. identity and the NFC card.
Everything here is exact: copy these values, don't eyeball them.

## Brand

- **Legal/DBA name:** Asleepius Tech (to be registered; Vibratur remains the older registered DBA)
- **Short mark:** A.T.
- **Slogan:** We heal tech
- **Concept:** Rod of Asclepius (the actual single-serpent healing symbol — not the
  two-snake caduceus) rebuilt from tech parts: the staff is an antenna, the serpent
  is a cable, the tail ends in a plug. Clinical *form* language (forms, records,
  stamps) — but NO clinical/medical vocabulary anywhere in copy. That distinction
  is deliberate and locked.

## Colors (exact)

| Role | Hex | RGB | Notes |
|---|---|---|---|
| Brand green (ink) | `#004353` | 0, 67, 83 | THE color. Sampled from the approved logo art. All text, lines, logo. |
| Paper | `#FBFAF2` | 251, 250, 242 | Card background. Warm off-white, not pure white. |
| Highlight pink | `#F5DCDE` | 245, 220, 222 | Marker-swipe behind "SYSTEM DOWN?" only. Use sparingly. |
| Stamp pink | `#B95C6B` | 185, 92, 107 | "KEEP BY THE REGISTER" stamp: text + border. |
| Bullseye pink | `#EFAEB6` | 239, 174, 182 | Center dot of the NFC target. |
| Dotted form lines | `rgba(0,67,83,0.65)` | — | Blanks, table row rules. |

Logo files have backgrounds baked in: teal/black versions on white `#FFFFFF`,
white version on the brand green. Print-shop note: the green will shift slightly
in CMYK; on an office printer it's a non-issue.

## Logo

Files in `logo/`: `at-logo-teal.svg` (primary), `at-logo-black.svg` (one-color
print), `at-logo-white.svg` (reversed, for dark surfaces), `at-logo-teal.png`
(2000×2000 quick-use raster).

Construction (locked, v4 — do not redesign):
- Square box frame, brand green.
- Antenna staff: ball tip, three Wi-Fi arcs fanned above it.
- Cable serpent: ~3 loose wraps around the staff, S-curves, NOT a tight spring.
- Cable tail terminates in a two-prong plug at the bottom.
- "A.T." set large and bold inside its OWN small square, bottom-right corner of
  the frame, separate from the symbol.
- Clear space around the mark: at least the height of the A.T. stamp box.
- Minimum print size: 0.75 in wide (the stamp text stays legible).

## Typography (system fonts only — no licensing, everywhere)

- **Display / names:** Georgia (serif), bold, letter-spacing ≈ 0.19em, uppercase.
  Card front business name: 21px at 660px card width (≈ 9.5pt at print size).
- **Forms / labels / footers:** Courier New, uppercase, letter-spacing 2–2.6px
  at draft scale.
- **Body statement (front):** Georgia italic, ~14.5px at draft scale.
- **Stamp:** Courier New bold, letter-spacing 2.5px, rotated −9°.

## The Card

Trim 3.5in × 2in. With bleed: 3.75in × 2.25in (0.125in all sides).
At 300 DPI: trim = 1050×600 px, with bleed = 1125×675 px.
Reference render: `card/at-card-design.html` (open in a browser; it is also the
visual source of truth). Draft was designed at 660px wide, aspect 7:4.

### Front (top → bottom)

1. Letterhead row: logo (58px at draft scale) · "ASLEEPIUS TECH" ·
   sub-line "TECHNICAL REPAIR · NETWORKS · SYSTEMS · SUPPORT" ·
   top-right form block "FORM AT-01 / EST. 2026"
2. Double rule (2.5px line over 1px line).
3. Form fields: "CLIENT (BUSINESS): ____" and "DATE: ____" — dotted blanks.
   The client line is HANDWRITTEN per business at delivery. Intentional.
4. Statement block: boxed glyph "IT" (56px square, 2.5px border) beside
   italic text: "One IT guy, on tap — for outages, slow systems, and printer
   incidents. The big companies have whole departments. You have this card."
   Under it, mono: "CALLBACKS: UNLIMITED · NO TICKET QUEUE, JUST A PHONE CALL"
5. Emergency block (left): "SYSTEM DOWN?" with the pink highlight swipe behind
   it · "CALL OR TEXT, ANY HOUR:" · phone number on a dotted line (prints once
   the number is set — blank in the data file until then).
6. NFC target (right): concentric circles, outer Ø ≈ 76px at draft scale
   (≈ 0.8 in print), rings 2px brand green, pink bullseye center.
   Label: "TAP PHONE HERE / YOUR SERVICE PACKAGE IS ON THIS CARD".
   The physical NFC sticker goes ON this target — it's a placement guide.
7. Footer strip above a 1.5px rule, mono, centered:
   "POS · NETWORKS · WI-FI · WEBSITES · DIGITAL MENUS · LOYALTY · BACKUPS"

### Back (top → bottom)

1. Header: "SERVICE RECORD" · sub "PROBLEMS WE FIX — BEFORE THEY COST YOU A RUSH"
   · top-right "REF NO. / AT-______". Light ruled-paper background lines.
2. Problem/fix table, checkbox squares (11px, 1.5px border), dotted row rules,
   fixes right-aligned italic:
   - Register frozen mid-rush → handled same day
   - Dead Wi-Fi zones, dropped orders → full-coverage install
   - Menu & price changes by hand → digital menus, minutes not printers
   - No backups, one bad day from gone → automatic, tested monthly
3. "PREPARED FOR: ____" — handwritten per business. Intentional.
4. Mono line: "SCHEDULED CHECK-INS MONTHLY · EMERGENCIES: CALL OR TEXT ANYTIME"
5. Pink stamp, rotated −9°: "KEEP BY THE REGISTER"
6. QR box (bottom-right): 72px dashed-border square — in production this is a
   generated QR of the client's funnel URL, NOT a placeholder. Label: "NO TAP? SCAN"
7. Footer: "A.T. · ASLEEPIUS TECH · WE HEAL TECH"

## Design tokens (paste-ready CSS variables)

```css
:root {
  --ink: #004353;
  --paper: #FBFAF2;
  --highlight: #F5DCDE;
  --stamp: #B95C6B;
  --bullseye: #EFAEB6;
  --line: rgba(0, 67, 83, 0.65);
  --font-display: Georgia, 'Times New Roman', serif;
  --font-form: 'Courier New', monospace;
}
```

## Program blueprint (card generator)

- **Shape:** data (one JSON per client, see `clients/asleepius-tech.json`) +
  HTML/CSS templates + renderer → print PDF (front/back, with bleed) + PNG preview.
- **Stack:** Python + Playwright (headless Chromium) for exact PDF export;
  `qrcode` (Python) generates the QR from the client URL at render time.
- **Themes = CSS variables.** The clinical theme above is theme #1. A new client
  style = new variable set + copy, not a new program.
- **The kit principle:** the same client JSON should eventually render the card,
  the tapped landing page, and the invoice header. One data file, three outputs.
- **Guardrails:** form-based editing only (fields → live preview → export).
  No free-form layout editing; that's what keeps output consistent and sellable.
- **NFC layer:** render the printed target as an optional layer — sticker cards
  need it as a placement guide; pre-made NFC cards should not have it printed.

## Copy rules

- Clinical structure, zero clinical vocabulary: no Rx, patient, diagnosis,
  copay, refill, care plan, attending, chart. (Locked by Jordan, Oct 21 2026.)
- Every service sells in one of four languages: money saved, money made,
  money protected, or owner-hours returned.
- The card is an emergency card, not an ad: it must still work with zero tech —
  the printed phone number is the fallback when tapping/scanning fails.
