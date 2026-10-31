import { readFileSync, statSync } from "node:fs";
import { checkServerIdentity, type PeerCertificate } from "node:tls";
import type { Options } from "postgres";
import type { ConnectionParams } from "./resolve.ts";

export const sslModes = ["disable", "prefer", "require", "verify-ca", "verify-full"] as const;

export type SslMode = (typeof sslModes)[number];

export type DriverOptions = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string | undefined;
  ssl: Options<{}>["ssl"];
};

const maxCertBytes = 1024 * 1024;

export function driverOptions(params: ConnectionParams): DriverOptions {
  return {
    host: params.host,
    port: params.port,
    database: params.database,
    user: params.user,
    password: params.password ?? undefined,
    ssl: sslOption(params),
  };
}

export function sslProblem(mode: string, sslrootcert: string | null): string | null {
  if (mode === "allow") return "sslmode allow is not supported; use prefer or disable";
  if (!(sslModes as readonly string[]).includes(mode)) return `sslmode should be one of ${sslModes.join(", ")}`;
  if (mode === "verify-ca" && sslrootcert === null) return "sslmode verify-ca needs an sslrootcert (a CA file, or \"system\")";
  return null;
}

function sslOption(params: ConnectionParams): DriverOptions["ssl"] {
  const verifyCa = params.sslmode === "verify-ca" || (params.sslmode === "require" && params.sslrootcert !== null);
  switch (verifyCa ? "verify-ca" : params.sslmode) {
    case "disable":
      return false;
    case "prefer":
      return "prefer";
    case "require":
      return "require";
    case "verify-ca":
      return { ca: readCa(params.sslrootcert), rejectUnauthorized: true, checkServerIdentity: () => undefined };
    default:
      return {
        ca: readCa(params.sslrootcert),
        rejectUnauthorized: true,
        checkServerIdentity: (_: string, cert: PeerCertificate) => checkServerIdentity(params.host, cert),
      };
  }
}

function readCa(file: string | null): Buffer | undefined {
  if (file === null || file === "system") return undefined;
  const stat = statSync(file);
  if (!stat.isFile()) throw new Error(`sslrootcert ${file} is not a file`);
  if (stat.size > maxCertBytes) throw new Error(`sslrootcert ${file} is larger than a CA bundle should be`);
  return readFileSync(file);
}
