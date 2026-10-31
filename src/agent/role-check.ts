import type { Sql } from "postgres";

export type RoleProblem = { kind: string; detail: string };

const powerfulPredefinedRoles = [
  "pg_write_all_data",
  "pg_execute_server_program",
  "pg_read_server_files",
  "pg_write_server_files",
  "pg_signal_backend",
  "pg_signal_autovacuum_worker",
  "pg_maintain",
  "pg_create_subscription",
  "pg_checkpoint",
];

const systemSchemaFilter = `n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp%'`;

export async function checkAgentRole(sql: Sql): Promise<RoleProblem[]> {
  const checks = await Promise.all([
    attributeProblems(sql),
    membershipProblems(sql),
    tableProblems(sql),
    sequenceProblems(sql),
    schemaProblems(sql),
    databaseProblems(sql),
    ownershipProblems(sql),
    remoteAccessProblems(sql),
  ]);
  return checks.flat();
}

async function attributeProblems(sql: Sql): Promise<RoleProblem[]> {
  const rows = await sql.unsafe<{ attr: string }[]>(`
    select attr
    from pg_roles r,
      lateral (values
        ('superuser', r.rolsuper),
        ('createrole', r.rolcreaterole),
        ('createdb', r.rolcreatedb),
        ('bypassrls', r.rolbypassrls),
        ('replication', r.rolreplication)
      ) a(attr, has)
    where r.rolname = current_user and a.has
  `, [], { simple: false });
  return rows.map((r) => ({ kind: "role attribute", detail: `${r.attr}` }));
}

async function membershipProblems(sql: Sql): Promise<RoleProblem[]> {
  const rows = await sql.unsafe<{ rolname: string; reason: string }[]>(`
    select r.rolname,
      case
        when r.rolname = any($1::text[]) then ''
        when r.rolsuper then ', a superuser'
        when r.rolcreaterole or r.rolcreatedb or r.rolbypassrls or r.rolreplication then ', which has elevated attributes'
        else ', which can write tables'
      end as reason
    from pg_roles r
    where r.rolname <> current_user
      and pg_has_role(current_user, r.oid, 'MEMBER')
      and (r.rolname = any($1::text[])
        or (r.rolname not like 'pg\\_%' and (
          r.rolsuper or r.rolcreaterole or r.rolcreatedb or r.rolbypassrls or r.rolreplication
          or exists (
            select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where ${systemSchemaFilter}
              and c.relkind in ('r', 'p', 'v', 'm', 'f')
              and (has_table_privilege(r.oid, c.oid, 'INSERT') or has_table_privilege(r.oid, c.oid, 'UPDATE')
                   or has_table_privilege(r.oid, c.oid, 'DELETE') or has_table_privilege(r.oid, c.oid, 'TRUNCATE'))))))
    order by r.rolname
  `, [powerfulPredefinedRoles], { simple: false });
  return rows.map((r) => ({ kind: "role membership", detail: `member of ${r.rolname}${r.reason}` }));
}

async function tableProblems(sql: Sql): Promise<RoleProblem[]> {
  const rows = await sql.unsafe<{ rel: string; privs: string }[]>(`
    select format('%I.%I', n.nspname, c.relname) as rel, string_agg(p.priv, ', ' order by p.priv) as privs
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES']
      || case when current_setting('server_version_num')::int >= 170000 then array['MAINTAIN'] else array[]::text[] end) p(priv)
    where ${systemSchemaFilter}
      and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and (has_table_privilege(c.oid, p.priv)
           or (p.priv in ('INSERT', 'UPDATE') and has_any_column_privilege(c.oid, p.priv)))
    group by 1
    order by 1
  `, [], { simple: false });
  return rows.map((r) => ({ kind: "table privilege", detail: `${r.privs} on ${r.rel}` }));
}

