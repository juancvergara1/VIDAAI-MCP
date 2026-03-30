/**
 * Database connection to the USER's Neon DB.
 * Connection string comes from environment variable (never our server).
 */

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema.js";

export function createDb(neonUrl: string) {
  const sql = neon(neonUrl);
  return drizzle(sql, { schema });
}

export type UserDb = ReturnType<typeof createDb>;
