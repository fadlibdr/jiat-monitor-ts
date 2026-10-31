# JIAT Monitor — Remaining Work

Gap analysis of this repository against the design documents, as of **27 Oct 2026**, baseline commit `c5d6051`.

| Source | Version | Used for |
|---|---|---|
| HLD — *High Level Design, Aplikasi Monitoring Proyek JIAT* | 26 Oct 2026, v0.2 | scope, roles, phases and exit criteria (§9) |
| LLD — *Low Level Design, Aplikasi Monitoring Proyek JIAT* | 26 Oct 2026, from HLD v0.2 | tables (§2), API (§4), intake (§5–7), MVs (§8), jobs (§9), test plan (§10) |
| Deck — *Monitoring Proyek JIAT, Presentasi* | v0.2 | promises made to management (slides 4–8), open decisions (slide 10) |
| Mockup — *Dashboard konsolidasi holding* | HTML | holding dashboard panels and metrics |

**How the baseline was checked:** `npm ci`, then `npm test` (10 files, **144 tests pass**) and `npm run typecheck` (clean). Two OCR-contract mismatches (§5.1) were confirmed by running the validator on the LLD §6 sample payloads. "Done" below means code plus tests exist in this repo. A design or a README line does not count as done.

---

## 1. Summary

- **Phase 1 (Fondasi): mostly done on the backend.** Tenancy, auth, companies, sites, contracts and the BOQ importer work and have tests. Two of the three exit criteria are not yet met: there is no real Keerom RAB import, and holding users cannot read contracts.
- **Phase 2 (Intake Telegram): pure rules done, integration not started.** The money, date, correction, V1–V7 and pHash-distance rules exist. The webhook, OCR, storage, tables and jobs do not.
- **Phases 3, 4 and 5: not started.** This covers procurement, progress, invoicing, the materialized views, the holding API, export, audit and the pilot.
- **There is no UI at all.** The LLD assumes server-rendered Livewire screens, but this repo is an API only.
- **Quantified against the LLD:**

  | LLD item | Built | Notes |
  |---|---|---|
  | Tables (§2) | **8 of 27** | some of the 8 are missing columns |
  | API routes (§4) | **1 of 14** | `boq/import`; the CRUD routes here are extra because Livewire was dropped |
  | Jobs (§9) | **0 of 6** | |
  | Materialized views (§8) | **0 of 4** | |
  | Test areas (§10) | **3 done, 3 partial, 5 not started** | |
  | CI | ✅ `.github/workflows/ci.yml` | typecheck, tests, build, migration drift |

**Biggest risk:** the HLD's 9–10-week plan assumed a fork of Nusantara ERP. Contract, procurement, finance, audit and the Livewire UI would have been "Fork, disesuaikan" (HLD §4, LLD §1). This repo is a from-scratch TypeScript rewrite "tanpa ERP" (README), so none of that reuse applies. The remaining scope is larger than the plan's remaining weeks suggest.

---

## 2. Architecture: LLD vs. this repo

The LLD describes Laravel 12 + Livewire 3 on a Nusantara ERP fork. This repo uses Node 22, Hono, Drizzle, Postgres RLS, Better Auth and Zod. Most of the differences are deliberate improvements, and the README records them. They are not remaining work, but several change what the remaining work looks like.

| Topic | LLD says | Repo does | Consequence for remaining work |
|---|---|---|---|
| Tenant isolation | Eloquent global scope + `SetActiveCompany` (§3) | Postgres RLS, `withCompany()` (`src/db/tenant.ts`) | Stronger. Every new tenant table must be added to `TENANT_TABLES` (`src/db/schema.ts:177`). |
| Active company | session + header switcher | company id in the URL path | No session switcher needed. The UI must route by `/companies/:id`. |
| Money / percent | `numeric(18,2)` / `numeric(7,4)` | integer cents / micro-percent | The LLD MV SQL (§8) and invoice formulas must be rewritten for integers. |
| BOQ re-import | replace in place | `boq_versions`, a new version each time | New design question, see §5.3. |
| UI | Livewire components per module | React + Vite SPA served by the API at `/app/` | Sign-in, picker, review, both dashboards built; data-entry screens open (§4.10). |
| Queue / scheduler | Laravel `database` queue + Supervisor | none | Needs a Node job runner (§6, decision 7). |
| Audit | Eloquent observers | none | No ORM observers in Drizzle. Use DB triggers or explicit writes (§4.9). |
| API conventions | prefix `/api/v1`, errors `{code, message, fields}` | no prefix, errors `{error, message, details\|issues}` | Pick one and update the other (§5.11). |