async function sequenceProblems(sql: Sql): Promise<RoleProblem[]> {
  const rows = await sql.unsafe<{ rel: string }[]>(`
    select format('%I.%I', n.nspname, c.relname) as rel
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where ${systemSchemaFilter}
      and c.relkind = 'S'
      and (has_sequence_privilege(c.oid, 'UPDATE') or has_sequence_privilege(c.oid, 'USAGE'))
    order by 1
  `, [], { simple: false });
  return rows.map((r) => ({ kind: "sequence privilege", detail: `can advance ${r.rel}` }));
}

async function schemaProblems(sql: Sql): Promise<RoleProblem[]> {
  const rows = await sql.unsafe<{ nspname: string }[]>(`
    select n.nspname
    from pg_namespace n
    where ${systemSchemaFilter} and has_schema_privilege(n.oid, 'CREATE')
    order by 1
  `, [], { simple: false });
  return rows.map((r) => ({ kind: "schema privilege", detail: `CREATE on schema ${r.nspname}` }));
}

async function databaseProblems(sql: Sql): Promise<RoleProblem[]> {
  const [row] = await sql.unsafe<{ can: boolean }[]>(
    `select has_database_privilege(current_database(), 'CREATE') as can`,
    [],
    { simple: false },
  );
  return row?.can ? [{ kind: "database privilege", detail: "CREATE on the database" }] : [];
}

async function ownershipProblems(sql: Sql): Promise<RoleProblem[]> {
  const rows = await sql.unsafe<{ what: string }[]>(`
    select format('%s %I.%I', case c.relkind when 'S' then 'sequence' when 'v' then 'view' else 'table' end, n.nspname, c.relname) as what
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where ${systemSchemaFilter} and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
      and pg_has_role(current_user, c.relowner, 'USAGE')
    union all
    select format('schema %I', n.nspname)
    from pg_namespace n
    where ${systemSchemaFilter} and pg_has_role(current_user, n.nspowner, 'USAGE')
    union all
    select format('function %s', p.oid::regprocedure)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where ${systemSchemaFilter} and pg_has_role(current_user, p.proowner, 'USAGE')
    order by 1
  `, [], { simple: false });
  return rows.map((r) => ({ kind: "ownership", detail: `owns ${r.what}` }));
}

async function remoteAccessProblems(sql: Sql): Promise<RoleProblem[]> {
  const [functions, servers, definers] = await Promise.all([
    sql.unsafe<{ fn: string }[]>(`
    select distinct p.proname as fn
    from pg_proc p
    where (p.proname like 'dblink\\_%' or p.proname = 'dblink')
      and has_function_privilege(p.oid, 'EXECUTE')
    order by 1
  `, [], { simple: false }),
    sql.unsafe<{ srvname: string }[]>(`
    select s.srvname from pg_foreign_server s where has_server_privilege(s.oid, 'USAGE') order by 1
  `, [], { simple: false }),
    sql.unsafe<{ fn: string; owner: string; superuser: boolean }[]>(`
    select p.oid::regprocedure::text as fn, o.rolname as owner, o.rolsuper as superuser
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_roles o on o.oid = p.proowner
    where p.prosecdef
      and n.nspname not in ('pg_catalog', 'information_schema')
      and has_function_privilege(p.oid, 'EXECUTE')
      and not pg_has_role(current_user, p.proowner, 'USAGE')
      and (o.rolsuper
           or exists (select 1 from pg_proc d
                      where (d.proname = 'dblink' or d.proname like 'dblink\\_%')
                        and has_function_privilege(o.oid, d.oid, 'EXECUTE'))
           or exists (select 1 from pg_foreign_server s where has_server_privilege(o.oid, s.oid, 'USAGE')))
    order by 1
  `, [], { simple: false }),
  ]);
  return [
    ...(functions.length > 0
      ? [{ kind: "remote access", detail: `can execute ${functions.length} dblink functions` }]
      : []),
    ...servers.map((s) => ({ kind: "remote access", detail: `USAGE on foreign server ${s.srvname}` })),
    ...definers.map((d) => ({
      kind: "remote access",
      detail: `can execute security definer function ${d.fn}, owned by ${d.owner}, ${
        d.superuser ? "a superuser" : "which can open remote connections"
      }`,
    })),
  ];
}
