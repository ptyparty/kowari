import type { TextChunk } from "@opentui/core";
import { bg, bold, fg, underline } from "@opentui/core";
import type { AgentResult } from "../agent/read-only.ts";
import { displayValue } from "../format.ts";
import { findIn } from "./match.ts";
import { theme } from "./theme.ts";

export type Rows = Extract<AgentResult, { kind: "rows" }>;

export type GridCursor = { row: number; col: number; top: number; left: number };

export type Line = (string | TextChunk)[];

const maxColumnWidth = 40;
const separator = "  ";
const gutter = 2;

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
  const bodyHeight = Math.max(1, height - 1);
  const top = row < cursor.top ? row : row >= cursor.top + bodyHeight ? row - bodyHeight + 1 : cursor.top;
  const left = col < cursor.left ? col : cursor.left;
  return { row, col, top, left };
}

export type GridLayout = { lines: Line[]; cursor: GridCursor; first: number; last: number; total: number };

const edge = 7;

export type CellAt = { row: number; col: number };

export function searchCells(result: Rows, query: string): CellAt[] {
  const found: CellAt[] = [];
  result.rows.forEach((row, r) => {
    row.forEach((value, c) => {
      if (findIn(flat(displayValue(value)), query) >= 0) found.push({ row: r, col: c });
    });
  });
  return found;
}

export function layoutGrid(result: Rows, cursor: GridCursor, width: number, height: number, search = ""): GridLayout {
  const widths = columnWidths(result);
  const total = widths.length;
  const room = width - gutter;
  let left = cursor.left;
  while (left < cursor.col && !fits(widths, left, cursor.col, room - 2 * edge)) left += 1;
  const leftEdge = left > 0 ? edge : 0;
  let shown = visibleColumns(widths, left, room - leftEdge);
  const moreRight = shown[shown.length - 1]! < total - 1;
  if (moreRight) shown = visibleColumns(widths, left, room - leftEdge - edge);
  const lastShown = shown[shown.length - 1]!;
  const hiddenLeft = left;
  const hiddenRight = total - 1 - lastShown;
  const fixed = { ...cursor, left };
  const used = leftEdge + shown.reduce((sum, col, i) => sum + widths[col]! + (i > 0 ? separator.length : 0), 0) + (hiddenRight > 0 ? edge : 0);
  const lineWidth = Math.min(width, gutter + used + 2);

  const leftMark = (label: string): Line => (hiddenLeft > 0 ? [fg(theme.warning)(label.padEnd(edge))] : []);
  const rightMark = (label: string): Line => (hiddenRight > 0 ? [fg(theme.warning)(label.padStart(edge))] : []);

  const header: Line = ["  ", ...leftMark(`‹ +${hiddenLeft}`)];
  shown.forEach((col, i) => {
    if (i > 0) header.push(separator);
    header.push(bold(fg(theme.muted)(pad(result.columns[col]!.name, widths[col]!))));
  });
  header.push(...rightMark(`+${hiddenRight} ›`));

  const lines: Line[] = [paint(header, lineWidth, theme.surface)];
  const bodyHeight = Math.max(0, height - 1);
  for (let r = fixed.top; r < Math.min(result.rows.length, fixed.top + bodyHeight); r++) {
    const row = result.rows[r]!;
    const selected = r === fixed.row;
    const line: Line = [selected ? fg(theme.accent)("▎ ") : "  ", ...leftMark("‹")];
    shown.forEach((col, i) => {
      if (i > 0) line.push(separator);
      const value = row[col];
      const full = flat(displayValue(value));
      const text = pad(full, widths[col]!);
      const color = value === null || value === undefined ? theme.faint : theme.text;
      const chunks = highlighted(text, findIn(full, search) >= 0 ? search : "", color);
      line.push(...(selected && col === fixed.col ? chunks.map((chunk) => bold(underline(chunk))) : chunks));
    });
    line.push(...rightMark("›"));
    lines.push(paint(line, lineWidth, selected ? theme.selection : r % 2 === 1 ? theme.surface : null));
  }
  return { lines, cursor: fixed, first: left, last: lastShown, total };
}

function highlighted(text: string, search: string, color: string): TextChunk[] {
  if (search === "") return [fg(color)(text)];
  const at = findIn(text, search);
  if (at < 0) return [fg(theme.warning)(text)];
  const end = at + search.length;
  return [fg(color)(text.slice(0, at)), bg(theme.warning)(fg(theme.background)(text.slice(at, end))), fg(color)(text.slice(end))];
}

export function paint(line: Line, width: number, color: string | null): Line {
  const length = line.reduce((sum, part) => sum + Bun.stringWidth(typeof part === "string" ? part : part.text), 0);
  const filled = length < width ? [...line, " ".repeat(width - length)] : line;
  if (color === null) return filled;
  return filled.map((part) => (typeof part !== "string" && part.bg ? part : bg(color)(part)));
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
