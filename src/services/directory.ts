import fs from 'node:fs';
import path from 'node:path';

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
 * rather than the whole directory.
 */

const SOURCE_URL = 'https://www.repaircafe.org/wp-json/v1/map';
const TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT =
  'CircularityRepairCafeTelemetry/1.0 (+https://github.com/Zesty0wl/circularity-repair-cafe-collector)';

const CACHE_FILE = process.env.DIRECTORY_CACHE ?? '/data/repair-cafe-directory.json';

export interface DirectoryEntry {
  name: string;
  lat: number;
  lng: number;
  country: string | null;
  /** The website the cafe listed there. Free text, so treated as a hint only. */
  website: string | null;
}

interface Snapshot {
  fetchedAt: string;
  bySlug: Record<string, DirectoryEntry>;
}

let memory: Snapshot | null = null;
let inFlight: Promise<Snapshot | null> | null = null;

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

async function fetchUpstream(): Promise<Snapshot> {
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
  return { fetchedAt: new Date().toISOString(), bySlug };
}

function readDisk(): Snapshot | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) as Snapshot;
    if (!parsed?.bySlug || typeof parsed.fetchedAt !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeDisk(snapshot: Snapshot): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const tmp = `${CACHE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot));
    fs.renameSync(tmp, CACHE_FILE);
  } catch {
    // A cache we cannot write is not worth failing a page render over.
  }
}

function isFresh(s: Snapshot | null): s is Snapshot {
  if (!s) return false;
  const age = Date.now() - new Date(s.fetchedAt).getTime();
  return Number.isFinite(age) && age >= 0 && age < TTL_MS;
}

function refresh(): Promise<Snapshot | null> {
  if (inFlight) return inFlight;
  inFlight = fetchUpstream()
    .then((s) => {
      memory = s;
      writeDisk(s);
      return s;
    })
    .catch(() => null)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * The directory, served immediately even when stale and refreshed behind the
 * scenes, so a visitor never waits on repaircafe.org.
 */
export async function getDirectory(): Promise<Snapshot | null> {
  if (!memory) memory = readDisk();
  if (isFresh(memory)) return memory;
  if (memory) {
    void refresh();
    return memory;
  }
  return refresh();
}

/** Where a cafe is, according to its own public listing. */
export async function lookupSlug(slug: string | null | undefined): Promise<DirectoryEntry | null> {
  if (!slug) return null;
  const dir = await getDirectory();
  return dir?.bySlug[slug.trim().toLowerCase()] ?? null;
}
