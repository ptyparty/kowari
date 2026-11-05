export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q === "") return 0;
  let score = 0;
  let at = 0;
  let previous = -2;
  for (const char of q) {
    const found = t.indexOf(char, at);
    if (found < 0) return null;
    score += found === previous + 1 ? 3 : 0;
    score += found === 0 || /[._\s]/.test(t[found - 1]!) ? 2 : 0;
    score -= Math.min(3, found - at);
    previous = found;
    at = found + 1;
  }
  return score - t.length / 100;
}

export function fuzzyFilter<T>(query: string, items: T[], text: (item: T) => string): T[] {
  return items
    .map((item, index) => ({ item, index, score: fuzzyScore(query, text(item)) }))
    .filter((entry): entry is { item: T; index: number; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}

export function findIn(text: string, query: string, from = 0): number {
  if (query === "") return -1;
  return query === query.toLowerCase() ? text.toLowerCase().indexOf(query, from) : text.indexOf(query, from);
}

export function findLastIn(text: string, query: string, before: number): number {
  if (query === "") return -1;
  const haystack = query === query.toLowerCase() ? text.toLowerCase() : text;
  return before <= 0 ? -1 : haystack.lastIndexOf(query, before - 1);
}
