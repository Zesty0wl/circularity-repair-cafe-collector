import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema.js';

/** drizzle over the D1 binding. Cheap to make, so made per request. */
export function database(d1: D1Database) {
  return drizzle(d1, { schema });
}
export type DB = ReturnType<typeof database>;
