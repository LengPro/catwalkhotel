# Catwalk Cat Hotel — CLAUDE.md
<!-- Built: 31 Jul 2026 · 14:00 (ICT) -->

## What This Project Is

A single-file Progressive Web App (PWA) that acts as a CRM / hotel-management system for a cat boarding hotel. Owners drop off their cats while traveling; staff record bookings, track rooms, and monitor revenue. Designed for mobile-first daily use by the hotel owner/staff.

---

## Tech Stack

| Layer | Choice |
|---|---|
| UI framework | React 18 (loaded via CDN, Babel transpiled in-browser) |
| Database | Firebase Firestore (compat SDK v9.23) |
| Styling | Inline styles only — no CSS files, no Tailwind |
| PWA | `manifest.json` + `sw.js` service worker (push notifications, offline shell) |
| Bundling | **None** — everything is one `index.html` file (~4 950 lines) |

There is no build step, no `package.json`, no node_modules. Edit `index.html` and refresh.

---

## File Layout

```
catwalkhotel/
├── index.html      ← entire app (HTML + React + all logic, ~4 950 lines)
├── sw.js           ← service worker (push notifications, install/activate)
├── manifest.json   ← PWA manifest (name, icons, theme color)
├── icon.png        ← app icon (192 × 512)
└── CLAUDE.md       ← this file
```

---

## Application Pages (Navigation)

Hash-based routing — `window.location.hash` drives the current page.

| Hash | Component | Purpose |
|---|---|---|
| `#rooms` | `RoomsPage` | Room timeline calendar — daily view, check reservation / availability, past & future |
| `#bookings` | `BookingsPage` | Full booking list — create, edit, delete, export CSV |
| `#customers` | `CustomersPage` | Customer/cat CRM — owner info, cat profiles, booking history |
| `#dashboard` | `DashboardPage` | Revenue & analytics — day/week/month/year, MoM/YoY, room usage |
| `#settings` | `SettingsPage` | Pricing periods, import/export data, app version |

Default page is `#rooms`.

---

## Firestore Collections

```
customers/   {id, fullname, nickname, phone, address, idCardPhoto, cats:[{id,name,photo,certPhoto}], createdAt}
bookings/    {id, customerId, selectedCatIds[], roomId, roomIds[], size, checkin, checkout,
              base, discAmt, net, discount, litter, litterAmt, litterCustom,
              petTaxiAmt, extraFeeAmt, extraFeeNote,
              depositAmt, remaining, ccFeeAmt, payMethod, paid,
              extraRooms:[{roomIds[], checkin, checkout}],
              notes, createdAt}
settings/    doc("pricing") → {roomPeriods, litterPeriods}
```

Real-time listeners on `customers` and `bookings` collections (`.onSnapshot`). `settings/pricing` uses `.onSnapshot` too and overwrites the in-memory `PRICE_PERIODS` / `LITTER_PERIODS` arrays on every update.

---

## Rooms

Defined in `const ROOMS` (line ~94). Hard-coded; not stored in Firestore.

| Zone | Rooms | Type | Color |
|---|---|---|---|
| A | A-S1 – A-S5 (Small), A-M1, A-M2 (Medium) | S / M | Red / Purple |
| B | B-S6 – B-S10 (Small) | S | Orange |
| C | C-S11 – C-S14 (Small) | S | Dark maroon |
| Special | `@HOME` (in-home stay), `PET-TAXI` | H / taxi | Blue / Yellow |

Two virtual timeline rows (`VIRTUAL_ROWS`) for `@HOME` and `PET-TAXI` — not real rooms.

---

## Pricing System

### Room rates — `PRICE_PERIODS` (line ~172)

Array sorted ascending by `start` date. Each entry: `{start, end, prices:{S, M, L?}}`.

Lookup: `getPriceTableForDate(dateStr)` — **reverses the array** before `.find()` so the most-recent period wins.

Current default rate: S = ฿350 / night, M = ฿450 / night.

