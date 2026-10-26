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

## Struktur

```
src/domain/        money, date, hamming, categories, correction, receipt-validator  (murni, tanpa I/O)
src/boq/           parser (exceljs → pohon, sen), importer (versi + bobot Σ = 100 %), errors
src/db/            schema (Drizzle), rls (DDL policy), tenant (withCompany / withHoldingRead / withApp), client, migrate
src/auth/          Authenticator interface + headerAuthenticator (dev/test saja, menolak NODE_ENV=production)
src/http/          Hono app: /health, /me/companies, /holding/companies, /companies/:id/contracts/:id/boq[/import]
test/              119 test (unit domain, parser, importer & tenancy di PGlite, HTTP end-to-end)
```

## Menjalankan

```bash
npm install
npm test            # 119 test, tanpa Postgres eksternal (PGlite)
npm run typecheck
npm run build

# Postgres sungguhan
cp .env.example .env            # isi DATABASE_URL (role jiat_app, BUKAN owner) dan DATABASE_URL_MIGRATE (owner)
npm run db:generate             # drizzle/ dari src/db/schema.ts
npm run db:migrate              # migrasi + policy RLS (dijalankan sebagai owner)
npm run dev
```

Role Postgres yang dibutuhkan (dibuat `db:migrate`, kecuali login): `jiat_app` (NOLOGIN, RLS), `jiat_holding` (NOLOGIN, SELECT lintas perusahaan).
Role login di `DATABASE_URL` harus **anggota** keduanya dan **bukan** pemilik tabel — jika pemilik, RLS dilewati (superuser/owner bypass).

## API

| Method | Path | Catatan |
|---|---|---|
| GET | `/health` | — |
| GET | `/me/companies` | perusahaan + peran si pemanggil |
| GET | `/holding/companies` | hanya `management_viewers`; read-only |
| POST | `/companies/:companyId/contracts/:contractId/boq/import?sheet=RAB` | multipart `file` (.xlsx ≤ 15 MB). `201` ringkasan; `422` `{error: total_mismatch\|sheet_missing\|…, details}`; tidak ada yang ditulis saat gagal |
| GET | `/companies/:companyId/contracts/:contractId/boq` | versi `is_current` + item |

Semua `/companies/:companyId/*` → `401` tanpa principal, `403` bila bukan anggota perusahaan tersebut (termasuk holding viewer), `400` id tidak valid.

## Belum ada (urutan berikutnya)

1. **Auth produksi**: adapter Better Auth (sesi cookie httpOnly, validasi server-side) ke `users.id`. `headerAuthenticator` hanya untuk dev/test dan menolak `NODE_ENV=production`.
2. Endpoint CRUD companies/sites/contracts/memberships (sekarang hanya lewat seed/SQL).
3. Intake Fase 2: webhook WhatsApp/Telegram, job OCR, `vendor_invoices`, V8–V10 (sha256/pHash/trigram) — `hamming.ts` dan `receipt-validator.ts` sudah siap dipakai.
4. **Fixture RAB Keerom `versi_2_RAPI` asli** di `test/fixtures/boq/` + nilai DPP kontrak: importer terbukti pada layout sintetis, belum pada file sebenarnya.
5. Materialized view progres (LLD §8) — join ke `is_leaf`, bobot sudah di-rollup ke induk.
