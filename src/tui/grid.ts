import type { TextChunk } from "@opentui/core";
import { bg, bold, fg } from "@opentui/core";
import type { AgentResult } from "../agent/read-only.ts";
import { displayValue } from "../format.ts";
import { theme } from "./theme.ts";

export type Rows = Extract<AgentResult, { kind: "rows" }>;

export type GridCursor = { row: number; col: number; top: number; left: number };

export type Line = (string | TextChunk)[];

const maxColumnWidth = 40;
const separator = " │ ";

const widthCache = new WeakMap<Rows, number[]>();

export function columnWidths(result: Rows): number[] {
  const cached = widthCache.get(result);
  if (cached) return cached;
  const widths = measureColumns(result);
  widthCache.set(result, widths);
  return widths;
}

function measureColumns(result: Rows): number[] {
  return result.columns.map((c, i) =>
    Math.min(
      maxColumnWidth,
      Math.max(c.name.length, 4, ...result.rows.map((row) => flat(displayValue(row[i])).length)),
    ),
  );
}

export function moveCursor(cursor: GridCursor, result: Rows, dRow: number, dCol: number, height: number): GridCursor {
  const rowCount = result.rows.length;
  const colCount = result.columns.length;
  const row = clamp(cursor.row + dRow, 0, Math.max(0, rowCount - 1));
  const col = clamp(cursor.col + dCol, 0, Math.max(0, colCount - 1));
  const bodyHeight = Math.max(1, height - 2);
  const top = row < cursor.top ? row : row >= cursor.top + bodyHeight ? row - bodyHeight + 1 : cursor.top;
  const left = col < cursor.left ? col : cursor.left;
  return { row, col, top, left };
}

export function layoutGrid(result: Rows, cursor: GridCursor, width: number, height: number): { lines: Line[]; cursor: GridCursor } {
  const widths = columnWidths(result);
  let left = cursor.left;
  while (left < cursor.col && !fits(widths, left, cursor.col, width)) left += 1;
  const shown = visibleColumns(widths, left, width);
  const fixed = { ...cursor, left };

  const header: Line = [];
  const rule: Line = [];
  shown.forEach((col, i) => {
    if (i > 0) {
      header.push(fg(theme.border)(separator));
      rule.push(fg(theme.border)("─┼─"));
    }
    header.push(bold(fg(theme.accent)(pad(result.columns[col]!.name, widths[col]!))));
    rule.push(fg(theme.border)("─".repeat(widths[col]!)));
  });

  const lines: Line[] = [header, rule];
  const bodyHeight = Math.max(0, height - 2);
  for (let r = fixed.top; r < Math.min(result.rows.length, fixed.top + bodyHeight); r++) {
    const row = result.rows[r]!;
    const line: Line = [];
    shown.forEach((col, i) => {
      if (i > 0) line.push(fg(theme.border)(separator));
      const value = row[col];
      const text = pad(flat(displayValue(value)), widths[col]!);
      const chunk = value === null || value === undefined ? fg(theme.muted)(text) : fg(theme.text)(text);
      line.push(r === fixed.row && col === fixed.col ? bg(theme.selection)(chunk) : chunk);
    });
    lines.push(line);
  }
  return { lines, cursor: fixed };
}

function visibleColumns(widths: number[], left: number, width: number): number[] {
  const shown: number[] = [];
  let used = 0;
  for (let col = left; col < widths.length; col++) {
    const need = widths[col]! + (shown.length > 0 ? separator.length : 0);
    if (shown.length > 0 && used + need > width) break;
    shown.push(col);
    used += need;
  }
  return shown;
}

function fits(widths: number[], left: number, col: number, width: number): boolean {
  let used = 0;
  for (let c = left; c <= col; c++) used += widths[c]! + (c > left ? separator.length : 0);
  return used <= width;
}

function flat(text: string): string {
  return text.replaceAll("\n", "↵").replaceAll("\t", "→");
}

function pad(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

export function clamp(n: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, n));
}
