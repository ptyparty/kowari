import type { KeyEvent } from "@opentui/core";
import type { EditorPort, Mode } from "../../src/tui/modal.ts";

export class FakeEditor implements EditorPort {
  cursorAt = 0;
  selected: [number, number] | null = null;
  modes: Mode[] = [];

  constructor(public value: string) {}

  text = () => this.value;
  cursor = () => this.cursorAt;
  setCursor = (i: number) => {
    this.cursorAt = i;
  };
  showSelection = (start: number, end: number) => {
    this.selected = [start, end];
  };
  clearSelection = () => {
    this.selected = null;
  };
  replace = (start: number, end: number, insert: string) => {
    this.value = this.value.slice(0, start) + insert + this.value.slice(end);
    this.cursorAt = start + insert.length;
  };
  restore = (text: string) => {
    this.value = text;
  };
  measure = (text: string) => [...text].reduce((n, c) => n + (/[\u3000-\u9fff]/.test(c) ? 2 : 1), 0);
  modeChanged = (mode: Mode) => {
    this.modes.push(mode);
  };

  type(text: string): void {
    this.replace(this.cursorAt, this.cursorAt, text);
  }

  get selectedText(): string | null {
    return this.selected ? this.value.slice(this.selected[0], this.selected[1]) : null;
  }
}

export function key(spec: string): KeyEvent {
  if (spec.length > 1 && spec.startsWith("^")) return { name: spec.slice(1), ctrl: true, meta: false, shift: false, option: false, sequence: "" } as unknown as KeyEvent;
  const named = ["escape", "left", "right", "up", "down", "home", "end", "backspace", "return"];
  if (named.includes(spec)) return { name: spec, ctrl: false, meta: false, shift: false, option: false, sequence: "" } as unknown as KeyEvent;
  return { name: spec.toLowerCase(), ctrl: false, meta: false, shift: spec !== spec.toLowerCase(), option: false, sequence: spec } as unknown as KeyEvent;
}
