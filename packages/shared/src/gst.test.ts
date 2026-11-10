import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeInvoice, fiscalYear, gstinState, invoiceNumber } from './gst';

test('GST inclusive prices split into taxable value and CGST + SGST within the state', () => {
  const r = computeInvoice([{ description: 'Haircut', qty: 1, unitPrice: 590, taxRate: 18 }], { inclusive: true, registered: true, sellerState: '29', buyerState: null });
  assert.equal(r.total, 590);
  assert.equal(r.subtotal, 500);
  assert.equal(r.taxTotal, 90);
  assert.deepEqual([r.cgst, r.sgst, r.igst, r.interState], [45, 45, 0, false]);
});

test('GST exclusive prices add tax; another state means IGST', () => {
  const r = computeInvoice(
    [{ description: 'Consultation', qty: 2, unitPrice: 1000, taxRate: 18 }, { description: 'Kit', qty: 1, unitPrice: 333.33, taxRate: 12 }],
    { inclusive: false, registered: true, sellerState: '29', buyerState: '27' },
  );
  assert.equal(r.subtotal, 2333.33);
  assert.equal(r.taxTotal, 400);
  assert.equal(r.total, 2733.33);
  assert.deepEqual([r.cgst, r.sgst, r.igst, r.interState], [0, 0, 400, true]);
  assert.deepEqual(r.byRate.map((x) => x.rate), [12, 18]);
});

test('CGST and SGST always add up to the tax, even with odd paise', () => {
  const r = computeInvoice([{ description: 'x', qty: 1, unitPrice: 100.01, taxRate: 5 }], { inclusive: false, registered: true, sellerState: '29', buyerState: '29' });
  assert.equal(r.taxTotal, 5);
  assert.equal(r.cgst + r.sgst, r.taxTotal);
});

test('sellers without a GSTIN charge no GST', () => {
  const r = computeInvoice([{ description: 'Haircut', qty: 1, unitPrice: 500, taxRate: 18 }], { inclusive: true, registered: false });
  assert.deepEqual([r.subtotal, r.taxTotal, r.total], [500, 0, 500]);
});

test('GSTIN, financial year and invoice numbers', () => {
  assert.equal(gstinState('29ABCDE1234F1Z5'), '29');
  assert.equal(gstinState('29abcde1234f1z5'), '29');
  assert.equal(gstinState('not-a-gstin'), null);
  assert.equal(fiscalYear(new Date('2026-03-31T19:00:00Z')), '2026-27'); // already 1 April in India
  assert.equal(fiscalYear(new Date('2026-03-31T10:00:00Z')), '2025-26');
  assert.equal(invoiceNumber('inv', '2026-27', 7), 'INV/26-27/0007');
  assert.equal(invoiceNumber('GLOWSTUDIO', '2026-27', 7), 'GLOW/26-27/0007');
  assert.ok(invoiceNumber('GLOWSTUDIO', '2026-27', 12345).length <= 16);
});
