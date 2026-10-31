import type { AgentResult } from "./read-only.ts";

export type Query = (text: string) => Promise<AgentResult>;

export type Section = { title: string; result: AgentResult };

const userSchemas = `n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp%'`;

export function listTables(query: Query): Promise<AgentResult> {
  return query(`
    select n.nspname as schema,
      c.relname as name,
      case c.relkind
        when 'r' then 'table' when 'p' then 'partitioned table' when 'v' then 'view'
        when 'm' then 'materialized view' when 'f' then 'foreign table'
      end as kind,
      case when c.reltuples < 0 then null else c.reltuples::bigint end as approx_rows,
      pg_size_pretty(pg_total_relation_size(c.oid)) as size
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p', 'v', 'm', 'f') and ${userSchemas} and not c.relispartition
    order by 1, 2
  `);
}

export async function describeTable(query: Query, table: string): Promise<Section[] | { missing: string } | AgentResult> {
  const rel = `to_regclass(${quoteLiteral(table)})`;
  const found = await query(`select ${rel}::text as name`);
  if (found.kind !== "rows") return found;
  if (found.rows[0]?.[0] === null || found.rows[0]?.[0] === undefined) return { missing: table };

  return [
    {
      title: "Columns",
      result: await query(`
        select a.attname as column,
          format_type(a.atttypid, a.atttypmod) as type,
          case when a.attnotnull then 'not null' else 'null' end as nullable,
          pg_get_expr(d.adbin, d.adrelid) as default
        from pg_attribute a
        left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attrelid = ${rel} and a.attnum > 0 and not a.attisdropped
        order by a.attnum
      `),
    },
    {
      title: "Constraints",
      result: await query(`
        select conname as name, pg_get_constraintdef(oid) as definition
        from pg_constraint
        where conrelid = ${rel}
        order by case contype when 'p' then 0 when 'u' then 1 when 'f' then 2 else 3 end, conname
      `),
    },
    {
      title: "Indexes",
      result: await query(`
        select indexrelid::regclass::text as name, pg_get_indexdef(indexrelid) as definition
        from pg_index
        where indrelid = ${rel}
        order by 1
      `),
    },
    {
      title: "Referenced by",
      result: await query(`
        select conrelid::regclass::text as "table", conname as name, pg_get_constraintdef(oid) as definition
        from pg_constraint
        where confrelid = ${rel} and contype = 'f'
        order by 1, 2
      `),
    },
  ];
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
