import crypto from 'node:crypto';
import { ensureSchema, ensureSeedData } from './bootstrap';

type Filter =
  | { kind: 'eq'; column: string; value: any }
  | { kind: 'in'; column: string; values: any[] }
  | { kind: 'is'; column: string; value: any }
  | { kind: 'ilike'; column: string; pattern: string };

type OrderBy = { column: string; ascending: boolean };

type QueryResponse<T = any> = {
  data: T | null;
  error: { message: string } | null;
};

type SelectOptions = { ascending?: boolean };
type UpsertOptions = { onConflict?: string };
type Action = 'select' | 'insert' | 'update' | 'delete' | 'upsert';

interface SqlAdapter {
  query(sql: string, params: any[]): Promise<any[]>;
  quoteId(identifier: string): string;
  paramRef(index: number): string;
  ilikeExpr(quotedColumn: string, paramRef: string): string;
  mutationReturningClause(columns: string[]): string;
}

const TABLES_WITH_APP_GENERATED_ID = new Set<string>([
  'domains',
  'briefs',
  'overleitung_sheets',
  'sheet_questions',
  'brief_sheet_findings',
  'brief_sheet_evaluations',
  'users',
  'interviews',
  'answers',
]);

function withGeneratedId(table: string, row: Record<string, any>): Record<string, any> {
  if (!TABLES_WITH_APP_GENERATED_ID.has(table)) return row;
  if (row.id !== undefined && row.id !== null && String(row.id).trim().length > 0) {
    return row;
  }
  return { ...row, id: crypto.randomUUID() };
}

function normalizeRowsForWrite(
  table: string,
  rows: Record<string, any>[],
): Record<string, any>[] {
  return rows.map((row) => withGeneratedId(table, row));
}

function toError(err: unknown): { message: string } {
  if (err instanceof Error) return { message: err.message };
  return { message: String(err) };
}

function parseColumns(raw: string | undefined): string[] {
  if (!raw || raw.trim() == '*' || raw.trim().length === 0) return ['*'];
  return raw.split(',').map((c) => c.trim()).filter(Boolean);
}

function ensureObjectArray(values: Record<string, any> | Record<string, any>[]): Record<string, any>[] {
  return Array.isArray(values) ? values : [values];
}

function cleanValue(value: any): any {
  if (value === undefined) return null;
  return value;
}

async function dynamicImport(moduleName: string): Promise<any> {
  const importer = new Function('m', 'return import(m);') as (m: string) => Promise<any>;
  return importer(moduleName);
}

class PostgresAdapter implements SqlAdapter {
  private pool: any = null;
  private initPromise: Promise<void> | null = null;

  constructor(private readonly connectionString: string) {}

  private async ensurePool() {
    if (!this.pool) {
      const pg = await dynamicImport('pg');
      const PoolCtor = pg.Pool ?? pg.default?.Pool;
      if (!PoolCtor) {
        throw new Error('pg module loaded but Pool constructor not found');
      }
      this.pool = new PoolCtor({ connectionString: this.connectionString });
    }
  }

  private async ensureInitialized() {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await this.ensurePool();
        await ensureSchema('postgres', async (sql) => {
          await this.pool.query(sql);
        });
        await ensureSeedData('postgres', async (sql) => {
          await this.pool.query(sql);
        });
      })();
    }
    await this.initPromise;
  }

  async query(sql: string, params: any[]): Promise<any[]> {
    await this.ensureInitialized();
    const res = await this.pool.query(sql, params);
    return res.rows;
  }

  quoteId(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  paramRef(index: number): string {
    return `$${index}`;
  }

  ilikeExpr(quotedColumn: string, paramRef: string): string {
    return `${quotedColumn} ILIKE ${paramRef}`;
  }

  mutationReturningClause(columns: string[]): string {
    if (columns.length === 1 && columns[0] === '*') return ' RETURNING *';
    const projection = columns.map((c) => this.quoteId(c)).join(', ');
    return ` RETURNING ${projection}`;
  }
}

class AzureSqlAdapter implements SqlAdapter {
  private sql: any = null;
  private pool: any = null;
  private initPromise: Promise<void> | null = null;

  constructor(private readonly connectionString: string) {}

  private async ensureConnected() {
    if (!this.pool) {
      this.sql = await dynamicImport('mssql');
      const ConnectionPool = this.sql.ConnectionPool ?? this.sql.default?.ConnectionPool;
      if (!ConnectionPool) {
        throw new Error('mssql module loaded but ConnectionPool constructor not found');
      }
      this.pool = new ConnectionPool(this.connectionString);
      await this.pool.connect();
    }
  }

