export function parseDotenv(text: string): Map<string, string> {
  const vars = new Map<string, string>();
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(lines[i]!);
    if (!match) continue;
    const key = match[1]!;
    let rest = match[2]!;

    if (rest.startsWith('"') || rest.startsWith("'")) {
      const quote = rest[0]!;
      let body = rest.slice(1);
      while (!hasClosingQuote(body, quote) && i + 1 < lines.length) {
        i += 1;
        body += `\n${lines[i]}`;
      }
      vars.set(key, quote === '"' ? unescapeDouble(beforeClosingQuote(body, quote)) : beforeClosingQuote(body, quote));
      continue;
    }

    rest = rest.replace(/\s+#.*$/, "");
    vars.set(key, rest.trim());
  }

  return vars;
}

function hasClosingQuote(body: string, quote: string): boolean {
  return closingQuoteIndex(body, quote) >= 0;
}

function beforeClosingQuote(body: string, quote: string): string {
  const end = closingQuoteIndex(body, quote);
  return end >= 0 ? body.slice(0, end) : body;
}

function closingQuoteIndex(body: string, quote: string): number {
  for (let i = 0; i < body.length; i++) {
    if (quote === '"' && body[i] === "\\") {
      i += 1;
      continue;
    }
    if (body[i] === quote) return i;
  }
  return -1;
}

function unescapeDouble(body: string): string {
  return body.replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c));
}
