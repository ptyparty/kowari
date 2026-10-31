import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { Helix, type EditorPort, type Mode } from "./helix.ts";

class FakeEditor implements EditorPort {
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

function key(spec: string): KeyEvent {
  const named = ["escape", "left", "right", "up", "down", "home", "end"];
  if (named.includes(spec)) return { name: spec, ctrl: false, meta: false, shift: false, option: false, sequence: "" } as unknown as KeyEvent;
  return { name: spec.toLowerCase(), ctrl: false, meta: false, shift: spec !== spec.toLowerCase(), option: false, sequence: spec } as unknown as KeyEvent;
}

function setup(text: string, cursor = 0): { editor: FakeEditor; helix: Helix; press: (...keys: string[]) => void } {
  const editor = new FakeEditor(text);
  editor.cursorAt = cursor;
  const helix = new Helix(editor);
  helix.reset();
  const press = (...keys: string[]) => {
    for (const k of keys) helix.handle(key(k));
  };
  return { editor, helix, press };
}

describe("helix normal mode", () => {
  test("w selects to the start of the next word, e to the end of the word, b back", () => {
    const { editor, press } = setup("select id, status from shipment");
    press("w");
    expect(editor.selectedText).toBe("select ");
    press("e");
    expect(editor.selectedText).toBe("id");
    press("w");
    expect(editor.selectedText).toBe(", ");
    press("e");
    expect(editor.selectedText).toBe("status");
    press("b");
    expect(editor.selectedText).toBe("status");
    press("b");
    expect(editor.selectedText).toBe(", ");
  });

  test("wc changes a word", () => {
    const { editor, helix, press } = setup("select id from t");
    press("w", "e", "c");
    expect(helix.mode).toBe("insert");
    editor.type("count(*)");
    press("escape");
    expect(editor.value).toBe("select count(*) from t");
    expect(helix.mode).toBe("normal");
  });

  test("x selects lines and extends on repeat; d deletes them", () => {
    const { editor, press } = setup("select 1;\nselect 2;\nselect 3;", 12);
    press("x");
    expect(editor.selectedText).toBe("select 2;\n");
    press("x");
    expect(editor.selectedText).toBe("select 2;\nselect 3;");
    press("d");
    expect(editor.value).toBe("select 1;\n");
  });

  test("yank a line and paste it below", () => {
    const { editor, press } = setup("select 1;\nselect 2;\n");
    press("x", "y", "p");
    expect(editor.value).toBe("select 1;\nselect 1;\nselect 2;\n");
  });

  test("f and t select to and till a character", () => {
    const { editor, press } = setup("where a = 'x' and b = 1");
    press("f", "'");
    expect(editor.selectedText).toBe("where a = '");
    press(";", "t", "d");
    expect(editor.selectedText).toBe("'x' an");
  });

  test("v extends with every motion", () => {
    const { editor, press } = setup("abc def ghi");
    press("v", "l", "l", "w");
    expect(editor.selectedText).toBe("abc ");
    press("w");
    expect(editor.selectedText).toBe("abc def ");
    press("v", ";");
    expect(editor.selected).toBeNull();
  });

  test("j and k keep the column", () => {
    const { editor, press } = setup("select 1;\nx\nselect 2;", 7);
    press("j");
    expect(editor.cursorAt).toBe(10);
    press("j");
    expect(editor.cursorAt).toBe(19);
  });

  test("gh gl gs gg ge", () => {
    const { editor, press } = setup("  select 1;\nselect 2;", 5);
    press("g", "l");
    expect(editor.cursorAt).toBe(10);
    press("g", "h");
    expect(editor.cursorAt).toBe(0);
    press("g", "s");
    expect(editor.cursorAt).toBe(2);
    press("g", "e");
    expect(editor.cursorAt).toBe(12);
    press("g", "g");
    expect(editor.cursorAt).toBe(0);
  });

  test("i a I A o O enter insert mode in the right place", () => {
    const { editor, helix, press } = setup("  select 1;\nselect 2;", 4);
    press("A");
    expect([helix.mode, editor.cursorAt]).toEqual(["insert", 11]);
    press("escape", "I");
    expect(editor.cursorAt).toBe(2);
    press("escape", "o");
    expect(editor.value).toBe("  select 1;\n\nselect 2;");
    expect(editor.cursorAt).toBe(12);
    press("escape", "u");
    expect(editor.value).toBe("  select 1;\nselect 2;");
    press("U");
    expect(editor.value).toBe("  select 1;\n\nselect 2;");
  });

  test("u undoes a whole change, typing included, and U redoes it", () => {
    const { editor, press } = setup("select id from t");
    press("w", "e", "c");
    editor.type("n");
    editor.type("a");
    editor.type("me");
    press("escape");
    expect(editor.value).toBe("select name from t");
    press("u");
    expect(editor.value).toBe("select id from t");
    press("U");
    expect(editor.value).toBe("select name from t");
  });

  test("an insert session that types nothing leaves nothing to undo", () => {
    const { editor, press } = setup("select 1;");
    press("x", "d");
    press("i", "escape", "u");
    expect(editor.value).toBe("select 1;");
  });

  test("at the start of text that begins with a blank line, h and x stay put", () => {
    const { editor, press } = setup("\nselect 1");
    press("h");
    expect(editor.cursorAt).toBe(0);
    press("x");
    expect(editor.selectedText).toBeNull();
    expect(editor.cursorAt).toBe(0);
  });

  test("ctrl and alt chords do nothing in normal mode", () => {
    const { editor, press, helix } = setup("select 1;");
    press("x");
    helix.handle({ name: "d", ctrl: true, meta: false, shift: false, option: false, sequence: "\x04" } as unknown as KeyEvent);
    helix.handle({ name: "u", ctrl: false, meta: true, shift: false, option: false, sequence: "u" } as unknown as KeyEvent);
    expect(editor.value).toBe("select 1;");
  });

  test("w crosses blank lines", () => {
    const { editor, press } = setup("select 1;\n\n\nselect 2;", 9);
    press("w", "w");
    expect(editor.selectedText).toBe("select ");
  });

  test("x on an empty line selects just that line", () => {
    const { editor, press } = setup("a\n\nfoo", 2);
    press("x");
    expect(editor.selected).toBeNull();
    press("d");
    expect(editor.value).toBe("a\nfoo");
  });

  test("an empty insert session keeps redo", () => {
    const { editor, press } = setup("select 1;");
    press("x", "d", "u", "i", "escape", "U");
    expect(editor.value).toBe("");
  });

  test("never splits an emoji", () => {
    const { editor, press } = setup("a😀b");
    press("l");
    expect(editor.cursorAt).toBe(1);
    press("l");
    expect(editor.cursorAt).toBe(3);
    press("h", "d");
    expect(editor.value).toBe("ab");
  });

  test("j and k keep the column on screen past wide characters", () => {
    const { editor, press } = setup("select '日本' as x;\nselect 2345678901;", 12);
    press("j");
    expect(editor.cursorAt).toBe(18 + 14);
    press("k");
    expect(editor.cursorAt).toBe(12);
  });

  test("pasting in normal mode can be undone", () => {
    const { editor, helix, press } = setup("select ;", 7);
    helix.pasteText("1");
    expect(editor.value).toBe("select 1;");
    press("u");
    expect(editor.value).toBe("select ;");
  });

  test("% selects everything", () => {
    const { editor, press } = setup("select 1;\nselect 2;");
    press("%");
    expect(editor.selectedText).toBe("select 1;\nselect 2;");
  });

  test("normal mode never inserts text", () => {
    const { editor, press } = setup("select 1;");
    press("q", "z", "1", "(");
    expect(editor.value).toBe("select 1;");
  });
});
