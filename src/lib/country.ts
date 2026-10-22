/**
 * Country codes from the country part of a repaircafe.org address
 * ─────────────────────────────────────────────────────────────────
 * The directory gives an address as free text, and its last part is usually
 * the country, written in whatever language the café used: "France",
 * "Nederland", "UK", "Deutschland", "Belgique". We turn that into the same two
 * letters used everywhere else, using the runtime's own list of country names
 * in the languages Repair Cafés most often write in.
 *
 * Plenty of listings end with a town or a postcode instead. Those give null:
 * no country is better than a wrong one.
 */

const LANGUAGES = ['en', 'fr', 'nl', 'de', 'da', 'es', 'it', 'pt', 'sv', 'nb', 'fi', 'pl', 'cs'];

/** Short forms the runtime does not know, but cafés write anyway. */
const ALIASES: Record<string, string> = {
  uk: 'GB',
  'u.k.': 'GB',
  'great britain': 'GB',
  england: 'GB',
  scotland: 'GB',
  wales: 'GB',
  'northern ireland': 'GB',
  usa: 'US',
  'u.s.a.': 'US',
  us: 'US',
  'united states of america': 'US',
};

/** Region codes that are not countries. */
const NOT_COUNTRIES = new Set(['EU', 'EZ', 'UN', 'ZZ', 'QO', 'XA', 'XB']);

function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^the\s+/, '')
    .trim();
}

let byName: Map<string, string> | null = null;

/** Every country name in every language above, built once per isolate. */
function names(): Map<string, string> {
  if (byName) return byName;
  const map = new Map<string, string>();
  const displays = LANGUAGES.map((lang) => new Intl.DisplayNames([lang], { type: 'region', fallback: 'none' }));
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const a of letters) {
    for (const b of letters) {
      const code = a + b;
      if (NOT_COUNTRIES.has(code)) continue;
      // Old codes such as FX (mainland France) and UK share their country's
      // name. The runtime knows them as aliases, so keep only the real one.
      let canonical: string | undefined;
      try {
        canonical = Intl.getCanonicalLocales(`und-${code}`)[0]?.split('-')[1];
      } catch {
        canonical = undefined;
      }
      if (canonical !== code) continue;
      for (const display of displays) {
        let name: string | undefined;
        try {
          name = display.of(code);
        } catch {
          name = undefined;
        }
        if (name && name !== code) map.set(fold(name), code);
      }
    }
  }
  byName = map;
  return map;
}

/** Two letters for a country name, or null when it is not one we recognise. */
export function countryCode(text: string | null | undefined): string | null {
  if (!text) return null;
  const key = fold(text);
  if (!key) return null;
  return ALIASES[key] ?? names().get(key) ?? null;
}
