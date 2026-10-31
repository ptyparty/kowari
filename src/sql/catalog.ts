import type { Query } from "../agent/catalog.ts";
import type { AgentResult } from "../agent/read-only.ts";

export type CatalogTable = { schema: string; name: string; kind: string };

export type CatalogColumn = { schema: string; table: string; name: string; type: string };

export type CatalogFunction = { schema: string; name: string; args: string; result: string };

export type Catalog = {
  searchPath: string[];
  schemas: string[];
  tables: CatalogTable[];
  columns: CatalogColumn[];
  functions: CatalogFunction[];
};

export const emptyCatalog: Catalog = { searchPath: [], schemas: [], tables: [], columns: [], functions: [] };

const userSchemas = `n.nspname not in ('information_schema') and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp%'`;

export async function loadCatalog(query: Query): Promise<Catalog> {
  const searchPath = await rows(query(`select unnest(current_schemas(false))::text`));
  const schemas = await rows(query(`select nspname from pg_namespace n where ${userSchemas} and nspname <> 'pg_catalog' order by 1`));
  const tables = await rows(
    query(`
      select n.nspname, c.relname,
        case c.relkind when 'v' then 'view' when 'm' then 'materialized view' when 'f' then 'foreign table' else 'table' end
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p', 'v', 'm', 'f') and ${userSchemas} and n.nspname <> 'pg_catalog' and not c.relispartition
      order by 1, 2
    `),
  );
  const columns = await rows(
    query(`
      select n.nspname, c.relname, a.attname, format_type(a.atttypid, a.atttypmod)
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p', 'v', 'm', 'f') and ${userSchemas} and n.nspname <> 'pg_catalog'
        and a.attnum > 0 and not a.attisdropped
      order by 1, 2, a.attnum
    `),
  );
  const functions = await rows(
    query(`
      select distinct on (n.nspname, p.proname) n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), pg_get_function_result(p.oid)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.prokind in ('f', 'a', 'w') and ${userSchemas} and p.proname !~ '^_'
        and (n.nspname <> 'pg_catalog' or p.proname not like 'pg\\_%')
      order by 1, 2
    `),
  );

  return {
    searchPath: searchPath.map((r) => String(r[0])),
    schemas: schemas.map((r) => String(r[0])),
    tables: tables.map((r) => ({ schema: String(r[0]), name: String(r[1]), kind: String(r[2]) })),
    columns: columns.map((r) => ({ schema: String(r[0]), table: String(r[1]), name: String(r[2]), type: String(r[3]) })),
    functions: functions.map((r) => ({ schema: String(r[0]), name: String(r[1]), args: String(r[2] ?? ""), result: String(r[3] ?? "") })),
  };
}

async function rows(pending: Promise<AgentResult>): Promise<unknown[][]> {
  const result = await pending;
  if (result.kind === "rows") return result.rows;
  throw new Error(result.kind === "error" ? result.message : result.reason);
}
