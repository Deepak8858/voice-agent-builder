import { parsePhoneNumber, type CountryCode } from 'libphonenumber-js';

/**
 * Normalizes a phone number to E.164 format (+12125551234).
 * Returns null if the number cannot be parsed as valid.
 */
export function normalizePhone(input: string, defaultCountry = 'US'): string | null {
  try {
    const stripped = input.replace(/[^+0-9]/g, '');
    if (stripped.startsWith('+')) {
      const parsed = parsePhoneNumber(stripped, defaultCountry as CountryCode);
      if (parsed?.isValid()) return parsed.format('E.164');
    }
    const parsed = parsePhoneNumber(stripped, defaultCountry as CountryCode);
    if (!parsed?.isValid()) return null;
    return parsed.format('E.164');
  } catch {
    return null;
  }
}
