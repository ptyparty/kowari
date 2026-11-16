import type { KeyEvent } from "@opentui/core";
import { findMatch, keyChar, Undo, type EditorPort, type ModalEditor, type Mode, type Register, type Snapshot } from "./modal.ts";
import {
  charStart,
  classAt,
  column,
  firstNonBlank,
  lastCharOfLine,
  lineEnd,
  lineStart,
  nextChar,
  prevChar,
  verticalMove,
  type Range,
} from "./motions.ts";

type Operator = "d" | "c" | "y";

type Find = "f" | "F" | "t" | "T";

type Pending = "g" | "r" | "i" | "a" | Find | null;

type Visual = "char" | "line" | null;

type Motion = { to: number; kind: "exclusive" | "inclusive" | "linewise" };

type Span = { start: number; end: number; linewise: boolean };

const brackets: Record<string, [string, string]> = {
  "(": ["(", ")"],
  ")": ["(", ")"],
  b: ["(", ")"],
  "[": ["[", "]"],
  "]": ["[", "]"],
  "{": ["{", "}"],
  "}": ["{", "}"],
  B: ["{", "}"],
};

export class Vi implements ModalEditor {
  mode: Mode = "normal";
  private visual: Visual = null;
  private anchor = 0;
  private head = 0;
  private count = "";
  private operator: { op: Operator; count: string } | null = null;
  private pending: Pending = null;
  private lastFind: { how: Find; char: string } | null = null;
  private goal: number | null = null;
  private register: Register | null = null;
  private readonly undo = new Undo();
  private insertSnapshot: Snapshot | null = null;
  private lastSearch = "";

  constructor(private readonly port: EditorPort) {}

  get selection(): Range {
    if (this.visual === null) return { anchor: this.head, head: this.head };
    if (this.visual === "char") return { anchor: this.anchor, head: this.head };
    const text = this.port.text();
    const span = this.lines(text, this.anchor, this.head);
    return { anchor: span.start, head: Math.max(span.start, prevChar(text, span.end)) };
  }

  get pendingKey(): string | null {
    const key = `${this.operator ? `${this.operator.count}${this.operator.op}` : ""}${this.count}${this.pending ?? ""}`;
    return key === "" ? null : key;
  }

  get label(): string {
    if (this.mode === "insert") return "INS";
    if (this.mode === "replace") return "REP";
    if (this.visual === "char") return "VIS";
    if (this.visual === "line") return "VLN";
    return "NOR";
  }

  reset(): void {
    this.mode = "normal";
    this.visual = null;
    this.clearPending();
    this.goal = null;
    this.insertSnapshot = null;
    this.moveTo(this.port.cursor());
    this.port.modeChanged(this.mode);
  }

  beforeExternalChange(): void {
    this.checkpoint();
  }

  follow(index: number): void {
    if (index === this.head) return;
    if (this.visual) {
      this.head = this.clamp(index);
      this.render();
    } else {
      this.moveTo(index);
    }
  }

  pasteText(pasted: string): void {
    this.checkpoint();
    const text = this.port.text();
    if (this.mode === "replace") {
      const at = this.port.cursor();
      const end = Math.min(lineEnd(text, at), this.charsAfter(text, at, [...pasted].length));
      this.port.replace(at, end, pasted);
      this.port.setCursor(at + pasted.length);
      return;
    }
    const at = text.length === 0 ? 0 : this.head;
    this.port.replace(at, at, pasted);
    this.moveTo(Math.max(at, prevChar(this.port.text(), at + pasted.length)));
  }

  search(query: string, backward = false): boolean {
    if (query === "") return false;
    this.lastSearch = query;
    const found = findMatch(this.port.text(), query, this.head, backward);
    if (found < 0) return false;
    if (this.visual) {
      this.head = found;
      this.render();
    } else {
      this.moveTo(found);
    }
    return true;
  }

  claims(key: KeyEvent): boolean {
    return key.ctrl && key.name === "r" && this.mode === "normal";
  }

