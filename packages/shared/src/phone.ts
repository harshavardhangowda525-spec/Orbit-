import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

/** Normalise a phone number to E.164. Returns null when it is not a valid number. */
export function toE164(input: string, defaultCountry: CountryCode = 'IN'): string | null {
  const p = parsePhoneNumberFromString(input.trim(), defaultCountry);
  if (!p || !p.isValid()) return null;
  return p.number;
}