### Cat litter — `LITTER_PERIODS` (line ~183)

Same structure as room periods. Each entry: `{start, end, feePerRound, basis}`.

`basis` values:
- `"per6nights"` — one round per 6 nights
- `"perNight"` — charged nightly

Lookup: `getLitterFeeForDate(dateStr)` — same reverse-find pattern.

Default fallback: `LITTER_FEE = 60` (฿ per round).

Both arrays are overwritten at runtime from `settings/pricing` Firestore doc (`onPricingLoaded`).

---

## Booking Pricing Calculation

`calcPrice(nights, size, numCats, discount, litter, rateDate, priceOverride)` → `{base, discAmt, net, litterAmt, litterWeeks, extraCats, pricePerNight}`

- `base` = nightly rate × nights × numCats (multi-cat support)
- `discAmt` = base × discount%
- `net` = base − discAmt
- `litterAmt` = computed from `getLitterFeeForDate(rateDate)` and `basis`

Additional fees stored separately on the booking:
- `petTaxiAmt` — pet taxi (does not affect `net`, shown as a deduction)
- `extraFeeAmt` / `extraFeeNote` — miscellaneous extras
- `ccFeeAmt` — credit card processing fee (shown as a deduction)
- `depositAmt` / `remaining` — payment tracking

---

## Room Change Mid-Stay (`extraRooms`)

A booking can have a `extraRooms` array for guests who switch rooms during their stay.

Each extraRoom entry: `{roomIds:[], checkin, checkout, catPerRoom:{roomId: count}}`

- The top-level `b.checkout` is extended to the max checkout of all extraRooms (for Firestore date-range queries).
- `getBookingEntryForRoomDate(roomId, dateStr)` correctly slices the timeline:
  - Main room shows only until the first extraRoom start date.
  - Each extraRoom segment shows only its own `checkin`–`checkout` range.

---

## Dashboard Revenue

`DashboardPage` supports period views: **day / week / month / year** and comparison modes **MoM / YoY**.

Revenue is always **net of CC Fee and Pet Taxi** — both are informational deduction lines, not added on top. The displayed revenue figure = `net − ccFeeAmt − petTaxiAmt` across all bookings in the period.

Two revenue calculation modes:
- **By stay date** — pro-rates booking revenue across nights in range
- **By check-in date** (`inRangeCheckin`) — full booking revenue attributed to check-in day

Metrics shown: total revenue, room occupancy, top customers by nights/spend, MoM / YoY comparison.

---

## Key Utility Functions

| Function | Location | Purpose |
|---|---|---|
| `nights(a, b)` | ~line 200 | Date diff in nights |
| `today()` | ~line 202 | Current date as `YYYY-MM-DD` |
| `addDays(d, n)` | ~line 204 | Add n days to date string |
| `fmt2(n)` | ~line 206 | Format number to 2 decimal places |
| `getLitterFeeForDate(d)` | ~line 219 | Return matching litter period for date |
| `getPriceTableForDate(d)` | ~line 236 | Return matching room price table for date |
| `calcPrice(...)` | ~line 252 | Full booking price breakdown |
| `isRoomAvailable(...)` | ~line 277 | Check room availability (respects extraRooms) |
| `getAvailableRooms(...)` | ~line 293 | Filter available rooms by type/dates |
| `getBookingEntryForRoomDate(...)` | ~line 968 | Timeline segment lookup respecting extraRooms |
| `getRoomColor(roomId)` | ~line 135 | Zone-based color for timeline cells |
| `fbLoad / fbSave / fbDelete` | ~line 77 | Firestore CRUD wrappers |
| `exportBookingsCSV(...)` | ~line 300 | Export bookings to CSV download |

---

## Component Tree (simplified)

```
App
├── RoomsPage          ← timeline calendar
│   └── BookingSheet   ← create/edit booking form (bottom sheet)
├── BookingsPage       ← booking list + BookingSheet
├── CustomersPage      ← customer list + CustomerSheet + BookingSheet
│   └── CustomerSheet  ← create/edit customer + cats
├── DashboardPage      ← analytics
├── SettingsPage       ← pricing config + import/export
└── ReceiptView        ← printable/shareable receipt overlay
```