  handle(key: KeyEvent): boolean {
    if (this.mode === "insert") {
      if (key.name !== "escape") return false;
      this.toNormal();
      return true;
    }
    if (this.mode === "replace") return this.replaceKey(key);
    if (key.ctrl && key.name === "r") this.travel(this.undo.redo(this.snapshot()));
    else if (!key.ctrl && !key.meta) this.normalKey(key);
    return true;
  }

  private normalKey(key: KeyEvent): void {
    const text = this.port.text();
    const char = keyChar(key);
    const name = char ?? key.name;

    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      if (pending === "r") return char ? this.replaceChars(text, char) : this.clearPending();
      if (pending === "i" || pending === "a") return char ? this.textObject(text, pending === "i", char) : this.clearPending();
      if (pending === "g") {
        if (char === "g") return this.motion(text, this.lineMotion(text, this.takeCount(1) - 1));
        return this.clearPending();
      }
      if (!char) return this.clearPending();
      this.lastFind = { how: pending, char };
      return this.motion(text, this.findMotion(text, pending, char, this.takeCount(1)));
    }

    if (name === "escape") {
      this.clearPending();
      if (this.visual) this.exitVisual();
      return;
    }
    if (char && /[1-9]/.test(char) || (char === "0" && this.count !== "")) {
      this.count += char;
      return;
    }
    if (name !== "j" && name !== "k" && name !== "up" && name !== "down") this.goal = null;
    if ((name === "i" || name === "a") && (this.operator || this.visual)) {
      this.pending = name;
      return;
    }
    if (name === "g" || name === "r" || name === "f" || name === "F" || name === "t" || name === "T") {
      if (name === "r" && (this.operator || this.visual)) return this.clearPending();
      this.pending = name;
      return;
    }

    const motion = this.motionFor(text, name);
    if (motion !== undefined) return this.motion(text, motion);

