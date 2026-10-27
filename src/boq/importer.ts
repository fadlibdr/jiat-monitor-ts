import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { effectiveContract } from '../domain/contract.js';
import { centsToDecimalString, type Cents } from '../domain/money.js';
import { boqItems, boqVersions, contractAddendums, contracts } from '../db/schema.js';
import type { Tx } from '../db/tenant.js';
import { BoqImportError } from './errors.js';
import { parseBoqWorkbook, type ParsedBoq, type ParsedItem } from './parser.js';

export const MICRO_PCT_TOTAL = 100_000_000; // 100 % in millionths of a percent

export interface ImportSummary {
  versionId: number;
  version: number;
  items: number;
  leaves: number;
  total: string;
  contractValueDpp: string;
  diff: string;
  anomalies: ParsedBoq['anomalies'];
  footers: ParsedBoq['footers'];
}

export interface ImportOptions {
  sheet?: string | undefined;
  filename?: string | undefined;
  importedBy?: number | undefined;
}

/**
 * Imports a RAB workbook as a NEW boq_version of one contract. Refuses, writing nothing, unless
 * Σ(leaf amounts) == the effective contract DPP (value_dpp_cents + Σ addendum deltas) exactly. Runs inside withCompany(): the contract is
 * looked up through RLS, so a contract of another company simply does not exist here (SEC-AUTHZ).
 */
export async function importBoq(tx: Tx, contractId: number, file: Buffer, opt: ImportOptions = {}): Promise<ImportSummary> {
  const contract = await tx.query.contracts.findFirst({ where: eq(contracts.id, contractId) });
  if (!contract) throw new BoqImportError('Kontrak tidak ditemukan pada perusahaan aktif.', 'foreign_contract', { contractId });
  // an addendum normally comes with a revised RAB: the BOQ must match the DPP in force, not the original
  const addendums = await tx.select().from(contractAddendums).where(eq(contractAddendums.contractId, contract.id));
  const dppCents = effectiveContract(contract, addendums).valueDppEffectiveCents;
  if (dppCents <= 0) throw new BoqImportError('Nilai DPP kontrak harus > 0.', 'contract_invalid', { contractId });

  const parsed = await parseBoqWorkbook(file, opt.sheet ?? 'RAB');
  const diff = parsed.totalCents - dppCents;
  const base = {
    items: parsed.items.length,
    leaves: parsed.items.filter((i) => i.isLeaf).length,
    total: centsToDecimalString(parsed.totalCents),
    contractValueDpp: centsToDecimalString(dppCents),
    diff: centsToDecimalString(diff),
    anomalies: parsed.anomalies,
    footers: parsed.footers,
  };
  if (parsed.items.length === 0) throw new BoqImportError('Sheet tidak berisi item BOQ.', 'row_invalid', base);
  if (diff !== 0) {
    throw new BoqImportError(
      `Total BOQ ${base.total} berbeda dari nilai DPP kontrak ${base.contractValueDpp} (selisih ${base.diff}). Tidak ada data ditulis.`,
      'total_mismatch',
      base,
    );
  }

  const weights = leafWeights(parsed.items, dppCents);
  const rolled = parsed.items.map((it, k) => ({ ...it, weight: it.isLeaf ? weights.get(k)! : 0 }));
  for (const [k, it] of rolled.entries()) {
    if (!it.isLeaf) continue;
    for (let p = it.parentIdx; p !== null; p = rolled[p]!.parentIdx) rolled[p]!.weight += rolled[k]!.weight;
  }

  // new version; previous current version is kept (B3), only its flag flips
  const [agg] = await tx
    .select({ next: sql<number>`coalesce(max(${boqVersions.version}), 0) + 1` })
    .from(boqVersions)
    .where(eq(boqVersions.contractId, contract.id));
  const next = agg?.next ?? 1;
  await tx.update(boqVersions).set({ isCurrent: false }).where(and(eq(boqVersions.contractId, contract.id), eq(boqVersions.isCurrent, true)));
  const [version] = await tx
    .insert(boqVersions)
    .values({
      companyId: contract.companyId,
      contractId: contract.id,
      version: Number(next),
      isCurrent: true,
      sourceFilename: opt.filename ?? null,
      sourceSha256: createHash('sha256').update(file).digest('hex'),
      totalCents: parsed.totalCents,
      anomalies: parsed.anomalies,
      importedBy: opt.importedBy ?? null,
    })
    .returning({ id: boqVersions.id, version: boqVersions.version });
  if (!version) throw new BoqImportError('Gagal membuat versi BOQ.', 'contract_invalid');

  const ids: number[] = [];
  for (const [k, it] of rolled.entries()) {
    const [row] = await tx
      .insert(boqItems)
      .values({
        companyId: contract.companyId,
        versionId: version.id,
        parentId: it.parentIdx === null ? null : ids[it.parentIdx]!,
        code: it.code,
        codePrinted: it.codePrinted,
        description: it.description,
        unit: it.unit,
        qty: it.qty === null ? null : it.qty.toFixed(4),
        unitPriceCents: it.unitPriceCents,
        amountCents: it.amountCents,
        weightMicroPct: it.weight,
        level: it.level,
        isLeaf: it.isLeaf,
        sortOrder: k,
      })
      .returning({ id: boqItems.id });
    ids.push(row!.id);
  }

  return { versionId: version.id, version: version.version, ...base };
}

/**
 * Leaf weights in millionths of a percent, rounded per leaf; the rounding residual goes to the
 * largest leaf so the total is exactly 100.000000 (derived data, not a printed number).
 */
export function leafWeights(items: ParsedItem[], totalCents: Cents): Map<number, number> {
  const w = new Map<number, number>();
  let sum = 0;
  let largest: number | null = null;
  items.forEach((it, k) => {
    if (!it.isLeaf) return;
    const v = Math.round((it.amountCents / totalCents) * MICRO_PCT_TOTAL);
    w.set(k, v);
    sum += v;
    if (largest === null || it.amountCents > items[largest]!.amountCents) largest = k;
  });
  if (largest !== null) w.set(largest, w.get(largest)! + (MICRO_PCT_TOTAL - sum));
  return w;
}
