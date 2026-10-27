# JIAT Monitor (TypeScript)

Layanan mandiri untuk JIAT: impor BOQ/RAB per kontrak, validasi nota (intake), dan tenancy multi-perusahaan.
Rewrite dari `fadlibdr/jiat-monitor` Build 01 (PHP/Laravel, fork Nusantara ERP) — **tanpa ERP, tanpa login ERP**.

Stack: Node ≥ 22 · TypeScript (strict) · Hono · Drizzle ORM · PostgreSQL 15+ (RLS) · Zod · exceljs · Vitest (+ PGlite = Postgres di WASM, sehingga RLS diuji sungguhan).

## Keputusan desain (vs. Build 01 PHP)

| Topik | PHP Build 01 | Di sini | Temuan review yang ditutup |
|---|---|---|---|
| Tenancy | Eloquent global scope + session | **Postgres Row-Level Security**: role `jiat_app` + `SET LOCAL app.company_id` per transaksi (`src/db/tenant.ts`). Raw SQL, job antrean, atau `WHERE` yang terlupa tidak bisa bocor. | B2, L6, L7 |
| Konteks di API | `session('active_company_id')` (tidak ada di API bearer) | Perusahaan ada di **path** (`/companies/:companyId/...`), keanggotaan dicek per request terhadap `company_users` | B2 |
| Re-import BOQ | `delete` + `create` (id berubah) | `boq_versions`: setiap impor = versi baru, versi lama tetap ada, hanya `is_current` berpindah; sha256 berkas disimpan | B3 |
| Seksi "C/I/V/X/L" | Dibaca romawi → pohon rusak | Diputuskan dari urutan dokumen sendiri (`classify()` di `src/boq/parser.ts`) | B1 |
| Uang | numeric + float/string campur | **Integer sen** di seluruh jalur; `numeric` hanya untuk `qty` | — |
| `Rp 2.450.000,-` | `null` | Diterima (sufiks `,-` / `.-` = tanpa sen) | B4 |
| Volume teks `2,5` | `null` | Diterima | L2 |
| Koreksi chat | regex `\S+` sendiri | Pakai parser yang sama (`tanggal 21 Juni 2026`, `total Rp 2.450.000,-`); perintah dikenal tapi nilai tak terbaca → `error`, bukan diam | L3 |
| Kategori | 3 daftar berbeda | **Satu sumber** `src/domain/categories.ts` + alias label P2X (Peralatan→alat, Transportasi/Konsumsi→operasional, Jasa→upah) | L4 |
| Total nota `0` | Lolos V2 | Ditolak (`total > 0`) | L5 |
| `value_total` kontrak | Disimpan bebas | Diturunkan: `value_dpp_cents` + `ppn_rate_bp` | L8 |
| Header RAB "Jumlah" = volume | Kolom tertukar | ≥ 2 header jumlah/total tanpa "Volume": pertama = qty, terakhir = jumlah; `harga == jumlah` ditolak | L1 |
| Lingkup site | — | Policy RLS **RESTRICTIVE** per tabel (`src/db/rls.ts`): `site_staff` hanya melihat site di `site_ids` (kosong = tidak ada site); turun ke kontrak, termin, versi & item BOQ | HLD §2 |
| Audit | Observer Eloquent | **Trigger Postgres** `SECURITY DEFINER` (`src/db/audit.ts`): before/after setiap perubahan + setiap akses holding; role app hanya bisa membaca log perusahaannya, tidak bisa menulis/mengubah/menghapus. `created_by`/`updated_by` diisi trigger | LLD §2, §9 |
| Admin sistem | Peran per perusahaan | Bendera global `users.is_system_admin`: kelola perusahaan, pengguna, keanggotaan, holding viewer — **bukan** anggota perusahaan, tidak melihat data transaksi | HLD §2 |
| Addendum | — | Nilai & tanggal selesai efektif **diturunkan** (`src/domain/contract.ts`); impor BOQ dicocokkan ke DPP efektif | HLD §1 |

