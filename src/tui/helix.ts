import type { KeyEvent } from "@opentui/core";
import { findIn, findLastIn } from "./match.ts";
import {
  charStart,
  column,
  findChar,
  firstNonBlank,
  lastCharOfLine,
  lineEnd,
  lineStart,
  nextChar,
  nextWordEnd,
  nextWordStart,
  prevChar,
  prevWordStart,
  selectLines,
  verticalMove,
  type Range,
} from "./motions.ts";

export type Mode = "normal" | "insert";

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

type Pending = "g" | "f" | "F" | "t" | "T" | null;

type Snapshot = { text: string; head: number };

const historyLimit = 200;

export class Helix {
  mode: Mode = "normal";
  private anchor = 0;
  private head = 0;
  private extend = false;
  private linewise = false;
  private pending: Pending = null;
  private goal: number | null = null;
  private register: { text: string; linewise: boolean } | null = null;
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private insertSnapshot: Snapshot | null = null;
  private lastSearch = "";

  constructor(private readonly port: EditorPort) {}

  get selection(): Range {
    return { anchor: this.anchor, head: this.head };
  }

  get pendingKey(): string | null {
    return this.pending;
  }

  get extending(): boolean {
    return this.extend;
  }

  reset(): void {
    this.mode = "normal";
    this.extend = false;
    this.pending = null;
    this.goal = null;
    this.insertSnapshot = null;
    this.collapseTo(this.port.cursor());
    this.port.modeChanged(this.mode);
  }

  beforeExternalChange(): void {
    this.checkpoint();
  }

  follow(index: number): void {
    if (this.extend || index === this.head) return;
    this.anchor = this.clamp(index);
    this.head = this.anchor;
    this.linewise = false;
    this.port.clearSelection();
  }

  pasteText(pasted: string): void {
    this.checkpoint();
    const at = this.start;
    this.port.replace(at, at, pasted);
    this.select({ anchor: at, head: Math.max(at, prevChar(this.port.text(), at + pasted.length)) });
  }

  search(query: string, backward = false): boolean {
    if (query === "") return false;
    this.lastSearch = query;
    const text = this.port.text();
    const found = backward
      ? (() => {
          const before = findLastIn(text, query, this.start);
          return before >= 0 ? before : findLastIn(text, query, text.length + 1);
        })()
      : (() => {
          const after = findIn(text, query, this.start + 1);
          return after >= 0 ? after : findIn(text, query);
        })();
    if (found < 0) return false;
    this.extend = false;
    this.select({ anchor: found, head: prevChar(text, found + query.length) });
    return true;
  }

  handle(key: KeyEvent): boolean {
    if (this.mode === "insert") {
      if (key.name !== "escape") return false;
      this.toNormal();
      return true;
    }
    if (!key.ctrl && !key.meta) this.normalKey(key);
    return true;
  }

  private normalKey(key: KeyEvent): void {
    const text = this.port.text();
    const char = keyChar(key);

    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      if (pending === "g") this.gotoKey(text, char);
      else if (char) this.find(text, char, pending);
      return;
    }

    if (key.name !== "j" && key.name !== "k" && key.name !== "up" && key.name !== "down") this.goal = null;

