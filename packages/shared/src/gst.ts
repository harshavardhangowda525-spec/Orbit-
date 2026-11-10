/**
 * GST invoice maths (India). Shared by the API (which stores the result) and the
 * web app (live preview), so both always agree to the paisa.
 */
export interface InvoiceLineInput {
  description: string;
  qty: number;
  unitPrice: number;
  /** GST rate in percent: 0, 5, 12, 18 or 28. */
  taxRate: number;
}

export interface InvoiceLine extends InvoiceLineInput {
  taxable: number;
  tax: number;
  amount: number;
}

export interface InvoiceTotals {
  lines: InvoiceLine[];
  subtotal: number;
  taxTotal: number;
  total: number;
  interState: boolean;
  cgst: number;
  sgst: number;
  igst: number;
  /** Per-rate summary printed under the lines. */
  byRate: { rate: number; taxable: number; tax: number }[];
}

export const GST_RATES = [0, 5, 12, 18, 28] as const;

const r2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

/**
 * @param inclusive  prices already include GST (usual for shops and salons)
 * @param registered the seller has a GSTIN; unregistered sellers charge no GST
 * @param sellerState / buyerState  2-digit GST state codes; different states => IGST
 */
export function computeInvoice(
  input: InvoiceLineInput[],
  opts: { inclusive: boolean; registered: boolean; sellerState?: string | null; buyerState?: string | null },
): InvoiceTotals {
  const lines = input.map((l) => {
    const qty = Math.max(0, Number(l.qty) || 0);
    const price = Math.max(0, Number(l.unitPrice) || 0);
    const rate = opts.registered ? Math.max(0, Number(l.taxRate) || 0) : 0;
    const gross = r2(qty * price);
    if (opts.inclusive) {
      const taxable = r2(gross / (1 + rate / 100));
      return { description: l.description, qty, unitPrice: price, taxRate: rate, taxable, tax: r2(gross - taxable), amount: gross };
    }
    const tax = r2((gross * rate) / 100);
    return { description: l.description, qty, unitPrice: price, taxRate: rate, taxable: gross, tax, amount: r2(gross + tax) };
  });
  const subtotal = r2(lines.reduce((s, l) => s + l.taxable, 0));
  const taxTotal = r2(lines.reduce((s, l) => s + l.tax, 0));
  const total = r2(lines.reduce((s, l) => s + l.amount, 0));
  const interState = !!(opts.sellerState && opts.buyerState && opts.sellerState !== opts.buyerState);
  const cgst = interState ? 0 : r2(taxTotal / 2);
  const sgst = interState ? 0 : r2(taxTotal - cgst);
  const igst = interState ? taxTotal : 0;
  const rates = new Map<number, { rate: number; taxable: number; tax: number }>();
  for (const l of lines) {
    const x = rates.get(l.taxRate) ?? { rate: l.taxRate, taxable: 0, tax: 0 };
    x.taxable = r2(x.taxable + l.taxable);
    x.tax = r2(x.tax + l.tax);
    rates.set(l.taxRate, x);
  }
  return { lines, subtotal, taxTotal, total, interState, cgst, sgst, igst, byRate: [...rates.values()].sort((a, b) => a.rate - b.rate) };
}

/** 15 characters: state code, PAN, entity number, Z, checksum. */
export const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function gstinState(gstin: string | null | undefined): string | null {
  const g = (gstin ?? '').toUpperCase().trim();
  return GSTIN_RE.test(g) ? g.slice(0, 2) : null;
}

/** Indian financial year label for a date in the business's time zone: April–March, e.g. "2026-27". */
export function fiscalYear(date: Date, timeZone = 'Asia/Kolkata'): string {
  const [y, m] = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).format(date).split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** e.g. INV/26-27/0007. GST allows at most 16 characters, so the prefix is shortened when needed. */
export function invoiceNumber(prefix: string, fy: string, seq: number): string {
  const tail = `/${fy.length === 7 ? fy.slice(2) : fy}/${String(seq).padStart(4, '0')}`;
  const p = (prefix || 'INV').replace(/[^A-Za-z0-9-]/g, '').toUpperCase().slice(0, Math.max(1, Math.min(4, 16 - tail.length))) || 'I';
  return `${p}${tail}`;
}

export const GST_STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi',
  '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha',
  '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra',
  '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
};
