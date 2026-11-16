import type { KeyEvent } from "@opentui/core";
import { findIn, findLastIn } from "./match.ts";
import type { Range } from "./motions.ts";

export type Mode = "normal" | "insert" | "replace";

export type EditorPort = {
  text: () => string;
  cursor: () => number;
  setCursor: (index: number) => void;
  showSelection: (start: number, endExclusive: number) => void;
  clearSelection: () => void;
  replace: (start: number, end: number, insert: string) => void;
  restore: (text: string) => void;
  measure: (text: string) => number;
  modeChanged: (mode: Mode) => void;
};

export type ModalEditor = {
  readonly mode: Mode;
  readonly selection: Range;
  readonly pendingKey: string | null;
  readonly label: string;
  reset(): void;
  beforeExternalChange(): void;
  follow(index: number): void;
  pasteText(pasted: string): void;
  search(query: string, backward?: boolean): boolean;
  claims(key: KeyEvent): boolean;
  handle(key: KeyEvent): boolean;
};

export type Snapshot = { text: string; head: number };

export type Register = { text: string; linewise: boolean };

const historyLimit = 200;

export class Undo {
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];

  checkpoint(snapshot: Snapshot): void {
    this.push(this.undoStack, snapshot);
    this.redoStack = [];
  }

  undo(current: Snapshot): Snapshot | null {
    return this.travel(this.undoStack, this.redoStack, current);
  }

  redo(current: Snapshot): Snapshot | null {
    return this.travel(this.redoStack, this.undoStack, current);
  }

  private travel(from: Snapshot[], to: Snapshot[], current: Snapshot): Snapshot | null {
    const snapshot = from.pop();
    if (!snapshot) return null;
    this.push(to, current);
    return snapshot;
  }

  private push(stack: Snapshot[], snapshot: Snapshot): void {
    stack.push(snapshot);
    if (stack.length > historyLimit) stack.shift();
  }
}

export function findMatch(text: string, query: string, from: number, backward: boolean): number {
  if (backward) {
    const before = findLastIn(text, query, from);
    return before >= 0 ? before : findLastIn(text, query, text.length + 1);
  }
  const after = findIn(text, query, from + 1);
  return after >= 0 ? after : findIn(text, query);
}

export function keyChar(key: KeyEvent): string | null {
  const seq = key.sequence;
  if (seq && seq.length === 1 && seq >= " ") return seq;
  if (key.name.length === 1) return key.shift ? key.name.toUpperCase() : key.name;
  return null;
}