    if (this.operator) {
      if (name === this.operator.op) {
        const lines = this.takeCount(1);
        return this.motion(text, { to: this.lineAfter(text, this.head, lines - 1), kind: "linewise" });
      }
      return this.clearPending();
    }
    if (this.visual) return this.visualKey(text, name);
    this.command(text, name);
  }

  private command(text: string, name: string): void {
    switch (name) {
      case "d":
      case "c":
      case "y":
        this.operator = { op: name, count: this.count };
        this.count = "";
        return;
      case "x":
        return this.shorthand(text, "d", this.motionFor(text, "l")!);
      case "X":
        return this.shorthand(text, "d", this.motionFor(text, "h")!);
      case "s":
        return this.shorthand(text, "c", this.motionFor(text, "l")!);
      case "D":
        return this.shorthand(text, "d", { to: lastCharOfLine(text, this.head), kind: "inclusive" });
      case "C":
        return this.shorthand(text, "c", { to: lastCharOfLine(text, this.head), kind: "inclusive" });
      case "S":
        return this.shorthand(text, "c", { to: this.lineAfter(text, this.head, this.takeCount(1) - 1), kind: "linewise" });
      case "Y":
        return this.shorthand(text, "y", { to: this.lineAfter(text, this.head, this.takeCount(1) - 1), kind: "linewise" });
      case "p":
        return this.paste(text, true);
      case "P":
        return this.paste(text, false);
      case "i":
        return this.insertAt(this.head);
      case "a":
        return this.insertAt(this.head < lineEnd(text, this.head) ? nextChar(text, this.head) : this.head);
      case "I":
        return this.insertAt(firstNonBlank(text, this.head));
      case "A":
        return this.insertAt(lineEnd(text, this.head));
      case "o":
        return this.openLine(text, true);
      case "O":
        return this.openLine(text, false);
      case "R":
        this.count = "";
        this.insertSnapshot = this.snapshot();
        this.mode = "replace";
        this.port.modeChanged(this.mode);
        return;
      case "v":
      case "V":
        this.count = "";
        this.visual = name === "v" ? "char" : "line";
        this.anchor = this.head;
        return this.render();
      case "J":
        return this.join(text, Math.max(2, this.takeCount(2)));
      case "~":
        return this.toggleCase(text, this.head, Math.min(lineEnd(text, this.head), this.charsAfter(text, this.head, this.takeCount(1))), true);
      case "n":
      case "N":
        this.count = "";
        this.search(this.lastSearch, name === "N");
        return;
      case "u":
        this.count = "";
        return this.travel(this.undo.undo(this.snapshot()));
      default:
        this.count = "";
        return;
    }
  }

  private visualKey(text: string, name: string): void {
    this.count = "";
    const motion: Motion = { to: this.head, kind: this.visual === "line" ? "linewise" : "inclusive" };
    switch (name) {
      case "d":
      case "x":
        return this.apply(text, "d", this.anchor, motion);
      case "c":
      case "s":
        return this.apply(text, "c", this.anchor, motion);
      case "y":
        return this.apply(text, "y", this.anchor, motion);
      case "~": {
        const span = this.span(text, this.anchor, motion);
        return this.toggleCase(text, span.start, span.end, false);
      }
      case "J": {
        const first = Math.min(this.anchor, this.head);
        const lines = text.slice(first, Math.max(this.anchor, this.head)).split("\n").length;
        this.exitVisual();
        this.head = first;
        return this.join(text, Math.max(2, lines));
      }
      case "o":
        [this.anchor, this.head] = [this.head, this.anchor];
        return this.render();
      case "v":
      case "V": {
        const kind = name === "v" ? "char" : "line";
        if (this.visual === kind) return this.exitVisual();
        this.visual = kind;
        return this.render();
      }
      default:
        return;
    }
  }

  private motionFor(text: string, name: string): Motion | null | undefined {
    const count = (fallback = 1) => this.takeCount(fallback);
    switch (name) {
      case "h":
      case "left":
      case "backspace": {
        let to = this.head;
        for (let n = count(); n > 0; n--) to = Math.max(lineStart(text, this.head), prevChar(text, to));
        return { to, kind: "exclusive" };
      }
      case "l":
      case "right":
        return { to: Math.min(lineEnd(text, this.head), this.charsAfter(text, this.head, count())), kind: "exclusive" };
      case "j":
      case "down":
        return this.verticalMotion(text, count());
      case "k":
      case "up":
        return this.verticalMotion(text, -count());
      case "w":
      case "W": {
        const big = name === "W";
        if (this.operator?.op === "c" && classAt(text, this.head) !== "space" && classAt(text, this.head) !== "eol") {
          return { to: this.repeat(count(), this.head, (i) => wordEnd(text, i, big, true)), kind: "inclusive" };
        }
        let to = this.repeat(count(), this.head, (i) => wordStart(text, i, big));
        if (this.operator && to > lineEnd(text, this.head) && lineEnd(text, this.head) > this.head) to = lineEnd(text, this.head);
        return { to, kind: "exclusive" };
      }
      case "e":
      case "E":
        return { to: this.repeat(count(), this.head, (i) => wordEnd(text, i, name === "E", false)), kind: "inclusive" };
      case "b":
      case "B":
        return { to: this.repeat(count(), this.head, (i) => wordBack(text, i, name === "B")), kind: "exclusive" };
      case "0":
      case "home":
        return { to: lineStart(text, this.head), kind: "exclusive" };
      case "^":
        this.count = "";
        return { to: firstNonBlank(text, this.head), kind: "exclusive" };
      case "$":
      case "end": {
        const line = this.lineAfter(text, this.head, count() - 1);
        return { to: lastCharOfLine(text, line), kind: "inclusive" };
      }
      case "G": {
        const lines = text.split("\n").length;
        return this.lineMotion(text, (this.count === "" ? lines : this.takeCount(lines)) - 1);
      }
      case ";":
      case ",": {
        const find = this.lastFind;
        const n = count();
        if (!find) return null;
        const how = name === ";" ? find.how : (({ f: "F", F: "f", t: "T", T: "t" }) as const)[find.how];
        return this.findMotion(text, how, find.char, n, true);
      }
      case "%":
        this.count = "";
        return this.matchBracket(text);
      default:
        return undefined;
    }
  }

  private motion(text: string, motion: Motion | null): void {
    if (motion === null) return this.clearPending();
    if (this.operator) {
      const { op } = this.operator;
      this.clearPending();
      return this.apply(text, op, this.head, motion);
    }
    this.count = "";
    if (this.visual) {
      this.head = this.clamp(motion.to, text);
      return this.render();
    }
    this.moveTo(motion.kind === "linewise" && this.goal === null ? firstNonBlank(text, motion.to) : motion.to);
  }

  private shorthand(text: string, op: Operator, motion: Motion): void {
    this.clearPending();
    this.apply(text, op, this.head, motion);
  }

  private apply(text: string, op: Operator, from: number, motion: Motion): void {
    const span = this.span(text, from, motion);
    const wasVisual = this.visual;
    this.visual = null;
    this.port.clearSelection();
    if (op === "y") {
      this.register = this.yank(text, span);
      return this.moveTo(span.linewise ? lineStart(text, Math.min(from, motion.to)) : wasVisual ? span.start : Math.min(from, motion.to));
    }
    if (span.start === span.end && !span.linewise) {
      if (op === "c") this.insertAt(span.start);
      return;
    }
    this.checkpoint(text);
    this.register = this.yank(text, span);
    if (op === "c") {
      const end = span.linewise ? lineEnd(text, span.end - 1) : span.end;
      const start = span.linewise ? lineStart(text, span.start) : span.start;
      this.port.replace(start, Math.max(start, end), "");
      return this.insertAt(start, false);
    }
    let { start, end } = span;
    if (span.linewise && end >= text.length && start > 0) start -= 1;
    if (span.linewise && end > text.length) end = text.length;
    this.port.replace(start, end, "");
    const after = this.port.text();
    this.moveTo(span.linewise ? firstNonBlank(after, Math.min(span.start, Math.max(0, after.length - 1))) : start);
  }

  private span(text: string, from: number, motion: Motion): Span {
    const a = Math.min(from, motion.to);
    const b = Math.max(from, motion.to);
    if (motion.kind === "linewise") return this.lines(text, a, b);
    return { start: a, end: motion.kind === "inclusive" ? Math.min(text.length, nextChar(text, b)) : b, linewise: false };
  }

  private lines(text: string, a: number, b: number): Span {
    const from = Math.min(a, b);
    const end = lineEnd(text, Math.max(a, b));
    return { start: lineStart(text, from), end: end < text.length ? end + 1 : end, linewise: true };
  }

  private yank(text: string, span: Span): Register {
    const slice = text.slice(span.start, span.end);
    return { text: span.linewise && !slice.endsWith("\n") ? `${slice}\n` : slice, linewise: span.linewise };
  }

  private paste(text: string, after: boolean): void {
    const register = this.register;
    const times = this.takeCount(1);
    if (!register) return;
    const insert = register.text.repeat(times);
    this.checkpoint(text);
    if (register.linewise) {
      let at = after ? lineEnd(text, this.head) + 1 : lineStart(text, this.head);
      let body = insert;
      if (at > text.length) {
        at = text.length;
        body = `\n${insert.replace(/\n$/, "")}`;
      }
      this.port.replace(at, at, body);
      return this.moveTo(firstNonBlank(this.port.text(), body.startsWith("\n") ? at + 1 : at));
    }
    const at = after && this.head < lineEnd(text, this.head) ? nextChar(text, this.head) : this.head;
    this.port.replace(at, at, insert);
    this.moveTo(Math.max(at, prevChar(this.port.text(), at + insert.length)));
  }

  private replaceChars(text: string, char: string): void {
    const times = this.takeCount(1);
    this.clearPending();
    const end = this.charsAfter(text, this.head, times);
    if (end > lineEnd(text, this.head) || [...text.slice(this.head, end)].length < times) return;
    this.checkpoint(text);
    this.port.replace(this.head, end, char.repeat(times));
    this.moveTo(this.head + char.length * (times - 1));
  }

  private replaceKey(key: KeyEvent): boolean {
    if (key.name === "escape") {
      this.toNormal();
      return true;
    }
    const at = this.port.cursor();
    const text = this.port.text();
    if (key.name === "return" || key.name === "enter") {
      this.port.replace(at, at, "\n");
      this.port.setCursor(at + 1);
      return true;
    }
    if (key.name === "backspace") {
      this.port.setCursor(Math.max(lineStart(text, at), prevChar(text, at)));
      return true;
    }
    const char = key.ctrl || key.meta ? null : keyChar(key);
    if (char === null) return false;
    this.port.replace(at, at < lineEnd(text, at) ? nextChar(text, at) : at, char);
    this.port.setCursor(at + char.length);
    return true;
  }

  private join(text: string, lines: number): void {
    this.clearPending();
    let joined = text;
    let at = this.head;
    for (let n = 1; n < lines; n++) {
      const end = lineEnd(joined, at);
      if (end >= joined.length) break;
      let next = end + 1;
      while (next < joined.length && (joined[next] === " " || joined[next] === "\t")) next += 1;
      const space = end === lineStart(joined, end) || joined[next] === "\n" || next >= joined.length || joined[next] === ")" || joined[end - 1] === " " ? "" : " ";
      joined = joined.slice(0, end) + space + joined.slice(next);
      at = end;
    }
    if (joined === text) return;
    this.checkpoint(text);
    this.port.restore(joined);
    this.moveTo(at);
  }

  private toggleCase(text: string, start: number, end: number, advance: boolean): void {
    this.clearPending();
    const original = text.slice(start, end);
    const toggled = [...original].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join("");
    this.visual = null;
    if (toggled !== original) {
      this.checkpoint(text);
      this.port.replace(start, end, toggled);
    }
    this.moveTo(advance ? end : start);
  }

  private textObject(text: string, inner: boolean, char: string): void {
    const found = char === "w" || char === "W" ? wordObject(text, this.head, inner, char === "W") : char === "'" || char === '"' || char === "`" ? quoteObject(text, this.head, inner, char) : brackets[char] ? bracketObject(text, this.head, inner, brackets[char]) : null;
    if (!found || found.end <= found.start) {
      if (found && this.operator?.op === "c") {
        this.clearPending();
        return this.insertAt(found.start);
      }
      return this.clearPending();
    }
    if (this.visual) {
      this.count = "";
      this.visual = "char";
      this.anchor = found.start;
      this.head = prevChar(text, found.end);
      return this.render();
    }
    const op = this.operator!.op;
    this.clearPending();
    this.apply(text, op, found.start, { to: prevChar(text, found.end), kind: "inclusive" });
  }

  private findMotion(text: string, how: Find, char: string, times: number, repeat = false): Motion | null {
    let at = this.head;
    for (let n = 0; n < times; n++) {
      const forward = how === "f" || how === "t";
      const till = how === "t" || how === "T";
      let from = at;
      if (till && repeat && n === 0) from = forward ? nextChar(text, at) : prevChar(text, at);
      const found = forward ? text.indexOf(char, nextChar(text, from)) : from <= 0 ? -1 : text.lastIndexOf(char, from - 1);
      if (found < 0 || found >= lineEnd(text, this.head) || found < lineStart(text, this.head)) return null;
      at = till ? (forward ? prevChar(text, found) : nextChar(text, found)) : found;
    }
    return { to: at, kind: how === "f" || how === "t" ? "inclusive" : "exclusive" };
  }

  private matchBracket(text: string): Motion | null {
    const end = lineEnd(text, this.head);
    let at = this.head;
    while (at < end && !"()[]{}".includes(text[at]!)) at += 1;
    if (at >= end) return null;
    const pair = brackets[text[at]!]!;
    const found = text[at] === pair[0] ? closeOf(text, at, pair) : openOf(text, at, pair);
    return found < 0 ? null : { to: found, kind: "inclusive" };
  }

  private verticalMotion(text: string, lines: number): Motion {
    if (this.goal === null) this.goal = column(text, this.head, this.port.measure);
    return { to: verticalMove(text, this.head, lines, this.goal, this.port.measure), kind: "linewise" };
  }

  private lineMotion(text: string, line: number): Motion {
    this.goal = null;
    return { to: this.lineAfter(text, 0, line), kind: "linewise" };
  }

  private lineAfter(text: string, from: number, lines: number): number {
    let start = lineStart(text, from);
    for (let n = 0; n < lines; n++) {
      const end = lineEnd(text, start);
      if (end >= text.length) break;
      start = end + 1;
    }
    return start;
  }

  private charsAfter(text: string, from: number, times: number): number {
    let at = from;
    for (let n = 0; n < times && at < text.length; n++) at = nextChar(text, at);
    return at;
  }

  private repeat(times: number, from: number, step: (i: number) => number): number {
    let at = from;
    for (let n = 0; n < times; n++) at = step(at);
    return at;
  }

  private takeCount(fallback: number): number {
    const own = this.count === "" ? null : Number(this.count);
    const outer = this.operator && this.operator.count !== "" ? Number(this.operator.count) : null;
    this.count = "";
    if (own === null && outer === null) return fallback;
    return (own ?? 1) * (outer ?? 1);
  }

  private clearPending(): void {
    this.count = "";
    this.operator = null;
    this.pending = null;
  }

  private insertAt(index: number, snapshot = true): void {
    this.insertSnapshot = snapshot ? this.snapshot() : null;
    this.mode = "insert";
    this.visual = null;
    this.clearPending();
    this.port.clearSelection();
    this.port.setCursor(index);
    this.port.modeChanged(this.mode);
  }

  private openLine(text: string, below: boolean): void {
    this.count = "";
    const at = below ? lineEnd(text, this.head) : lineStart(text, this.head);
    this.checkpoint(text);
    this.port.replace(at, at, "\n");
    this.insertAt(below ? at + 1 : at, false);
  }

  private toNormal(): void {
    const cursor = this.port.cursor();
    const text = this.port.text();
    if (this.insertSnapshot && this.insertSnapshot.text !== text) this.undo.checkpoint(this.insertSnapshot);
    this.insertSnapshot = null;
    this.mode = "normal";
    this.moveTo(cursor > lineStart(text, cursor) ? prevChar(text, cursor) : cursor);
    this.port.modeChanged(this.mode);
  }

  private exitVisual(): void {
    this.visual = null;
    this.port.clearSelection();
    this.moveTo(this.head);
  }

  private checkpoint(text = this.port.text()): void {
    this.undo.checkpoint({ text, head: this.head });
  }

  private snapshot(): Snapshot {
    return { text: this.port.text(), head: this.head };
  }

  private travel(snapshot: Snapshot | null): void {
    this.clearPending();
    if (!snapshot) return;
    this.port.restore(snapshot.text);
    this.visual = null;
    this.port.clearSelection();
    this.moveTo(snapshot.head);
  }

  private moveTo(index: number): void {
    const text = this.port.text();
    const at = this.clamp(index, text);
    this.head = Math.min(at, lastCharOfLine(text, at));
    this.port.setCursor(this.head);
    this.port.clearSelection();
  }

  private render(): void {
    const text = this.port.text();
    this.port.setCursor(this.head);
    if (this.visual === "line") {
      const span = this.lines(text, this.anchor, this.head);
      this.port.showSelection(span.start, span.end);
    } else {
      this.port.showSelection(Math.min(this.anchor, this.head), Math.min(text.length, nextChar(text, Math.max(this.anchor, this.head))));
    }
  }

  private clamp(index: number, text = this.port.text()): number {
    return charStart(text, Math.max(0, Math.min(index, Math.max(0, text.length - 1))));
  }
}

