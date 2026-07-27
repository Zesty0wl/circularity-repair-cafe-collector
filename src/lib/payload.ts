import { z } from 'zod';

/**
 * What a hub is allowed to send us.
 *
 * Every field is a count, a date, a version or a flag. There is no free text
 * anywhere, on purpose: free text is where personal data hides, and the only
 * way to be certain none arrives is to have nowhere for it to go. Anything not
 * described here is dropped before we store the body.
 */

/** A count that cannot be negative and cannot be silly. */
const count = z.number().int().min(0).max(100_000_000);

/** "2026-07-11". Rejects anything that is not a plain calendar date. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .nullable()
  .optional();

/**
 * A kind of thing that was repaired, keyed by the CO₂ reference vocabulary
 * every install shares. Never the cafe's own category names, which are free
 * text an admin can rename to anything.
 */
const kindOfThing = z.object({
  kind: z.string().max(64).regex(/^[a-z0-9_]+$/, 'expected a reference key'),
  howMany: count,
  fixed: count.optional(),
});

/** Only present at the Community level, when a cafe asked to be on the map. */
const cafeDetails = z
  .object({
    repaircafeSlug: z.string().max(120).nullable().optional(),
    name: z.string().max(200).nullable().optional(),
    publicUrl: z.string().url().max(300).nullable().optional(),
    // Two decimal places is about a kilometre, which is all a map pin needs.
    lat: z.number().min(-90).max(90).nullable().optional(),
    lng: z.number().min(-180).max(180).nullable().optional(),
  })
  .nullable();

export const pingSchema = z.object({
  schemaVersion: z.literal(1),
  level: z.enum(['standard', 'community']),
  installId: z.string().uuid(),
  sentAt: z.string().datetime({ offset: true }),
  app: z.object({
    version: z.string().max(32),
  }),

  howManySessions: count.optional(),
  howManyVenues: count.optional(),
  howManyVolunteers: count.optional(),
  firstSession: isoDate,
  latestSession: isoDate,

  repairsRecorded: count.optional(),
  repairsFixed: count.optional(),
  repairsNotFixed: count.optional(),
  repairsPaused: count.optional(),
  repairsReturned: count.optional(),

  co2: z
    .object({
      enabled: z.boolean().optional(),
      savedKg: z.number().min(0).max(100_000_000).optional(),
      fromThisManyRepairs: count.optional(),
      displacementRate: z.number().min(0).max(1).optional(),
    })
    .optional(),

  // Capped so one install cannot post a megabyte of rows.
  kindsOfThing: z.array(kindOfThing).max(200).optional(),

  featuresInUse: z
    .record(z.union([z.boolean(), count]))
    .refine((v) => Object.keys(v).length <= 50, 'too many feature flags')
    .optional(),

  cafe: cafeDetails.optional(),
});

export type Ping = z.infer<typeof pingSchema>;

/**
 * A cafe only appears on the map if it asked to. Anything sent under the
 * Standard level is thrown away here rather than trusted, so a client bug
 * cannot quietly put somebody on a public map.
 */
export function cafeDetailsFor(body: Ping): {
  slug: string | null;
  name: string | null;
  url: string | null;
  lat: number | null;
  lng: number | null;
} {
  if (body.level !== 'community' || !body.cafe) {
    return { slug: null, name: null, url: null, lat: null, lng: null };
  }
  const round = (n: number | null | undefined) =>
    n === null || n === undefined ? null : Math.round(n * 100) / 100;
  return {
    slug: body.cafe.repaircafeSlug ?? null,
    name: body.cafe.name ?? null,
    url: body.cafe.publicUrl ?? null,
    lat: round(body.cafe.lat),
    lng: round(body.cafe.lng),
  };
}