**Action:** publish an **LLD v0.3** that reflects the TypeScript architecture, so the LLD stays the source of truth.

---

## 3. Phase status against the HLD §9 exit criteria

| Phase | Exit criterion (HLD §9) | Status | Evidence / what is missing |
|---|---|---|---|
| 1 Fondasi | BOQ Keerom imported = RAB | ❌ Not met | The importer is proven only on synthetic layouts. No `versi_2_RAPI` fixture, no Keerom contract DPP (README "Belum ada" #2). |
| | A cannot see B | ✅ Met (backend) | `test/db/tenancy.test.ts`: RLS covers raw SQL, `WITH CHECK` and no-context, which is stronger than the LLD. |
| | Holding can read all contracts | ✅ Met | `GET /holding/contracts` with filters; every request is logged (`test/http/contracts-admin-holding.test.ts`). |
| 2 Intake | Golden set of 30 photos: total accuracy ≥ 95 %, zero duplicates | ❌ Not started | Rules exist, integration does not. The 30 photos have not been collected (deck slide 10, item 4). |
| 3 Pembelian & progres | One PR→PO→GR→opname cycle correct and traceable | ❌ Not started | No tables, routes or screens. |
| 4 Invoicing & dashboard | First termin issued with no manual input; holding = Σ detail; non-holding rejected at `/api/holding` | ❌ Not started | Only the 403-for-non-holding behaviour exists, on the single holding route. |
| 5 Pilot | Ask rate < 10 %, zero duplicates, holding recap matches detail | ❌ Not started | Blocked on Phases 2–4 and the open decisions. |

---

## 4. Remaining work by module

Sizes are relative (S < M < L < XL), not weeks; see §7.

### 4.1 Company & access — M

- [x] **Enforce site scoping.** `company_users.site_ids` is stored (`schema.ts:83`) but never applied: `GET /companies/:id/sites` returns every site (`app.ts:162`). HLD §2 limits *Staf site* to their assigned site. Enforce it in RLS (a second setting such as `app.site_ids`) or in the route layer, and add tests. — **Done:** RESTRICTIVE RLS policy per tenant table (`src/db/rls.ts`), `withCompany({siteIds})`; tests in `test/db/site-scope-audit.test.ts`.
- [x] **Model the system admin as global.** HLD §2 has *Admin sistem* manage companies, users and the Telegram mapping. The repo has `system_admin` as a per-company role, and any signed-in user may `POST /companies` (`app.ts:104`). Decide on a global admin flag and restrict company creation. — **Done:** `users.is_system_admin`, `/admin/*`; company creation moved to `POST /admin/companies`.
- [x] **Map the `finance` role.** *(Partly done: `FINANCE_ROLES` defined; the invoicing routes it guards arrive in Phase 4.)* It exists in `COMPANY_ROLES` but is granted nothing (`app.ts:64-65`), and the README role ladder omits it. Map it to the invoicing and payment routes. — **Done:** finance owns termin invoices, payments, receivables/payables and vendor bank/NPWP data (read and write).
- [x] **Manage `management_viewers` over the API.** Today it is SQL only (README #5). Record `granted_by` and `granted_at`. — **Done:** `/admin/management-viewers` records `granted_by`/`granted_at`.
- [x] **Add update and delete routes** (`PUT`/`DELETE`) for sites, contracts and members (README #5). — **Done:** PATCH sites/contracts, DELETE members (last-manager guard). Sites/contracts are closed via `status`, not deleted.
- [x] **Add missing columns.** — **Done:** bank fields, `users.phone`, `created_by`/`updated_by` (filled by trigger).
  - `companies.bank_name`, `bank_account`, `logo_path` (LLD §2; needed to print invoices)
  - `users.phone`
  - `created_by` / `updated_by` on every table (LLD §2)
- [x] **Link Telegram identities to users.** *(Partly done: `users.telegram_user_id` + `PATCH /admin/users/:id`; a self-service `/start <code>` flow is still open.)* LLD §7 ignores corrections from senders who are not members, but no table links a Telegram user id to `users`. Add `users.telegram_user_id` and a linking flow, for example `/start <one-time code>`. See §5.12. — **Done:** self-service `POST /me/telegram-link` → one-time code (hashed, 15 min, single use) → "/start <code>" to the bot (or the t.me deep link); this also opens the private chat the DailyDigest needs.
- [x] **Rate-limit sign-in** on `/api/auth/sign-in/email` (README #4). — **Done:** 5/min/IP + `AUTH_TRUSTED_PROXIES`.

### 4.2 Site & contract — M

- [x] **Add `contract_terms`** (seq, name, percent, trigger_progress_pct, amount_dpp, due_days; unique `(contract_id, seq)`), with CRUD. — **Done:** basis-point percent and trigger; amount derived at invoice time.
- [x] **Add `contract_addendums`** (value_delta, end_date_new). Effective value and end date are derived from them; the mockup's "termasuk adendum Rp 1,2 M" depends on this.
- [x] **Store retention and advance (uang muka) parameters** on the contract. They are missing from the LLD entirely; see §5.1. — **Done:** `contracts.retention_bp`, `advance_cents`.
- [x] **Validate termin percentages:** Σ termin percent = 100 % and the termin amounts reconcile with DPP. — **Done:** Σ ≤ 100 % (draft allowed, `complete` flag), non-decreasing triggers; rounding reconciliation lands with invoicing.

### 4.3 BOQ — M

- [ ] **Fixture test with the real Keerom `versi_2_RAPI` workbook.** Assert item count, hierarchy, `SUM(amount) = value_dpp` and total weight = 100.00 (LLD §10, Phase 1 exit criterion).
- [x] **Populate `boq_items.category`** (material/upah/alat/subkon/…). The column exists, but the importer never sets it (`src/boq/importer.ts:92`). Cost-by-category and the mockup's "material 61 % · subkon 29 %" depend on it. Decide where it comes from: an AHSP column, a keyword rule, or a manual step after import. — **Done as a heuristic, decision still open:** at import the category is kept from the previous version by code, else whole-word keywords of the item, else its section; correct per item with `PATCH …/boq/items/:itemId` (kept on re-import). An AHSP-based split would be more exact.
- [x] **Import the planned schedule (rencana / time schedule) into `boq_schedules`.** The table exists, but nothing writes to it. Without it there is no planned S-curve and no deviation alert. — **Done** as an API (`PUT …/boq/schedule`, per code or contract-wide); reading it from the RAB workbook's time-schedule sheet is still open.
- [x] **Define how BOQ versions interact with progress and procurement references** (§5.3). — **Done:** progress, plan and commitments are matched by BOQ **code** across versions; the plan comes from the newest version that has one.

### 4.4 Intake: Telegram + OCR (Phase 2) — L

Built: `parseIdrCents` and `parseIndonesianDate` (MoneyParser/DateParser), `parseCorrection`, `validateReceipt` V1–V7, `hammingDistance` (V9) and the category aliases.

- [x] **Tables:** `vendors`, `vendor_invoices` (with `row_id` uuid, `image_hash`, `phash`, `confidence` jsonb and both unique keys, the second `DEFERRABLE`), `attachments`, `telegram_chats`, `intake_events`. Add them to RLS. — **Done** (`drizzle/0002`, `0003`). The second key is a **partial** unique index `WHERE status = 'terkonfirmasi'` instead of `DEFERRABLE`: it binds exactly when a row is confirmed, and rows with an unknown vendor are not affected. `vendor_invoices` also gained `confirmed_at` / `confirmed_by` (mockup "waktu sampai terkonfirmasi").
- [x] **Webhook.** `POST /telegram/webhook` checks `X-Telegram-Bot-Api-Secret-Token`, ignores unknown `chat_id`, stores the raw update, returns 200 and enqueues work. — **Done**, with one deliberate change: only the fields the jobs need are stored (file id, mime, size; correction text and reply target), never the raw update, and chat text that is not a correction is not stored at all.
- [x] **Job runner** (see decision 7). `ProcessIncomingPhoto` is idempotent per `(chat_id, message_id)`, retries 3× at 30/120/600 s, and on permanent failure replies and alerts the admin. — **Done** as a Postgres queue (`src/jobs/queue.ts`, `src/worker.ts`). *Open:* the admin alert on give-up is only a JSON log line so far; it belongs to the alerting/DailyDigest work in §4.9.
- [x] **Download photos** with Telegram `getFile`, then compute SHA-256 and the 64-bit pHash. Needs an image library; see §6 on dependency vetting. — **Done** with `sharp` 0.35.5 (pinned, vetted).
- [x] **Object storage.** Upload the original photo before the DB transaction and discard the path if the transaction fails (LLD §9). — **Done** for local disk (atomic write: temp file + fsync + link); the file is deleted after a failed save only when no attachment points at it. An S3-compatible adapter behind `ObjectStorage` is still open.
- [x] **OCR adapter** (`vision|openai|gemini`, two stages, structured output):
  - strip code fences, 60 s timeout
  - unparseable JSON → `tidak_terbaca`; transport error → `ocr_error` with retry
  - **Resolve the contract mismatch first** (§5.10).
  - **Done** for OpenAI-compatible endpoints (`src/intake/ocr.ts`). Contract resolved: stage 1 `doc_type` ∈ `nota|faktur|kwitansi|bukti_transfer|invoice|bukan_dokumen` (anything else → `bukan_dokumen`); stage 2 money may be text or a number; `doc_number` / `invoice_number` are aliases. *Verified only against a fake server.*
- [x] **V8–V10 (need the database):**
  - V8: SHA-256 per company, checked before OCR
  - V9: pHash ≤ 6 within 90 days on the same site
  - V10: vendor trigram match ≥ 0.6, which needs the `pg_trgm` extension
  - default-category fallback (LLD §6)
- [x] **Single-transaction write** of row + attachment + intake_event. Reply only after commit; if the reply fails, set `outcome = tersimpan_tanpa_balasan`.
- [x] **Reply builder** that never includes bank account or NPWP (HLD §8, UU 27/2022). Test it.
- [x] **`ProcessCorrection`:**
  - resolve `row_id` (from the reply or `#xxxx`)
  - `UPDATE … WHERE row_id = ? AND company_id = ?`, recompute V4/V5 on `TOTAL`
  - refuse changes to `terkonfirmasi` rows
  - create a draft vendor on an unknown `VENDOR`
  - write an audit entry; ignore senders who are not members
  - **Done.** Corrections of one chat run in arrival order (`jobs.serial_key`); `#xxxx` also finds rows closed in the last 30 days (answered "sudah dikonfirmasi"); a reply to another bot's message is ignored silently.
- [x] **Review API:** `GET /intake/review` and `PATCH /intake/{row_id}`. The same validation and audit path as chat. — **Done** (`/companies/:companyId/intake/*`, `applyChanges()` in a savepoint for both channels); NPWP read from the receipt is returned to finance and managers only.
- [ ] **Golden set:** a manual integration run over 30 real photos, with results stored in `test/golden/results.csv` (LLD §10).

### 4.5 Procurement (Phase 3) — L

- [x] **Tables:** `vendors` (shared with §4.4), `purchase_requests`/`_items`, `purchase_orders`/`_items`, `goods_receipts`/`_items`. Every item links to a `boq_item`. — **Done** (`drizzle/0004`).
- [x] **Document numbering.** `document_sequences` locked with `FOR UPDATE`, using the per-company prefix (`companies.doc_prefix` exists). — **Done** with an atomic upsert on `document_sequences` (no separate lock needed), e.g. `PO/KRM/2026/031`.
- [x] **Status workflows:** PR → PO (approved by company_manager, HLD §2) → GR with partial receipts. Compute commitment per BOQ item. — **Done.** PR approval added as well (the mockup shows "menunggu persetujuan").
- [x] **Match intake rows to PO/GR** (`vendor_invoices.po_id` / `gr_id`, Phase 3 scope in HLD §9). — **Done:** `GET …/intake/:rowId/match-candidates`, `PUT …/intake/:rowId/match`.

### 4.6 Progress (Phase 3) — M

- [x] **Tables:** `progress_reports` (unique `(contract_id, period)`) and `progress_items` (unique `(report_id, boq_item_id)`). — **Done.**
- [x] **Opname input** by site staff. `POST /progress/{report}/approve` is for company_manager. — **Done:** by quantity done or cumulative percent; approved cumulative can never decrease (checked at save and approve, against earlier and later months).
- [x] **`SCurveService`:** weighted cumulative actual vs. plan. Use the corrected formula in §5.2. — **Done** (`src/domain/scurve.ts`, carry-forward; portfolio curve weighted by effective DPP).

### 4.7 Invoicing & finance (Phase 4) — M–L

- [x] **Tables:** `sales_invoices` and `payments` (polymorphic), and `vendor_invoices` payables. — **Done.**
- [x] **`POST /invoices/sales/from-term`:** — **Done** with the rule in §5.1 *(to confirm with finance)*; termin billed in order, cancelled from the last, negative termin refused.
  - DPP from the termin
  - PPN from `ppn_rate_bp`
  - retention and advance deduction (blocked on §5.1)
  - due date from `due_days`
- [x] **Aging service:** buckets 0–30 / 31–60 / 61–90 / > 90. — **Done** (`GET …/receivables`, `GET …/payables`).
- [x] **Feature test:** approved progress triggers the termin with the correct DPP, PPN 11 %, retention and advance deduction (LLD §10). — **Done** (`test/http/phase34-flow.test.ts`, `test/finance/finance.test.ts`).

### 4.8 Dashboards (Phase 4) — L

- [x] **Company dashboard:** `GET /dashboard/company?site_id=&period=`, live from tables. — **Done** as `GET /companies/:companyId/dashboard`, live in the caller's site scope; finance panel only for finance/managers.
- [x] **Four materialized views,** `mv_dashboard_contract`, `_procurement`, `_progress` and `_finance`: — **Done differently:** snapshot tables `dash_*` written by the refresh job with the same functions as the detail screens (S-curve carry-forward is not re-implemented in SQL), replaced in one transaction per company.
  - grain: company × site × month
  - unique indexes so `REFRESH … CONCURRENTLY` works
  - rewrite the progress SQL first (§5.2)
- [x] **`RefreshHoldingViews`:** every 15 minutes, plus `POST /holding/refresh` rate-limited to once per minute. Store the last-refresh time for the "data per HH:MM" stamp. There is no cache in this stack, so use a table. — **Done:** worker schedule + `POST /holding/refresh` (429 + Retry-After), stamp in `dash_refreshes`.
- [x] **Holding API:** — **Done:** `/holding/dashboard|summary|progress|procurement|finance|intake|alerts|export|refresh`.
  - `GET /holding/summary`, `/procurement`, `/progress`, `/finance`, `/alerts`, `/export`
  - filters: `companies[]`, site, from/to, employer, status
  - `companies[]` outside the caller's rights → empty
- [x] **`AlertService`,** computed from the MVs at request time: termin due ≤ 14 days, PO > 30 days, deviation < −10, vendor invoice overdue, contract ≤ 30 days left with actual < 95 %. — **Done** (evaluated at refresh from the panel numbers; "termin siap diajukan" is a separate kind).
- [ ] **Export:** a monthly summary PDF and an XLSX per panel. `exceljs` is already a dependency; PDF needs a decision (§6). — **Partly done:** XLSX with one sheet per panel (`GET /holding/export?format=xlsx`); the monthly PDF still needs the decision in §6.
- [x] **Reconciliation test:** `SUM(mv) = SUM(table)` per company for all four views (LLD §10). — **Done:** the holding dashboard is asserted equal to the live company dashboard (same aggregation), on PGlite and on PostgreSQL 16.

**Mockup coverage.** These are the panels in the holding mockup whose data the LLD does not yet define:

| Mockup element | LLD source | Gap |
|---|---|---|
| "Realisasi biaya Rp 19,4 M · 39,9 % dari anggaran BOQ" | `mv_dashboard_finance.cost_by_category` | "Realisasi" is undefined: confirmed vendor invoices, GR value or payments? |
| Deck slide 6: "perkiraan biaya akhir, margin" | — | Estimate-at-completion and margin are promised to management but appear in neither HLD nor LLD. |
| "Progres tertimbang 41,2 %" and combined S-curve | `mv_dashboard_progress` is per contract | The portfolio aggregation rule is undefined (weight by contract DPP?). |
| "Komitmen vs BOQ 43,6 % · material 61 % · subkon 29 %" | — | Not in `mv_dashboard_procurement`. Needs PO commitment by category plus BOQ category (§4.3). |
| "Vendor terbesar" top 3 with "belum diterima" | `top_vendor_id`, `top_vendor_value` (one vendor) | The view holds a single vendor and no undelivered value. |
| "PR terbuka 14 · 5 menunggu persetujuan" | — | The HLD has approval on POs, not PRs. Decide whether PRs need approval. |
| "Intake lapangan": photos in 7 days, perlu konfirmasi, ask rate, median time to confirm, per site | — | No intake MV. `vendor_invoices` has no `confirmed_at` / `confirmed_by`. "Ask rate" is undefined (§5.4). |
| "Termin siap diajukan" alert | folded into "Termin jatuh tempo" | Label it as a distinct alert type. |
| "Nilai kontrak termasuk adendum" | `addendum_delta` | Needs `contract_addendums` (§4.2). |

### 4.9 Audit, jobs, operations, security — M

- [x] **`audit_logs`:**
  - before/after on every transaction-table change
  - every chat correction
  - every holding request (user, time, route, filters) via an `AuditHoldingAccess` middleware
  - Postgres triggers fit the RLS-first design and cannot be bypassed by forgotten app code.
  — **Done** (`src/db/audit.ts`): `jiat_audit` trigger on the transaction tables, `jiat_audit_event()` for chat corrections
  (`src/intake/pipeline.ts`) and holding access (`src/http/context.ts`); both SECURITY DEFINER, so the app can append but never
  edit or delete history.
- [x] **Scheduled jobs:** `DailyDigest` (07:00 WIB), `PurgeFailedIntakeTemp` (02:00), `BackupDatabase` (01:00, `pg_dump` to object storage, 30-day retention). — **Done:** refresh + DailyDigest + purge in the worker (`jobs.dedupe_key`); BackupDatabase as `scripts/backup-db.sh` from host cron (verified dump → restore).
- [x] **Structured JSON logging** with `company_id`, `chat_id`, `message_id` and no photo content or account numbers. Today unhandled errors go to `console.error` (`app.ts:76`). — **Done** (`src/log.ts`, key-based redaction).
- [x] **Column-level PII control** for vendor bank account and NPWP (§5.8). — **Partly done:** enforced in the API (vendor bank/NPWP read and write only by finance/managers; receipt NPWP only to them); column-level grants in Postgres are still open.
- [x] **`.env.example`:** add `TELEGRAM_*`, `OCR_*`, storage, `HOLDING_MV_REFRESH_MINUTES`, `INTAKE_QUALITY_MIN`, `INTAKE_TOTAL_CONFIDENCE_MIN` (LLD §9). — **Done.**
- [ ] **Deployment to the existing VPS:**
  - process manager for the API and worker
  - Postgres login role setup (`jiat_login`, a member of `jiat_app` and `jiat_holding`, not the owner)
  - TLS, backups and a restore drill
- [x] **CI:** run unit and feature tests plus the typecheck on every push (LLD §10). — **Done** (`.github/workflows/ci.yml`):
  typecheck, tests, build, migration drift; a second job builds the UI and rejects an inline script in its shell.

### 4.10 UI — XL (largest single workstream)

**Decision:** React 19 + Vite single-page app in `web/` (own package and lockfile), built to `web/dist` and served by the
API server under `/app/` with a strict CSP: same origin and session cookie, no CORS, no second process. In rough
pilot-priority order:

1. [x] **Login and company picker**, from `/me` and `/me/companies` (plus Telegram linking).
2. [x] **`IntakeReview`:** photo, confidence flags, near-duplicate candidates, Confirm/Reject/inline edit (vendor, date, due
   date, total, number, category); finance reads only. *Open:* zoom beyond the browser's own, per-field colouring below 0.70.
3. [x] **Holding dashboard** per the mockup: filters, refresh, XLSX export, S-curve on a calendar axis.
4. [x] **Master data:** sites, contracts, termin, addendum, BOQ import with its summary and errors, members. Also vendors
   (bank and NPWP only for finance and managers) and per-item cost categories. Rupiah fields use the server's own parser.
   *Open:* reading the plan (time schedule) from the RAB workbook; system-admin screens (companies, users, Telegram groups).
5. [x] **PR/PO/GR forms and approvals.** PR with lines (optionally tied to BOQ items), submit / approve / reject; PO from an
   approved PR or blank, issue or cancel; goods receipts per line with an `Idempotency-Key` per form. Quantities and line
   totals use the server's own code (`src/domain/quantity.ts`). *Open:* PO edit before approval, printing a PO.
6. [x] **Opname entry and approval, S-curve plan entry.** Per contract: the S-curve (plan vs approved opname), the monthly
   reports, and the plan. Site staff and admins fill a month (cumulative volume per BOQ leaf, or % for a leaf without a
   volume; matched to the current BOQ by code) and submit; managers approve or reject. Admins and managers edit the plan:
   contract-level rows (blank code = every leaf) and per-item rows; a plan stored identically for every leaf comes back
   as one row per month. Site staff now have a web screen. *Open:* a per-item plan above 500 rows is not editable here
   (shown on the curve, replaced whole by a save); the latest approved figure per item is not shown beside the input.
7. [ ] **Invoicing and payments.**
8. [x] **Company dashboard** (the same panels, live; finance and managers only, LLD §4).

Checked in Chromium against PostgreSQL 16, 27 steps: sign-in, wrong password, picker, review and confirm, a site, a
contract, its termin, a refused and a good RAB import, a category fix, an addendum, vendor bank data (and finance's view),
a PR submitted and approved, a PO from it issued and partly received (an over-receipt refused), an opname month (a volume
above the BOQ and a figure below the approved month refused) submitted and approved, the plan saved, members, sign-out,
holding dashboard, refresh, 390 px screen. No console errors, no 5xx. Not yet automated in CI (it
needs a browser and Postgres).

### 4.11 Test plan coverage (LLD §10)

| Area | Status | Where / what is missing |
|---|---|---|
| MoneyParser, DateParser | ✅ | `test/domain/money.test.ts`, `test/domain/date-hamming-categories.test.ts` |
| CorrectionParser | ✅ | `test/domain/correction-validator.test.ts` |
| Validator V1–V10 | ⚠️ | V1–V7 ✅. V9 distance boundary 6 vs 7 ✅ (unit). V8, V10 and V9-with-DB ❌. |
| BoqImporter | ⚠️ | Synthetic workbooks ✅. Keerom `versi_2_RAPI` ❌. |
| CompanyScope / isolation | ✅ | `test/db/tenancy.test.ts`, `test/http/app.test.ts` |
| Webhook Telegram | ❌ | — |
| Intake end-to-end (OCR mocked) | ❌ | — |
| Invoicing | ❌ | — |
| Holding reconciliation | ❌ | — |
| Holding access | ✅ | 200 / 403, audit row and `companies[]` filter: `test/http/contracts-admin-holding.test.ts`. |
| Golden set OCR | ❌ | Needs the 30 photos. |

---

## 5. Gaps in the design documents (decide before coding)

1. **Retention and advance (uang muka) have no source.** `sales_invoices` has `retention` and `advance_deduction` (LLD §2), but neither `contracts` nor `contract_terms` stores a retention percent, an advance amount or an advance-recovery rule. The Phase 4 exit criterion "termin pertama terbit tanpa input manual" cannot be met until these fields exist.
2. **The `mv_dashboard_progress` SQL (LLD §8) has three problems:**
   - It joins `boq_items.level = 0`, but opname is recorded per item, normally a leaf. Use `is_leaf`; the README already notes this.
   - A month with no approved report contributes `COALESCE(cumulative_pct, 0) = 0`, so the actual curve drops to zero instead of carrying the last approved cumulative forward.
   - Whether `boq_schedules.planned_pct` is cumulative or per-period is not specified.

   In this repo it must also filter `boq_versions.is_current` and use integer micro-percent weights.
3. **BOQ versions vs. foreign keys.** PR, PO and progress items reference `boq_item_id`. A re-import creates new item ids (B3), so existing progress and commitments would point at the old version. Choose a rule: carry rows over by `code`, freeze the BOQ after the first opname (changes only via addendum), or keep progress on the old version and migrate it explicitly.
4. **Intake metrics.** The mockup and deck (slides 6 and 8) promise intake counts, ask rate and time to confirmation, but no view or column supports them.
   - Add `confirmed_at` and `confirmed_by` to `vendor_invoices`.
   - Define ask rate. Suggested: (`tidak_terbaca` + `perlu_cek`) / photos received.
   - Define an intake aggregation.
5. **Procurement panel metrics** go beyond `mv_dashboard_procurement`: commitment by category, top-N vendors with undelivered value, PR approval. See §4.8.
6. **The portfolio progress rule is undefined.** Combined progress across contracts needs a weighting, most likely contract DPP.
7. **Drill-down for holding-only users.** HLD §7 says drill-down "membuka perusahaan terkait sebagai konteks aktif sesuai hak user". By design, holding viewers get 403 on company routes (`test/http/app.test.ts`). Decide: drill-down to view-level detail only, or grant read-only company access.
8. **PII column access.** HLD §8 requires per-role access to vendor bank account and NPWP. RLS is row-level only, so this needs column grants, a finance-only view, or explicit select lists. Test it.
9. **Global vs. per-company admin.** See §4.1.
10. **OCR output contract (verified by execution).** `src/domain/receipt-validator.ts` disagrees with LLD §6 in three ways:
    - Stage 1 enum: the code lacks `bukti_transfer` and adds `invoice` (`:12`).
    - Stage 2 values: the code requires strings (`:17`), while the LLD sample uses numbers (`"value": 2450000`).
    - Field names: `invoice_number` vs `doc_number` (`:20`), and line items `{description, amount}` vs `{desc, qty, unit, price, amount}` (`:26`).

    Feeding the LLD's own sample to `validateReceipt` throws `ZodError`. The code's text-only choice is defensible, because the model never does arithmetic and the money parser stays the single parser. Pin one contract and update the other document before writing the OCR prompts.
11. **API conventions.** The route prefix and error shape differ (§2). Decide once.
12. **No Telegram user mapping.** The schema cannot tell which `users` row sent a correction (§4.1).
13. **The LLD still describes Laravel.** Issue v0.3 (§2).

---

## 6. Open decisions

Still open from HLD §9 and deck slide 10:

1. Telegram as the primary channel. The README still says "WhatsApp/Telegram"; the deck recommends Telegram.
2. The three companies, their sites and the PIC per site. This is needed for seed data and `telegram_chats`.
3. Who holds the holding role (`management_viewers`).
4. A golden set of 30 real receipt photos. **Longest lead time; start collecting now.**
5. Hosting on the existing VPS.

New, caused by the rewrite:

6. **Frontend stack.** Livewire no longer applies.
7. **Job runner and scheduler.** A Postgres-backed queue avoids adding Redis at pilot volume.
8. **OCR provider and models** for stages 1 and 2, plus the cost per photo.
9. **Object storage provider** (S3-compatible).
10. **PDF generation approach** for the monthly report.

Each new dependency must be vetted first: actively maintained, no known critical CVE, and a version checked at the time it is added.

---

## 7. Suggested order (critical path)

The order puts what blocks the pilot first, then what blocks a Phase 2–4 exit criterion.

1. **Now, non-engineering:** decisions 1–5; obtain the Keerom RAB workbook and contract DPP; start collecting the 30 photos.
2. **Close Phase 1:**
   - Keerom fixture test
   - `contract_terms` and `contract_addendums` with retention and advance (§5.1)
   - site scoping
   - holding read of contracts
   - `audit_logs` foundation
   - CI
3. **Phase 2 integration:** tables → webhook → job runner → storage → OCR adapter (after §5.10) → V8–V10 → replies and corrections → review API → golden-set run.
4. **Phase 3:** vendors and numbering → PR/PO/GR → schedule import → opname, approval and S-curve (after §5.2 and §5.3).
5. **Phase 4:** invoicing → four MVs and refresh → holding API with audit and alerts → export → reconciliation test.
6. **UI in parallel** once each API is stable: `IntakeReview` first (needed for the pilot), then the holding dashboard.
7. **Operations:** backups, purge, digest, logging, rate limiting and deployment.
8. **Pilot:** one company, one site, one staff member.

**Sizing caveat:** sizes in §4 are relative. No week estimate is given because the repo history (5 commits) is too short to measure velocity. Phases 2–4 (≈ 6–7 weeks of effort in HLD §9, with Phase 2 running in parallel with Phase 1) were planned on the assumption of reusing ERP modules and Livewire screens. Without that reuse, expect them to take longer. The UI alone is comparable in size to a phase.

---

## 8. Housekeeping found during the audit

- `README.md:54` says "119 test" while line 47 and the actual run say 144. *(Fixed in this change.)*
- `src/db/tenant.ts:29` references `auth/gates.ts`, which does not exist. The holding gate lives inline in `app.ts:116-121`.
- `src/domain/categories.ts:5` cites `docs/REVIEW`, which is not in the repo.
- `npm audit`: 6 moderate findings, all transitive. `exceljs` → `uuid`: a bounds check that matters only when a buffer is passed. `drizzle-kit` → `esbuild`: a dev-server issue in dev tooling. Both fixes are semver-major upgrades. Low practical risk; track them.
- The BOQ importer inserts items one row at a time inside one transaction. This is fine for RAB sizes (hundreds of rows). Batch it only if imports become slow.