function bigClass(text: string, i: number): "word" | "space" | "eol" {
  const cls = classAt(text, i);
  return cls === "punct" ? "word" : cls;
}

function classOf(text: string, i: number, big: boolean): string {
  return big ? bigClass(text, i) : classAt(text, i);
}

function wordStart(text: string, i: number, big: boolean): number {
  if (i >= text.length) return i;
  const cls = classOf(text, i, big);
  let j = i;
  if (cls !== "space" && cls !== "eol") while (j < text.length && classOf(text, j, big) === cls) j = nextChar(text, j);
  while (j < text.length) {
    const here = classOf(text, j, big);
    if (here === "space") j = nextChar(text, j);
    else if (here === "eol") {
      j += 1;
      if (text[j] === "\n") return j;
    } else break;
  }
  return j;
}

function wordEnd(text: string, i: number, big: boolean, stayInWord: boolean): number {
  let j = i;
  if (stayInWord) {
    const cls = classOf(text, j, big);
    while (nextChar(text, j) < text.length && classOf(text, nextChar(text, j), big) === cls) j = nextChar(text, j);
    return j;
  }
  if (nextChar(text, j) >= text.length) return j;
  j = nextChar(text, j);
  while (j < text.length && (classOf(text, j, big) === "space" || classOf(text, j, big) === "eol")) j = nextChar(text, j);
  if (j >= text.length) return prevChar(text, text.length);
  const cls = classOf(text, j, big);
  while (nextChar(text, j) < text.length && classOf(text, nextChar(text, j), big) === cls) j = nextChar(text, j);
  return j;
}

