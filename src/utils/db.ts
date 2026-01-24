/**
 * Kysely database configuration for direct database access
 * Bypasses RLS policies by using service role connection
 */

import { Kysely, PostgresDialect } from 'kysely';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { getEnv } from './env.ts';

// Database schema types
type Database = {
  webhook_receivers: {
    id: number;
    label: string;
    table_name: string;
    auth_type: string;
    secret: string | null;
    created_at: Date;
    updated_at: Date;
    description: string | null;
    jsonata: string | null;
  };
  webhook_receiver_logs: {
    id: number;
    webhook_receiver_id: number;
    webhook_id: string;
    webhook_timestamp: Date;
    received_timestamp: Date;
    payload: unknown;
    result: number;
    error_message: string | null;
    label: string | null;
    created_at: Date;
    updated_at: Date;
  };
  tables: {
    table_name: string;
    id_column: string | null;
  };
  fields: {
    id: string;
    varchar: string;
    table_name: string;
    field_name: string;
    format: string;
    is_pk: boolean;
    is_nullable: boolean;
  };
};

// Create Kysely instance with Neon serverless Postgres
export function createDb(): Kysely<Database> {
  const connectionString = getEnv('DATABASE_URL');
  
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  // Configure Neon for serverless environments
  neonConfig.fetchConnectionCache = true;

  const pool = new Pool({ connectionString });
  
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool,
    }),
  });
}

export type { Database };
