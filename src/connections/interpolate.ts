export type Interpolated = { ok: true; value: string } | { ok: false; missing: string[] };

const reference = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export function interpolate(template: string, lookup: (name: string) => string | undefined): Interpolated {
  const missing: string[] = [];
  const value = template.replace(reference, (_, name: string, fallback: string | undefined) => {
    const found = lookup(name);
    if (fallback !== undefined && (found === undefined || found === "")) return fallback;
    if (found !== undefined) return found;
    missing.push(name);
    return "";
  });
  return missing.length > 0 ? { ok: false, missing } : { ok: true, value };
}