function wordBack(text: string, i: number, big: boolean): number {
  if (i <= 0) return 0;
  let j = prevChar(text, i);
  while (j > 0 && (classOf(text, j, big) === "space" || classOf(text, j, big) === "eol")) {
    if (classOf(text, j, big) === "eol" && j > 0 && classOf(text, prevChar(text, j), big) === "eol") return j;
    j = prevChar(text, j);
  }
  const cls = classOf(text, j, big);
  while (j > 0 && classOf(text, prevChar(text, j), big) === cls) j = prevChar(text, j);
  return j;
}

function wordObject(text: string, i: number, inner: boolean, big: boolean): { start: number; end: number } | null {
  if (text.length === 0 || classAt(text, i) === "eol") return null;
  const cls = classOf(text, i, big);
  let start = i;
  while (start > lineStart(text, i) && classOf(text, prevChar(text, start), big) === cls) start = prevChar(text, start);
  let end = i;
  while (end < lineEnd(text, i) && classOf(text, end, big) === cls) end = nextChar(text, end);
  if (inner) return { start, end };
  let after = end;
  while (after < lineEnd(text, i) && classOf(text, after, big) === "space") after = nextChar(text, after);
  if (after > end) return { start, end: after };
  while (start > lineStart(text, i) && classOf(text, prevChar(text, start), big) === "space") start = prevChar(text, start);
  return { start, end };
}

