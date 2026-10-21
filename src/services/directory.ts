import { eq, sql } from 'drizzle-orm';
import type { DB } from '../db/index.js';
import { directory } from '../db/schema.js';

/**
 * Where the pins come from
 * ────────────────────────
 * A cafe that asks to be on our map sends its repaircafe.org slug and nothing
 * else. We then look the name and coordinates up here, in a mirror of the
 * public Repair Café International directory.
 *
 * That is the whole point: it means we never receive or store a cafe's
 * location. The only location on our map is one that cafe already publishes
 * itself on repaircafe.org.
 *
 * A cafe not listed there can send rounded coordinates instead, and those are
 * used as they are.
 *
 * The hub mirrors the same directory for its own world map. This is a smaller
 * copy of that idea: we only need slug to position, so we keep a lookup table
 * rather than the whole directory. It lives in the `directory` table and is
 * replaced once a day by the cron in src/worker.ts.
 */

const SOURCE_URL = 'https://www.repaircafe.org/wp-json/v1/map';
const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT =
  'CircularityRepairCafeTelemetry/1.0 (+https://github.com/Zesty0wl/circularity-repair-cafe-collector)';

export interface DirectoryEntry {
  name: string;
  lat: number;
  lng: number;
  country: string | null;
  /** The website the cafe listed there. Free text, so treated as a hint only. */
  website: string | null;
}

function slugFromLink(link: string | null | undefined): string | null {
  if (!link) return null;
  const m = /\/cafe\/([^/?#]+)/.exec(link);
  return m ? decodeURIComponent(m[1]!).toLowerCase() : null;
}

function parseCoordinate(value: string | null | undefined): { lat: number; lng: number } | null {
  if (!value) return null;
  const [rawLat, rawLng] = value.split(',');
  const lat = Number(rawLat);
  const lng = Number(rawLng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  // A few rows carry 0,0, which is in the Atlantic rather than anywhere real.
  if (lat === 0 && lng === 0) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat: Number(lat.toFixed(5)), lng: Number(lng.toFixed(5)) };
}

/** Some names arrive HTML-escaped, and we render them as text. */
function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç',
    uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß',
  };
  return value
    .replace(/&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
      if (entity.startsWith('#x') || entity.startsWith('#X')) {
        const code = Number.parseInt(entity.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      if (entity.startsWith('#')) {
        const code = Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return named[entity] ?? match;
    })
    .trim();
}

async function fetchUpstream(): Promise<Record<string, DirectoryEntry>> {
  const res = await fetch(SOURCE_URL, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`repaircafe.org responded ${res.status}`);
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body)) throw new Error('repaircafe.org did not return a list');

  const bySlug: Record<string, DirectoryEntry> = {};
  for (const row of body as Array<Record<string, string | null>>) {
    const slug = slugFromLink(row.link);
    const point = parseCoordinate(row.coordinate);
    const name = decodeEntities(row.name ?? '');
    if (!slug || !point || !name) continue;
    // The address is the only country hint the directory gives us, and it is
    // free text, so we take the last comma-separated part and no more.
    const address = decodeEntities(row.address ?? '');
    const country = address.split(',').map((p) => p.trim()).filter(Boolean).pop() ?? null;
    bySlug[slug] = {
      name,
      lat: point.lat,
      lng: point.lng,
      country,
      website: typeof row.external_link === 'string' ? row.external_link : null,
    };
  }
  return bySlug;
}

/** D1 takes at most 100 bound values per statement: 16 rows of 6 columns. */
const ROWS_PER_INSERT = 16;

/**
 * Fetch the directory and replace our copy of it in one transaction, so a
 * reader sees the old copy or the new one and never half of each. If
 * repaircafe.org is down or answers nonsense, the old copy stays.
 */
export async function refreshDirectory(db: DB): Promise<number> {
  const bySlug = await fetchUpstream();
  const rows = Object.entries(bySlug).map(([slug, e]) => ({ slug, ...e }));
  // An empty answer is far more likely to be a fault upstream than every cafe
  // in the world closing at once.
  if (rows.length === 0) throw new Error('repaircafe.org returned no cafes');
  const statements = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    statements.push(db.insert(directory).values(rows.slice(i, i + ROWS_PER_INSERT)));
  }
  await db.batch([db.delete(directory), ...statements]);
  return rows.length;
}

/** Whether we have a copy at all, which is only false before the first refresh. */
export async function haveDirectory(db: DB): Promise<boolean> {
  const [row] = await db.select({ n: sql<number>`COUNT(*)` }).from(directory).limit(1);
  return Number(row?.n ?? 0) > 0;
}

/** Where a cafe is, according to its own public listing. */
export async function lookupSlug(db: DB, slug: string | null | undefined): Promise<DirectoryEntry | null> {
  if (!slug) return null;
  const [row] = await db
    .select()
    .from(directory)
    .where(eq(directory.slug, slug.trim().toLowerCase()))
    .limit(1);
  if (!row) return null;
  return { name: row.name, lat: row.lat, lng: row.lng, country: row.country, website: row.website };
}