## Auth (standalone, tanpa ERP)

Better Auth 1.7 (`src/auth/better-auth.ts`): email + password, sesi **server-side** di tabel `sessions`,
cookie `jiat.session_token` httpOnly/SameSite=Lax (Secure di production), cookie cache dimatikan sehingga
setiap request terproteksi memvalidasi sesi ke database. Id user serial (`users.id`) → dipakai langsung
oleh `company_users`. Sign-up mandiri **tertutup** secara default; buat pengguna lewat CLI (password dari stdin).
Admin sistem pertama dibuat dengan `--system-admin`; selanjutnya lewat `PATCH /admin/users/:id`:

```bash
echo -n 'password-minimal-12-karakter' | npx tsx src/cli/create-user.ts admin@pii.co.id "Admin PII" --system-admin
```

Endpoint Better Auth di `/api/auth/*` (`sign-in/email`, `sign-out`, `get-session`, …).
Sign-in dibatasi **5 percobaan / menit / IP** (aktif di production, atau `AUTH_RATE_LIMIT=1`). Di belakang nginx,
isi `AUTH_TRUSTED_PROXIES` (mis. `127.0.0.1/32`); tanpa itu hanya `X-Forwarded-For` bernilai tunggal yang dipercaya.
Store rate limit ada di memori: benar untuk satu instance API (pilot); instance kedua butuh store bersama.
Pengguna yang dinonaktifkan (`isActive: false`) langsung kehilangan semua sesinya dan ditolak `403`.

## Struktur

```
src/domain/        money, date, hamming, categories, correction, receipt-validator, contract  (murni, tanpa I/O)
src/boq/           parser (exceljs → pohon, sen), importer (versi + bobot Σ = 100 % terhadap DPP efektif), errors
src/db/            schema (Drizzle), rls (policy perusahaan + site), audit (trigger), ddl (urutan DDL pasca-migrasi),
                   tenant (withCompany / withHoldingRead / withApp), client, migrate
src/auth/          Authenticator interface; better-auth.ts (produksi); headerAuthenticator (test saja, menolak production)
src/http/          app.ts (komposisi, error), context.ts (middleware, peran), routes/{admin,company,holding,members}.ts
src/cli/           create-user.ts
test/              unit domain, parser, importer, RLS + lingkup site + audit di PGlite, auth + CRUD + holding HTTP end-to-end
```

## Menjalankan

```bash
npm install
npm test            # 189 test, tanpa Postgres eksternal (PGlite)
npm run typecheck
npm run build

# Postgres sungguhan
cp .env.example .env            # isi DATABASE_URL (role jiat_app, BUKAN owner) dan DATABASE_URL_MIGRATE (owner)
npm run db:generate             # drizzle/ dari src/db/schema.ts
npm run db:migrate              # migrasi + policy RLS + trigger audit (dijalankan sebagai owner)
npm run dev
```

CI (`.github/workflows/ci.yml`) menjalankan typecheck, test, build, dan menolak perubahan `schema.ts` tanpa migrasi di `drizzle/`.

Role Postgres yang dibutuhkan (dibuat `db:migrate`, kecuali login): `jiat_app` (NOLOGIN, RLS), `jiat_holding` (NOLOGIN, SELECT lintas perusahaan).
Role login di `DATABASE_URL` harus **anggota** keduanya dan **bukan** pemilik tabel — jika pemilik, RLS dilewati (superuser/owner bypass).

## API

Peran per perusahaan (`company_users.role`): `site_staff`, `project_admin`, `finance`, `company_manager`, `system_admin`.
Baca: semua anggota (dalam lingkup site-nya). Site/kontrak/termin/addendum/impor BOQ: `project_admin`, `company_manager`, `system_admin`.
Kelola anggota: `company_manager`, `system_admin`. `finance`: tagihan & pembayaran (Fase 4).
Lingkup site: `site_staff` hanya site di `siteIds` (belum ditugaskan = tidak ada); peran lain semua site kecuali `siteIds` diisi.
Admin sistem global (`users.is_system_admin`) dan holding viewer (`management_viewers`) **bukan** konteks perusahaan.