  private async ensureInitialized() {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await this.ensureConnected();
        await ensureSchema('azure_sql', async (sql) => {
          const req = this.pool.request();
          await req.query(sql);
        });
        await ensureSeedData('azure_sql', async (sql) => {
          const req = this.pool.request();
          await req.query(sql);
        });
      })();
    }
    await this.initPromise;
  }

  async query(sql: string, params: any[]): Promise<any[]> {
    await this.ensureInitialized();
    const req = this.pool.request();
    params.forEach((value, index) => req.input(`p${index + 1}`, this.normalizeParam(value)));
    const result = await req.query(sql);
    return result.recordset || [];
  }

  quoteId(identifier: string): string {
    return `[${identifier.replace(/\]/g, ']]')}]`;
  }

  paramRef(index: number): string {
    return `@p${index}`;
  }

  ilikeExpr(quotedColumn: string, paramRef: string): string {
    return `LOWER(${quotedColumn}) LIKE LOWER(${paramRef})`;
  }

  mutationReturningClause(columns: string[]): string {
    const projection =
      columns.length === 1 && columns[0] === '*'
        ? 'inserted.*'
        : columns.map((c) => `inserted.${this.quoteId(c)}`).join(', ');
    return ` OUTPUT ${projection}`;
  }

  private normalizeParam(value: any): any {
    if (value === undefined || value === null) return null;
    if (typeof value === 'object') return JSON.stringify(value);
    return value;
  }
}

class SqlQueryBuilder implements PromiseLike<QueryResponse<any>> {
  private action: Action = 'select';
  private selectColumns: string[] = ['*'];
  private returningColumns: string[] | null = null;
  private filters: Filter[] = [];
  private orders: OrderBy[] = [];
  private payload: any = null;
  private upsertOptions: UpsertOptions = {};
  private expect: 'many' | 'single' | 'maybeSingle' = 'many';

  constructor(
    private readonly adapter: SqlAdapter,
    private readonly table: string,
  ) {}

  select(columns = '*'): this {
    const parsed = parseColumns(columns);
    if (this.action === 'select') this.selectColumns = parsed;
    else this.returningColumns = parsed;
    return this;
  }

  insert(values: Record<string, any> | Record<string, any>[]): this {
    this.action = 'insert';
    this.payload = ensureObjectArray(values);
    return this;
  }

  update(values: Record<string, any>): this {
    this.action = 'update';
    this.payload = values;
    return this;
  }

  delete(): this {
    this.action = 'delete';
    this.payload = null;
    return this;
  }

  upsert(values: Record<string, any> | Record<string, any>[], options: UpsertOptions = {}): this {
    this.action = 'upsert';
    this.payload = ensureObjectArray(values);
    this.upsertOptions = options;
    return this;
  }

  eq(column: string, value: any): this {
    this.filters.push({ kind: 'eq', column, value });
    return this;
  }

  in(column: string, values: any[]): this {
    this.filters.push({ kind: 'in', column, values });
    return this;
  }

  is(column: string, value: any): this {
    this.filters.push({ kind: 'is', column, value });
    return this;
  }

  ilike(column: string, pattern: string): this {
    this.filters.push({ kind: 'ilike', column, pattern });
    return this;
  }

  order(column: string, options: SelectOptions = {}): this {
    this.orders.push({ column, ascending: options.ascending !== false });
    return this;
  }

  single(): this {
    this.expect = 'single';
    return this;
  }

  maybeSingle(): this {
    this.expect = 'maybeSingle';
    return this;
  }