    switch (char ?? key.name) {
      case "h":
      case "left":
        return this.move(Math.max(lineStart(text, this.head), prevChar(text, this.head)));
      case "l":
      case "right":
        return this.move(Math.min(lastCharOfLine(text, this.head), nextChar(text, this.head)));
      case "j":
      case "down":
        return this.vertical(text, 1);
      case "k":
      case "up":
        return this.vertical(text, -1);
      case "w":
        return this.wordMotion(nextWordStart(text, this.head));
      case "e":
        return this.wordMotion(nextWordEnd(text, this.head));
      case "b":
        return this.wordMotion(prevWordStart(text, this.head));
      case "home":
        return this.move(lineStart(text, this.head));
      case "end":
        return this.move(lastCharOfLine(text, this.head));
      case "g":
      case "f":
      case "F":
      case "t":
      case "T":
        this.pending = (char ?? key.name) as Pending;
        return;
      case "v":
        this.extend = !this.extend;
        return;
      case ";":
        return this.collapseTo(this.head);
      case "escape":
        this.extend = false;
        return this.collapseTo(this.head);
      case "x": {
        const extend = this.linewise;
        this.select(selectLines(text, this.selection, extend));
        this.linewise = true;
        return;
      }
      case "%":
        return this.select({ anchor: 0, head: text.length - 1 });
      case "d":
        return this.delete(text, false);
      case "c":
        return this.delete(text, true);
      case "y":
        this.yank(text);
        return;
      case "p":
        return this.paste(text, true);
      case "P":
        return this.paste(text, false);
      case "i":
        return this.insertAt(this.start);
      case "a":
        return this.insertAt(this.endExclusive(text));
      case "I":
        return this.insertAt(firstNonBlank(text, this.head));
      case "A":
        return this.insertAt(lineEnd(text, this.head));
      case "o":
        return this.openLine(text, true);
      case "O":
        return this.openLine(text, false);
      case "n":
        this.search(this.lastSearch);
        return;
      case "N":
        this.search(this.lastSearch, true);
        return;
      case "u":
        return this.travel(this.undoStack, this.redoStack);
      case "U":
        return this.travel(this.redoStack, this.undoStack);
      default:
        return;
    }
  }

  private gotoKey(text: string, char: string | null): void {
    switch (char) {
      case "h":
        return this.move(lineStart(text, this.head));
      case "l":
        return this.move(lastCharOfLine(text, this.head));
      case "s":
        return this.move(firstNonBlank(text, this.head));
      case "g":
        return this.move(0);
      case "e":
        return this.move(lineStart(text, Math.max(0, text.length - 1)));
      default:
        return;
    }
  }

  private find(text: string, char: string, how: Exclude<Pending, "g" | null>): void {
    const found = findChar(text, this.head, char, how === "f" || how === "t", how === "t" || how === "T");
    if (found) this.wordMotion(found);
  }

  private get start(): number {
    return Math.min(this.anchor, this.head);
  }

  private get end(): number {
    return Math.max(this.anchor, this.head);
  }

  private endExclusive(text: string): number {
    return Math.min(text.length, nextChar(text, this.end));
  }

  private move(index: number): void {
    if (this.extend) this.select({ anchor: this.anchor, head: index });
    else this.collapseTo(index);
  }

  private vertical(text: string, lines: number): void {
    if (this.goal === null) this.goal = column(text, this.head, this.port.measure);
    this.move(verticalMove(text, this.head, lines, this.goal, this.port.measure));
  }

  private wordMotion(range: Range): void {
    if (this.extend) this.select({ anchor: this.anchor, head: range.head });
    else this.select(range);
  }

  private checkpoint(text = this.port.text()): void {
    this.push(this.undoStack, { text, head: this.head });
    this.redoStack = [];
  }

  private push(stack: Snapshot[], snapshot: Snapshot): void {
    stack.push(snapshot);
    if (stack.length > historyLimit) stack.shift();
  }

  private travel(from: Snapshot[], to: Snapshot[]): void {
    const snapshot = from.pop();
    if (!snapshot) return;
    this.push(to, { text: this.port.text(), head: this.head });
    this.port.restore(snapshot.text);
    this.extend = false;
    this.collapseTo(snapshot.head);
  }

  private delete(text: string, thenInsert: boolean): void {
    if (text.length === 0) {
      if (thenInsert) this.insertAt(0);
      return;
    }
    this.checkpoint(text);
    this.yank(text);
    const start = this.start;
    this.port.replace(start, this.endExclusive(text), "");
    this.extend = false;
    if (thenInsert) this.insertAt(start, false);
    else this.collapseTo(start);
  }

  private yank(text: string): void {
    const selected = text.slice(this.start, this.endExclusive(text));
    this.register = { text: selected, linewise: selected.endsWith("\n") && this.start === lineStart(text, this.start) };
  }

  private paste(text: string, after: boolean): void {
    const register = this.register;
    if (!register) return;
    let at: number;
    let insert = register.text;
    if (register.linewise) {
      at = after ? lineEnd(text, this.end) + 1 : lineStart(text, this.start);
      if (at > text.length) {
        at = text.length;
        insert = `\n${insert.replace(/\n$/, "")}`;
      }
    } else {
      at = after ? this.endExclusive(text) : this.start;
    }
    this.checkpoint(text);
    this.port.replace(at, at, insert);
    this.extend = false;
    this.select({ anchor: at, head: Math.max(at, prevChar(this.port.text(), at + insert.length)) });
  }

  private insertAt(index: number, snapshot = true): void {
    this.insertSnapshot = snapshot ? { text: this.port.text(), head: this.head } : null;
    this.mode = "insert";
    this.extend = false;
    this.linewise = false;
    this.port.clearSelection();
    this.port.setCursor(index);
    this.port.modeChanged(this.mode);
  }

  private openLine(text: string, below: boolean): void {
    const at = below ? lineEnd(text, this.head) : lineStart(text, this.head);
    this.checkpoint(text);
    this.port.replace(at, at, "\n");
    this.insertAt(below ? at + 1 : at, false);
  }

  private toNormal(): void {
    const cursor = this.port.cursor();
    const text = this.port.text();
    if (this.insertSnapshot && this.insertSnapshot.text !== text) {
      this.push(this.undoStack, this.insertSnapshot);
      this.redoStack = [];
    }
    this.insertSnapshot = null;
    this.mode = "normal";
    this.collapseTo(cursor > lineStart(text, cursor) ? prevChar(text, cursor) : cursor);
    this.port.modeChanged(this.mode);
  }

  private collapseTo(index: number): void {
    this.select({ anchor: index, head: index });
  }

  private select(range: Range): void {
    const text = this.port.text();
    this.anchor = this.clamp(range.anchor, text);
    this.head = this.clamp(range.head, text);
    this.linewise = false;
    this.port.setCursor(this.head);
    if (this.anchor === this.head) this.port.clearSelection();
    else this.port.showSelection(this.start, this.endExclusive(text));
  }

  private clamp(index: number, text = this.port.text()): number {
    return charStart(text, Math.max(0, Math.min(index, Math.max(0, text.length - 1))));
  }
}

function keyChar(key: KeyEvent): string | null {
  const seq = key.sequence;
  if (seq && seq.length === 1 && seq >= " ") return seq;
  if (key.name.length === 1) return key.shift ? key.name.toUpperCase() : key.name;
  return null;
}