| Method | Path | Catatan |
|---|---|---|
| GET | `/health` | — |
| POST | `/api/auth/sign-in/email` … | Better Auth |
| GET | `/me/companies` | perusahaan + peran si pemanggil |
| GET/POST/DELETE | `/companies/:companyId/members[/:userId]` | `{email, role, siteIds?}`; upsert; `404` email belum terdaftar; `409` bila menghapus/menurunkan `company_manager` terakhir |
| GET/POST | `/companies/:companyId/sites` · PATCH `…/sites/:siteId` | `409` kode ganda per perusahaan |
| GET/POST | `/companies/:companyId/contracts` | nilai efektif (DPP + addendum), `valueTotalCents`, `endDateEffective`, `daysLeft` diturunkan; `404` site milik perusahaan lain |
| GET/PATCH | `/companies/:companyId/contracts/:contractId` | GET + termin + addendum; PATCH tidak menerima DPP (lewat addendum); `400` uang muka > DPP |
| GET/PUT | `/companies/:companyId/contracts/:contractId/terms` | PUT mengganti seluruh jadwal; `400` Σ > 100 % / ambang progres menurun; `complete` bila Σ = 100 % |
| GET/POST | `/companies/:companyId/contracts/:contractId/addendums` | `{number, signedAt, valueDeltaCents?, endDateNew?}`; `400` bila DPP efektif ≤ 0 |
| POST | `/companies/:companyId/contracts/:contractId/boq/import?sheet=RAB` | multipart `file` (.xlsx ≤ 15 MB). `201` ringkasan; `422` `{error: total_mismatch\|sheet_missing\|…, details}`; tidak ada yang ditulis saat gagal |
| GET | `/companies/:companyId/contracts/:contractId/boq` | versi `is_current` + item |
| GET | `/holding/companies` · `/holding/contracts` | hanya `management_viewers`; read-only; filter `companies[]`, `site_id`, `employer`, `status`; setiap request dicatat di `audit_logs` |
| GET/POST/PATCH | `/admin/companies[/:companyId]` | admin sistem; `managerEmail` = `company_manager` pertama |
| GET/POST/DELETE | `/admin/companies/:companyId/members[/:userId]` | sama seperti di atas, tanpa harus menjadi anggota |
| GET/PATCH | `/admin/users[/:userId]` | `telegramUserId`, `phone`, `isActive`, `isSystemAdmin`; `409` menonaktifkan/mencabut diri sendiri |
| GET/POST/DELETE | `/admin/management-viewers[/:userId]` | `{email, role: holding_viewer\|direksi}` |

Semua `/companies/:companyId/*` → `401` tanpa principal, `403` bila bukan anggota perusahaan tersebut (termasuk holding viewer dan admin sistem), `400` id tidak valid; data di luar lingkup site → `404`.

## Belum ada (urutan berikutnya)

Analisis lengkap terhadap HLD v0.2, LLD, deck v0.2, dan mockup dashboard holding: [`docs/remaining-work.md`](docs/remaining-work.md).

1. Intake Fase 2: webhook Telegram, job OCR, `vendor_invoices`, V8–V10 (sha256/pHash/trigram) — `hamming.ts` dan `receipt-validator.ts` sudah siap dipakai.
2. **Fixture RAB Keerom `versi_2_RAPI` asli** di `test/fixtures/boq/` + nilai DPP kontrak: importer terbukti pada layout sintetis, belum pada file sebenarnya.
3. Materialized view progres (LLD §8) — join ke `is_leaf`, bobot sudah di-rollup ke induk.