  then<TResult1 = QueryResponse<any>, TResult2 = never>(
    onfulfilled?: ((value: QueryResponse<any>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled ?? undefined, onrejected ?? undefined);
  }

  private async execute(): Promise<QueryResponse<any>> {
    try {
      let rows: any[] = [];
      if (this.action === 'select') rows = await this.executeSelect();
      else if (this.action === 'insert') rows = await this.executeInsert();
      else if (this.action === 'update') rows = await this.executeUpdate();
      else if (this.action === 'delete') rows = await this.executeDelete();
      else if (this.action === 'upsert') rows = await this.executeUpsert();

      if (this.expect === 'single') {
        if (rows.length !== 1) return { data: null, error: { message: `Expected single row, got ${rows.length}` } };
        return { data: rows[0], error: null };
      }
      if (this.expect === 'maybeSingle') {
        if (rows.length > 1) return { data: null, error: { message: `Expected zero or one row, got ${rows.length}` } };
        return { data: rows[0] ?? null, error: null };
      }

      return { data: rows, error: null };
    } catch (err) {
      return { data: null, error: toError(err) };
    }
  }

  private buildWhere(startParamIndex = 1): { clause: string; params: any[]; nextParam: number } {
    const parts: string[] = [];
    const params: any[] = [];
    let idx = startParamIndex;

    for (const filter of this.filters) {
      const col = this.adapter.quoteId(filter.column);

      if (filter.kind === 'eq') {
        parts.push(`${col} = ${this.adapter.paramRef(idx)}`);
        params.push(cleanValue(filter.value));
        idx += 1;
        continue;
      }

      if (filter.kind === 'in') {
        if (!Array.isArray(filter.values) || filter.values.length === 0) {
          parts.push('1 = 0');
          continue;
        }
        const refs: string[] = [];
        for (const value of filter.values) {
          refs.push(this.adapter.paramRef(idx));
          params.push(cleanValue(value));
          idx += 1;
        }
        parts.push(`${col} IN (${refs.join(', ')})`);
        continue;
      }

      if (filter.kind === 'is') {
        parts.push(filter.value === null ? `${col} IS NULL` : `${col} IS NOT NULL`);
        continue;
      }

      if (filter.kind === 'ilike') {
        parts.push(this.adapter.ilikeExpr(col, this.adapter.paramRef(idx)));
        params.push(filter.pattern);
        idx += 1;
      }
    }

    if (parts.length === 0) return { clause: '', params, nextParam: idx };
    return { clause: ` WHERE ${parts.join(' AND ')}`, params, nextParam: idx };
  }

  private buildOrder(): string {
    if (this.orders.length === 0) return '';
    return ` ORDER BY ${this.orders
      .map((o) => `${this.adapter.quoteId(o.column)} ${o.ascending ? 'ASC' : 'DESC'}`)
      .join(', ')}`;
  }

  private tableId(): string {
    return this.adapter.quoteId(this.table);
  }

  private projection(columns: string[]): string {
    if (columns.length === 1 && columns[0] === '*') return '*';
    return columns.map((c) => this.adapter.quoteId(c)).join(', ');
  }

  private async executeSelect(): Promise<any[]> {
    const where = this.buildWhere(1);
    const sql = `SELECT ${this.projection(this.selectColumns)} FROM ${this.tableId()}${where.clause}${this.buildOrder()}`;
    return this.adapter.query(sql, where.params);
  }

  private async executeInsert(): Promise<any[]> {
    const rows = normalizeRowsForWrite(
      this.table,
      ensureObjectArray(this.payload || []),
    );
    if (rows.length === 0) return [];

    const columns = Array.from(new Set(rows.flatMap((r) => Object.keys(r).filter((k) => r[k] !== undefined))));
    if (columns.length === 0) throw new Error('Insert payload has no columns');

    const params: any[] = [];
    const groups: string[] = [];
    let idx = 1;

    for (const row of rows) {
      const refs: string[] = [];
      for (const col of columns) {
        refs.push(this.adapter.paramRef(idx));
        params.push(cleanValue(row[col]));
        idx += 1;
      }
      groups.push(`(${refs.join(', ')})`);
    }

    const returning = this.returningColumns || [];
    const returningClause = returning.length > 0 ? this.adapter.mutationReturningClause(returning) : '';

    const valuesSql = `VALUES ${groups.join(', ')}`;
    const sql =
      this.adapter instanceof AzureSqlAdapter && returningClause
        ? `INSERT INTO ${this.tableId()} (${columns.map((c) => this.adapter.quoteId(c)).join(', ')})${returningClause} ${valuesSql}`
        : `INSERT INTO ${this.tableId()} (${columns.map((c) => this.adapter.quoteId(c)).join(', ')}) ${valuesSql}${returningClause}`;

    return this.adapter.query(sql, params);
  }

  private async executeUpdate(): Promise<any[]> {
    const values = this.payload || {};
    const columns = Object.keys(values).filter((k) => values[k] !== undefined);
    if (columns.length === 0) throw new Error('Update payload has no columns');

    const params: any[] = [];
    const setters: string[] = [];
    let idx = 1;
    for (const col of columns) {
      setters.push(`${this.adapter.quoteId(col)} = ${this.adapter.paramRef(idx)}`);
      params.push(cleanValue(values[col]));
      idx += 1;
    }

    const where = this.buildWhere(idx);
    const returning = this.returningColumns || [];
    const returningClause = returning.length > 0 ? this.adapter.mutationReturningClause(returning) : '';

    const sql = `UPDATE ${this.tableId()} SET ${setters.join(', ')}${returningClause}${where.clause}`;
    return this.adapter.query(sql, [...params, ...where.params]);
  }

  private async executeDelete(): Promise<any[]> {
    const where = this.buildWhere(1);
    await this.adapter.query(`DELETE FROM ${this.tableId()}${where.clause}`, where.params);
    return [];
  }

  private async executeUpsert(): Promise<any[]> {
    const rows = normalizeRowsForWrite(
      this.table,
      ensureObjectArray(this.payload || []),
    );
    if (rows.length === 0) return [];

    const conflictColumns = (this.upsertOptions.onConflict || '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);

    if (conflictColumns.length === 0) return this.executeInsert();
    if (this.adapter instanceof PostgresAdapter) return this.executeUpsertPostgres(rows, conflictColumns);
    return this.executeUpsertMssql(rows, conflictColumns);
  }

  private async executeUpsertPostgres(rows: Record<string, any>[], conflictColumns: string[]): Promise<any[]> {
    const columns = Array.from(new Set(rows.flatMap((r) => Object.keys(r).filter((k) => r[k] !== undefined))));

    const params: any[] = [];
    const groups: string[] = [];
    let idx = 1;

    for (const row of rows) {
      const refs: string[] = [];
      for (const col of columns) {
        refs.push(this.adapter.paramRef(idx));
        params.push(cleanValue(row[col]));
        idx += 1;
      }
      groups.push(`(${refs.join(', ')})`);
    }

    const updateColumns = columns.filter(
      (c) => !conflictColumns.includes(c) && c !== 'id',
    );
    const setClause =
      updateColumns.length > 0
        ? ` DO UPDATE SET ${updateColumns
            .map((c) => `${this.adapter.quoteId(c)} = EXCLUDED.${this.adapter.quoteId(c)}`)
            .join(', ')}`
        : ' DO NOTHING';

    const returning = this.returningColumns || ['*'];
    const sql = `INSERT INTO ${this.tableId()} (${columns.map((c) => this.adapter.quoteId(c)).join(', ')}) VALUES ${groups.join(', ')} ON CONFLICT (${conflictColumns
      .map((c) => this.adapter.quoteId(c))
      .join(', ')})${setClause}${this.adapter.mutationReturningClause(returning)}`;

    return this.adapter.query(sql, params);
  }

  private async executeUpsertMssql(rows: Record<string, any>[], conflictColumns: string[]): Promise<any[]> {
    const returning = this.returningColumns || ['*'];
    const out: any[] = [];

    for (const row of rows) {
      const columns = Object.keys(row).filter((k) => row[k] !== undefined);
      if (columns.length === 0) continue;

      const params: any[] = [];
      let idx = 1;
      const sourceParts: string[] = [];
      const updateCols = columns.filter(
        (c) => !conflictColumns.includes(c) && c !== 'id',
      );

      for (const col of columns) {
        sourceParts.push(`${this.adapter.paramRef(idx)} AS ${this.adapter.quoteId(col)}`);
        params.push(cleanValue(row[col]));
        idx += 1;
      }

      const onClause = conflictColumns
        .map((c) => `target.${this.adapter.quoteId(c)} = src.${this.adapter.quoteId(c)}`)
        .join(' AND ');

      const updateClause =
        updateCols.length > 0
          ? `WHEN MATCHED THEN UPDATE SET ${updateCols
              .map((c) => `${this.adapter.quoteId(c)} = src.${this.adapter.quoteId(c)}`)
              .join(', ')}`
          : '';

      const sql = `MERGE ${this.tableId()} AS target USING (SELECT ${sourceParts.join(', ')}) AS src ON ${onClause} ${updateClause} WHEN NOT MATCHED THEN INSERT (${columns
        .map((c) => this.adapter.quoteId(c))
        .join(', ')}) VALUES (${columns
        .map((c) => `src.${this.adapter.quoteId(c)}`)
        .join(', ')})${this.adapter.mutationReturningClause(returning)};`;

      const rowsOut = await this.adapter.query(sql, params);
      out.push(...rowsOut);
    }

    return out;
  }
}

class SqlCompatClient {
  constructor(private readonly adapter: SqlAdapter) {}

  from(table: string): SqlQueryBuilder {
    return new SqlQueryBuilder(this.adapter, table);
  }
}

export function createSqlCompatClientForPostgres(connectionString: string) {
  return new SqlCompatClient(new PostgresAdapter(connectionString));
}

export function createSqlCompatClientForAzureSql(connectionString: string) {
  return new SqlCompatClient(new AzureSqlAdapter(connectionString));
}
