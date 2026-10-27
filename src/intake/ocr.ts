/**
 * OCR in two stages (LLD §6): stage 1 is cheap and rejects fast (document type + photo quality),
 * stage 2 reads the fields. Both return JSON that domain/receipt-validator.ts validates; nothing
 * here interprets numbers.
 *
 * Error contract used by the intake job:
 *   OcrError       transport/provider failure (timeout, 5xx, quota)  → outcome ocr_error, retried
 *   OcrParseError  the model answered, but not with parseable JSON   → tidak_terbaca, not retried
 */
export interface OcrImage { bytes: Buffer; mime: string }
export interface OcrClient {
  classify(image: OcrImage): Promise<unknown>;
  extract(image: OcrImage): Promise<unknown>;
}

export class OcrError extends Error {
  override readonly name = 'OcrError';
}
export class OcrParseError extends Error {
  override readonly name = 'OcrParseError';
}

/**
 * Model text → JSON. Strips a ```json … ``` fence if the model wrapped its answer (LLD §6), then
 * JSON.parse. Anything else is an OcrParseError: never "empty fields".
 */
export function parseModelJson(text: string | null | undefined): unknown {
  if (text == null || text.trim() === '') throw new OcrParseError('Jawaban OCR kosong.');
  let t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1]!;
  try {
    return JSON.parse(t);
  } catch {
    throw new OcrParseError('Jawaban OCR bukan JSON.');
  }
}

const field = { type: 'object', additionalProperties: false, required: ['value', 'confidence'], properties: { value: { type: ['string', 'null'] }, confidence: { type: 'number' } } } as const;

/** JSON Schema for structured output (strict: every key required, nullable instead of optional). */
export const STAGE1_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['doc_type', 'quality', 'reason'],
  properties: {
    doc_type: { type: 'string', enum: ['nota', 'faktur', 'kwitansi', 'bukti_transfer', 'bukan_dokumen'] },
    quality: { type: 'number' },
    reason: { type: 'string' },
  },
} as const;

export const STAGE2_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['invoice_date', 'vendor_name', 'doc_number', 'description', 'line_items', 'subtotal', 'ppn', 'total', 'npwp'],
  properties: {
    invoice_date: field, vendor_name: field, doc_number: field, description: field,
    subtotal: field, ppn: field, total: field, npwp: field,
    line_items: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['desc', 'amount'], properties: { desc: { type: 'string' }, amount: { type: ['string', 'null'] } } },
    },
  },
} as const;

export const STAGE1_PROMPT = [
  'Anda memeriksa satu foto dari lokasi proyek irigasi.',
  'Tentukan jenis dokumen: nota, faktur, kwitansi, bukti_transfer, atau bukan_dokumen.',
  'quality: 0–1, seberapa terbaca angka dan tulisan di foto (buram, terpotong, gelap = rendah).',
  'Jawab hanya JSON sesuai skema.',
].join('\n');

/** Text values, exactly as printed: the server parses money and dates itself and never trusts model arithmetic. */
export const STAGE2_PROMPT = [
  'Baca nota/kwitansi/faktur di foto. Untuk setiap field beri {value, confidence 0–1}.',
  'value adalah TEKS PERSIS seperti tercetak (mis. "Rp 2.450.000,-", "21/06/2026"); jangan menghitung, membulatkan, atau menebak.',
  'Bila tidak terbaca atau tidak ada: value = null, confidence = 0.',
  'invoice_date: tanggal nota. vendor_name: nama toko/penjual. doc_number: nomor nota. description: ringkasan barang/jasa.',
  'line_items: setiap baris barang dengan jumlah per baris (amount). subtotal, ppn, total: seperti tercetak.',
  'npwp: NPWP penjual bila tercetak. Jangan menyalin nomor rekening.',
  'Jawab hanya JSON sesuai skema.',
].join('\n');

export interface OpenAiCompatibleOptions {
  baseUrl: string; // e.g. https://api.openai.com/v1 or a provider's OpenAI-compatible endpoint
  apiKey: string;
  modelStage1: string;
  modelStage2: string;
  timeoutMs?: number; // LLD §9: 60 s
  fetchFn?: typeof fetch;
}

/**
 * Adapter for providers that speak the OpenAI Chat Completions protocol with image input and
 * `response_format: json_schema` (OpenAI, and the OpenAI-compatible endpoints several providers
 * offer). Exercised against a fake server in tests only: confirm with the chosen provider and the
 * 30-photo golden set before the pilot (docs/remaining-work.md §6, decision 8).
 */
export class OpenAiCompatibleOcr implements OcrClient {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opt: OpenAiCompatibleOptions) {
    if (!opt.apiKey) throw new OcrError('OCR_API_KEY kosong.');
    this.fetchFn = opt.fetchFn ?? fetch;
  }

  classify(image: OcrImage): Promise<unknown> {
    return this.complete(this.opt.modelStage1, STAGE1_PROMPT, 'stage1', STAGE1_SCHEMA, image);
  }

  extract(image: OcrImage): Promise<unknown> {
    return this.complete(this.opt.modelStage2, STAGE2_PROMPT, 'stage2', STAGE2_SCHEMA, image);
  }

  private async complete(model: string, prompt: string, name: string, schema: object, image: OcrImage): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.opt.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.opt.apiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.bytes.toString('base64')}` } }] },
          ],
          response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
        }),
        signal: AbortSignal.timeout(this.opt.timeoutMs ?? 60_000),
      });
    } catch (e) {
      throw new OcrError(`OCR ${name}: ${e instanceof Error ? e.name : 'gagal'}`);
    }
    if (!res.ok) throw new OcrError(`OCR ${name}: HTTP ${res.status}`);
    let body: { choices?: Array<{ message?: { content?: string | null; refusal?: string | null } }> };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new OcrError(`OCR ${name}: respons bukan JSON`);
    }
    const msg = body.choices?.[0]?.message;
    if (msg?.refusal) throw new OcrParseError(`OCR ${name}: model menolak`);
    return parseModelJson(msg?.content);
  }
}