`BookingSheet` is the most complex component — handles room selection, multi-cat, litter presets, room change (extraRooms), fee breakdown, deposit.

---

## Litter Preset Buttons

Displayed inside `BookingSheet` as a 5-column grid. Presets are **dynamically computed** from the current litter period rate for the booking's check-in date:

```js
const presets = [1, 2, 3, 4, 5].map(x => x * _lp.feePerRound);
// e.g. if feePerRound=70: [70, 140, 210, 280, 350]
```

`litterCustom` stores the selected value. A `useRef` guard prevents the edit-open `useEffect` from resetting a previously saved custom value.

---

## PWA & Service Worker

- `sw.js` handles **push notifications** and **notification click** (opens app window).
- Install/activate use `skipWaiting` + `clients.claim()` for immediate takeover.
- No offline caching strategy — the app requires network for Firestore.
- Subscribe-calendar endpoint: external Cloudflare Worker (`catwalk-ical.nvvcv7ds48.workers.dev`) — **not in this repo**.

---

## Data Export / Import

- **Export**: CSV download via `exportBookingsCSV()` and `exportCustomersCSV()` — triggered from Dashboard or Settings.
- **Import**: JSON import via `ImportSheet` component — reads a previously exported JSON, shows preview of new/updated records, then batch-writes to Firestore.
- Settings also has a full Firebase-backup export (JSON of all customers + bookings).

---

## Settings — Pricing Config

Editable in `SettingsPage`:
- Add/edit/remove room price periods (`roomPeriods`)
- Add/edit/remove litter price periods (`litterPeriods`)
- Changes saved to `settings/pricing` Firestore doc → immediately broadcast to all open sessions via `.onSnapshot`.

---

## Development Notes

- **No build step** — edit `index.html`, hard-refresh browser (`Cmd+Shift+R` / `Ctrl+Shift+R`).
- All styling is inline React `style={{}}` objects using a shared `C` (colors) and `S` (style presets) object.
- Bangkok timezone (ICT, UTC+7) used for all date operations and version stamps.
- Branch for active development: `claude/check-file-visibility-l5y9F` → merges to `main`.
- Remote: `https://github.com/lengpro/catwalkhotel`

---

## Version Bump Rule

**Update the version line on every commit that changes `index.html`** — bug fix, feature, or refactor.

### Where

```
index.html → SettingsPage → "About" card (~line 4806)
<div>v DD Mon YYYY · HH:MM (ICT)</div>
```

### Format

```
v 31 Jul 2026 · 14:00 (ICT)
```

Use Bangkok time (ICT = UTC+7). Day first, then 3-letter month abbreviation, then 4-digit year, then 24-hour time.

### Rule

Every time `index.html` is modified and committed, update this line **in the same commit**. Never leave the version behind — users see it in Settings to confirm which version is running.

---

## Common Pitfalls

| Pitfall | Fix |
|---|---|
| Pricing period `.find()` returning wrong (oldest) period | Always `.reverse()` `PRICE_PERIODS` / `LITTER_PERIODS` before `.find()` since arrays are sorted ascending |
| `litterCustom` reset to default on booking edit | `useRef(_litterResetInit)` guard in `useEffect` — skip the reset on first mount |
| Room timeline showing full stay instead of per-segment dates | Use `getBookingEntryForRoomDate()` to get per-segment `checkin`/`checkout` |
| Firestore query missing bookings that span period boundary | `b.checkout` is extended to max of all `extraRooms` checkouts at save time |
| `onSnapshot` overwriting in-memory pricing mid-session | Expected behaviour — `LITTER_PERIODS` and `PRICE_PERIODS` are module-level `let` variables, intentionally mutable |

---

*Built: 31 Jul 2026 · 14:00 (ICT)*
