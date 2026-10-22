import { describe, expect, it } from 'vitest';
import { countryCode } from '../src/lib/country';

describe('country codes from a listing address', () => {
  it.each([
    ['France', 'FR'],
    ['Nederland', 'NL'],
    ['Deutschland', 'DE'],
    ['Belgique', 'BE'],
    ['België', 'BE'],
    ['Österreich', 'AT'],
    ['Danmark', 'DK'],
    ['Verenigd Koninkrijk', 'GB'],
    ['United Kingdom', 'GB'],
    ['UK', 'GB'],
    ['USA', 'US'],
    ['The Netherlands', 'NL'],
  ])('%s is %s', (name, code) => {
    expect(countryCode(name)).toBe(code);
  });

  it.each([['79000'], ['Villeneuve-Loubet'], [''], [null]])('%s is not a country', (text) => {
    expect(countryCode(text)).toBeNull();
  });
});