function quoteObject(text: string, i: number, inner: boolean, quote: string): { start: number; end: number } | null {
  const from = lineStart(text, i);
  const line = text.slice(from, lineEnd(text, i));
  const at = i - from;
  const quotes: number[] = [];
  for (let j = 0; j < line.length; j++) if (line[j] === quote) quotes.push(j);
  for (let q = 0; q + 1 < quotes.length; q += 2) {
    const open = quotes[q]!;
    const close = quotes[q + 1]!;
    if (at <= close && (at >= open || q === 0)) return inner ? { start: from + open + 1, end: from + close } : { start: from + open, end: from + close + 1 };
  }
  return null;
}

function bracketObject(text: string, i: number, inner: boolean, pair: [string, string]): { start: number; end: number } | null {
  const open = text[i] === pair[0] ? i : openOf(text, text[i] === pair[1] ? i : i + 1, pair);
  if (open < 0) return null;
  const close = closeOf(text, open, pair);
  if (close < 0) return null;
  return inner ? { start: open + 1, end: close } : { start: open, end: close + 1 };
}

function closeOf(text: string, open: number, [o, c]: [string, string]): number {
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    if (text[j] === o) depth += 1;
    else if (text[j] === c && --depth === 0) return j;
  }
  return -1;
}

function openOf(text: string, before: number, [o, c]: [string, string]): number {
  let depth = 0;
  for (let j = before - 1; j >= 0; j--) {
    if (text[j] === c) depth += 1;
    else if (text[j] === o) {
      if (depth === 0) return j;
      depth -= 1;
    }
  }
  return -1;
}
