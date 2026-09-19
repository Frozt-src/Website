// Real SQLite executes the real migration files; the adapter replaces only the remote D1 transport.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { join } from 'node:path';

const migrationsDir = fileURLToPath(new URL('../../migrations/', import.meta.url));

interface FakeStatement {
  bind(...values: unknown[]): FakeStatement;
  first<T>(column?: string): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }>;
  query: string;
  values: unknown[];
}

function runResult(sql: DatabaseSync, query: string, values: unknown[]) {
  const result = sql.prepare(query).run(...(values as any[]));
  return { success: true as const, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
}

function prepare(sql: DatabaseSync, query: string): FakeStatement {
  const statement: FakeStatement = {
    query,
    values: [],
    bind(...input: unknown[]) { statement.values = input; return statement; },
    async first<T>(column?: string) {
      const row = sql.prepare(query).get(...(statement.values as any[])) as Record<string, unknown> | undefined;
      if (row === undefined) return null;
      return (column === undefined ? row : (row[column] ?? null)) as T;
    },
    async all<T>() {
      return { results: sql.prepare(query).all(...(statement.values as any[])) as T[] };
    },
    async run() {
      return runResult(sql, query, statement.values);
    },
  };
  return statement;
}

export function database() {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys = ON');
  for (const file of readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort()) {
    sql.exec(readFileSync(join(migrationsDir, file), 'utf8'));
  }
  const fakeDb = {
    prepare: (query: string) => prepare(sql, query),
    async batch<T>(statements: FakeStatement[]) {
      sql.exec('BEGIN');
      try {
        const results = statements.map(statement => ({ ...runResult(sql, statement.query, statement.values), results: [] as T[] }));
        sql.exec('COMMIT');
        return results;
      } catch (error) {
        sql.exec('ROLLBACK');
        throw error;
      }
    },
    async exec(query: string) {
      sql.exec(query);
      return { count: 0, duration: 0 };
    },
  };
  return { sql, db: fakeDb as unknown as D1Database };
}
