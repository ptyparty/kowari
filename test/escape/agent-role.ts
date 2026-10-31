import type { Sql } from "postgres";

export async function createAgentRole(sql: Sql, role: string, password: string): Promise<void> {
  const ident = sql(role);
  await sql`create role ${ident} login password ${sql.unsafe(quoteLiteral(password))}`;
  await sql`grant connect on database ${sql(await currentDatabase(sql))} to ${ident}`;
  await sql`grant pg_read_all_data to ${ident}`;
}

async function currentDatabase(sql: Sql): Promise<string> {
  const [row] = await sql<{ db: string }[]>`select current_database() as db`;
  return row!.db;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
