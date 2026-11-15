/** Khata: expense categories (business-editable; these are the defaults) and their colours. */
export const EXPENSE_CATEGORIES = [
  'rent', 'salaries', 'supplies', 'utilities', 'electricity', 'internet', 'marketing', 'equipment', 'repairs', 'transport', 'food', 'professional_fees', 'other',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const CATEGORY_COLORS: Record<string, string> = {
  rent: '#a99bff', salaries: '#ff8fc0', supplies: '#ffc857', utilities: '#7cc4ff', electricity: '#ffdd57', internet: '#5ee0b5', marketing: '#ff9a7a',
  equipment: '#c49bff', repairs: '#f4a261', transport: '#90be6d', food: '#f28482', professional_fees: '#84a59d', other: '#9aa0b4',
};

/** First guess at a category from the vendor and items (the vendor's past choice always wins). */
const HINTS: [RegExp, ExpenseCategory][] = [
  [/bescom|electric|power|mescom|hescom|cesc|tneb|msedcl|bijli|बिजली|ವಿದ್ಯುತ್/i, 'electricity'],
  [/airtel|jio|act fibernet|broadband|internet|bsnl|wifi|hathway/i, 'internet'],
  [/rent|lease|किराया|ಬಾಡಿಗೆ/i, 'rent'],
  [/salary|wages|payroll|वेतन|ಸಂಬಳ/i, 'salaries'],
  [/water|bwssb|gas|lpg|indane|hp gas|bharat gas/i, 'utilities'],
  [/repair|service charge|maintenance|plumb|electrician/i, 'repairs'],
  [/ads|advert|facebook|google ads|meta|print|flex|banner|pamphlet/i, 'marketing'],
  [/uber|ola|rapido|petrol|diesel|fuel|transport|courier|porter/i, 'transport'],
  [/swiggy|zomato|restaurant|tea|coffee|snacks|food/i, 'food'],
  [/ca |chartered|consult|legal|advocate|accountant|professional/i, 'professional_fees'],
  [/machine|chair|dryer|computer|laptop|equipment|furniture/i, 'equipment'],
  [/stock|supplies|wholesale|distributor|traders|mart|store|products/i, 'supplies'],
];
export function guessCategory(vendor: string | null | undefined, items: string[] = [], hint?: string | null): ExpenseCategory {
  const text = [vendor ?? '', ...items].join(' ');
  for (const [re, c] of HINTS) if (re.test(text)) return c;
  if (hint && (EXPENSE_CATEGORIES as readonly string[]).includes(hint)) return hint as ExpenseCategory;
  return 'other';
}

/** "BESCOM Ltd." and "bescom ltd" are the same vendor. */
export function vendorKey(name: string): string {
  return name.toLowerCase().normalize('NFKC').replace(/\b(pvt|private|ltd|limited|llp|co|company|inc)\b\.?/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
