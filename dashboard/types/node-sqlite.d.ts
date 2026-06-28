// Minimal ambient types for Node's experimental built-in SQLite (Node 22+),
// which @types/node@20 doesn't ship yet. Covers only what lib/live.ts uses.
declare module "node:sqlite" {
  interface StatementSync {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  }
  interface DatabaseSyncOptions {
    readOnly?: boolean;
    open?: boolean;
  }
  export class DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions);
    prepare(sql: string): StatementSync;
    exec(sql: string): void;
    close(): void;
  }
}
