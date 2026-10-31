import postgres, { type Sql } from "postgres";
import { createAgentRole } from "./agent-role.ts";

export const adminUrl = process.env.KOWARI_TEST_DATABASE_URL ?? "postgres://kowari:kowari@127.0.0.1:55433/kowari";

export type Fixture = {
  role: string;
  password: string;
  template: string;
  freshDatabase: (options?: Hardening) => Promise<FixtureDatabase>;
  teardown: () => Promise<void>;
};

export type Hardening = { revokeDblink?: boolean; revokeRemoteDefiner?: boolean };

export type FixtureDatabase = {
  name: string;
  adminUrl: string;
  agentUrl: string;
  admin: Sql;
  canaryPid: number;
  snapshot: () => Promise<string>;
  drop: () => Promise<void>;
};

export async function makeFixture(): Promise<Fixture> {
  const tag = `${process.pid}_${Date.now().toString(36)}`;
  const role = `kowari_agent_ro_${tag}`;
  const password = crypto.randomUUID();
  const template = `kowari_escape_tpl_${tag}`;
  const appRole = `kowari_app_${tag}`;
  const root = postgres(adminUrl, { max: 1, onnotice: () => {} });

  await root.unsafe(`create role ${appRole} nologin`);
  await root.unsafe(`create database ${template}`);
  const tpl = postgres(withDatabase(adminUrl, template), { max: 1, onnotice: () => {} });
  await tpl.unsafe(`
    create extension dblink;
    create table victim (id int primary key, v text not null);
    insert into victim values (1, 'one'), (2, 'two'), (3, 'three');
    create sequence victim_seq;
    create function bump() returns int language plpgsql as $$
      begin update victim set v = 'bumped'; return 1; end $$;
    create function definer_bump() returns int language plpgsql security definer as $$
      begin update victim set v = 'definer'; return 1; end $$;
    grant select, update on victim to ${appRole};
    alter function definer_bump() owner to ${appRole};
    create function definer_dblink(conninfo text) returns text language sql security definer as $$
      select dblink_exec(conninfo, 'update victim set v = ''remote''') $$;
  `).simple();
  await createAgentRole(tpl, role, password);
  await tpl.end({ timeout: 1 });

  let counter = 0;
  const databases: FixtureDatabase[] = [];

  return {
    role,
    password,
    template,
    freshDatabase: async (options = {}) => {
      counter += 1;
      const name = `kowari_escape_${tag}_${counter}`;
      await root.unsafe(`create database ${name} template ${template}`);
      await root.unsafe(`grant connect on database ${name} to ${role}`);
      const db = await openFixtureDatabase(name, role, password);
      if (options.revokeDblink) {
        await db.admin.unsafe(`
          do $$ declare f regprocedure; begin
            for f in select p.oid::regprocedure from pg_proc p where p.proname like 'dblink%' loop
              execute format('revoke execute on function %s from public', f);
            end loop;
          end $$
        `);
      }
      if (options.revokeRemoteDefiner) {
        await db.admin.unsafe(`revoke execute on function definer_dblink(text) from public`);
      }
      databases.push(db);
      return db;
    },
    teardown: async () => {
      for (const db of databases) await db.drop().catch(() => {});
      await root.unsafe(`drop database if exists ${template} with (force)`);
      await root.unsafe(`drop role if exists ${role}`);
      await root.unsafe(`drop role if exists ${appRole}`);
      await root.end({ timeout: 1 });
    },
  };
}

async function openFixtureDatabase(name: string, role: string, password: string): Promise<FixtureDatabase> {
  const dbAdminUrl = withDatabase(adminUrl, name);
  const admin = postgres(dbAdminUrl, { max: 2, onnotice: () => {} });
  const canary = postgres(dbAdminUrl, { max: 1, onnotice: () => {}, connection: { application_name: "kowari-canary" } });
  const [canaryRow] = await canary<{ pid: number }[]>`select pg_backend_pid() as pid`;
  const agentUrl = withCredentials(withDatabase(adminUrl, name), role, password);
  let dropped = false;

  return {
    name,
    adminUrl: dbAdminUrl,
    agentUrl,
    admin,
    canaryPid: canaryRow!.pid,
    snapshot: async () => {
      const canaryAlive = await canary`select 1`.then(() => true, () => false);
      const [victim] = await admin
        .unsafe<{ victim: string }[]>(`select md5(string_agg(id || ':' || v, ',' order by id)) as victim from victim`)
        .catch((e: unknown) => [{ victim: `unreadable: ${e instanceof Error ? e.message : String(e)}` }]);
      const [state] = await admin.unsafe<Record<string, unknown>[]>(`
        select
          (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\\_%') as relations,
          (select attname from pg_attribute where attrelid = to_regclass('victim') and attnum > 0 and not attisdropped order by attnum desc limit 1) as last_column,
          (select last_value || ':' || is_called from victim_seq) as seq,
          (select count(*) from pg_largeobject_metadata) as large_objects,
          (select count(*) from pg_locks where locktype = 'advisory') as advisory_locks,
          (select count(*) from pg_prepared_xacts) as prepared_xacts,
          (select count(*) from pg_db_role_setting) as role_settings
      `);
      return JSON.stringify({ ...victim, ...state, canaryAlive });
    },
    drop: async () => {
      if (dropped) return;
      dropped = true;
      await canary.end({ timeout: 1 });
      await admin.end({ timeout: 1 });
      const root = postgres(adminUrl, { max: 1, onnotice: () => {} });
      await root.unsafe(`drop database if exists ${name} with (force)`);
      await root.end({ timeout: 1 });
    },
  };
}

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

function withCredentials(url: string, user: string, password: string): string {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
}
