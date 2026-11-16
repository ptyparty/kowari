import { describe, expect, test } from "bun:test";
import { FakeEditor, key } from "../../test/support/editor.ts";
import { Vi } from "./vi.ts";

function setup(marked: string): { editor: FakeEditor; vi: Vi; press: (keys: string) => void; marked: () => string } {
  const editor = new FakeEditor(marked.replace("|", ""));
  editor.cursorAt = marked.indexOf("|");
  const vi = new Vi(editor);
  vi.reset();
  const press = (keys: string) => {
    for (const k of keys.match(/<[^>]+>|./gsu) ?? []) {
      const named = k.length > 1;
      if (!vi.handle(key(named ? k.slice(1, -1) : k)) && !named) editor.type(k);
    }
  };
  const marked_ = () => `${editor.value.slice(0, editor.cursorAt)}|${editor.value.slice(editor.cursorAt)}`;
  return { editor, vi, press, marked: marked_ };
}

function after(start: string, keys: string): string {
  const { press, marked } = setup(start);
  press(keys);
  return marked();
}

describe("vi motions", () => {
  test.each([
    ["|select id, status from shipment", "w", "select |id, status from shipment"],
    ["|select id, status from shipment", "ww", "select id|, status from shipment"],
    ["|select id, status from shipment", "3w", "select id, |status from shipment"],
    ["|select id, status from shipment", "W", "select |id, status from shipment"],
    ["|select id, status from shipment", "WW", "select id, |status from shipment"],
    ["|select id\nfrom t", "ww", "select id\n|from t"],
    ["|select\n\nfrom t", "w", "select\n|\nfrom t"],
    ["select id, |status", "b", "select id|, status"],
    ["select id, |status", "B", "select |id, status"],
    ["|select id", "e", "selec|t id"],
    ["|select id", "ee", "select i|d"],
    ["sel|ect", "h", "se|lect"],
    ["sel|ect", "l", "sele|ct"],
    ["selec|t", "l", "selec|t"],
    ["  sel|ect", "0", "|  select"],
    ["  sel|ect", "^", "  |select"],
    ["sel|ect", "$", "selec|t"],
    ["sel|ect\nfrom t\nwhere x", "j", "select\nfro|m t\nwhere x"],
    ["sel|ect\nt\nwhere x", "jj", "select\nt\nwhe|re x"],
    ["select\nfrom t\nwhere |x", "gg", "|select\nfrom t\nwhere x"],
    ["|select\nfrom t\n  where x", "G", "select\nfrom t\n  |where x"],
    ["|select\nfrom t\n  where x", "2G", "select\n|from t\n  where x"],
    ["|where a = 'x' and b = 1", "f'", "where a = |'x' and b = 1"],
    ["|where a = 'x' and b = 1", "t'", "where a =| 'x' and b = 1"],
    ["|where a = 'x' and b = 1", "f';", "where a = 'x|' and b = 1"],
    ["|where a = 'x' and b = 1", "2f'", "where a = 'x|' and b = 1"],
    ["where a = 'x' and b = |1", "F'", "where a = 'x|' and b = 1"],
    ["|count(sum(x))", "%", "count(sum(x)|)"],
    ["count(sum(x)|)", "%", "count|(sum(x))"],
    ["|select\nfrom t", "fz", "|select\nfrom t"],
  ])("%j %s", (start, keys, expected) => {
    expect(after(start, keys)).toBe(expected);
  });
});

describe("vi editing", () => {
  test.each([
    ["select |id, status", "dw", "select |, status"],
    ["select |id, status", "d2w", "select |status"],
    ["select |id, status", "2dw", "select |status"],
    ["select id, |status", "dw", "select id,| "],
    ["select |id\nfrom t", "dw", "select| \nfrom t"],
    ["select |id, status", "cwcount<escape>", "select coun|t, status"],
    ["select |id, status", "cecount<escape>", "select coun|t, status"],
    ["select |id, status", "de", "select |, status"],
    ["select id, |status", "db", "select id|status"],
    ["select |id, status", "D", "select| "],
    ["select |id, status", "C*<escape>", "select |*"],
    ["select |id, status", "d$", "select| "],
    ["select |id, status", "dt,", "select |, status"],
    ["select |id, status", "df,", "select | status"],
    ["sel|ect", "x", "sel|ct"],
    ["sel|ect", "3x", "se|l"],
    ["sel|ect", "X", "se|ect"],
    ["sel|ect", "rX", "sel|Xct"],
    ["sel|ect", "2rX", "selX|Xt"],
    ["sel|ect", "sL<escape>", "sel|Lct"],
    ["sel|ect", "~~", "selEC|t"],
    ["select 1;\nselect |2;\nselect 3;", "dd", "select 1;\n|select 3;"],
    ["select 1;\nselect 2;\nselect |3;", "dd", "select 1;\n|select 2;"],
    ["select |1;\nselect 2;\nselect 3;", "2dd", "|select 3;"],
    ["select |1;\nselect 2;\nselect 3;", "dj", "|select 3;"],
    ["select 1;\nselect |2;", "dk", "|"],
    ["select 1;\n  select |2;", "cc*<escape>", "select 1;\n|*"],
    ["select |1;\nselect 2;", "yyp", "select 1;\n|select 1;\nselect 2;"],
    ["select |1;\nselect 2;", "yyP", "|select 1;\nselect 1;\nselect 2;"],
    ["select 1;\nselect |2;", "yyp", "select 1;\nselect 2;\n|select 2;"],
    ["select |id, status", "yep", "select ii|dd, status"],
    ["select |id, status", "dwP", "select i|d, status"],
    ["|select id\nfrom t\nwhere x", "J", "select id| from t\nwhere x"],
    ["|select id\n    from t\nwhere x", "3J", "select id from t| where x"],
    ["sel|ect", "iX<escape>", "sel|Xect"],
    ["sel|ect", "aX<escape>", "sele|Xct"],
    ["  sel|ect", "IX<escape>", "  |Xselect"],
    ["sel|ect", "AX<escape>", "select|X"],
    ["sel|ect\nfrom t", "oX<escape>", "select\n|X\nfrom t"],
    ["select\nfr|om t", "OX<escape>", "select\n|X\nfrom t"],
    ["sel|ect", "RXY<escape>", "selX|Yt"],
    ["sel|ect", "RXYZW<escape>", "selXYZ|W"],
  ])("%j %s", (start, keys, expected) => {
    expect(after(start, keys)).toBe(expected);
  });

  test.each([
    ["select |id, status", "diw", "select |, status"],
    ["select |id, status", "daw", "select|, status"],
    ["select id, |status from t", "daw", "select id, |from t"],
    ["where a = 'x|yz' and b", "ci'q<escape>", "where a = '|q' and b"],
    ["where a = 'x|yz' and b", "da'", "where a = | and b"],
    ["where a = \"x|yz\" and b", 'ci"q<escape>', 'where a = "|q" and b'],
    ["count(sum(|x), y)", "ci(z<escape>", "count(sum(|z), y)"],
    ["count(sum(x), |y)", "di(", "count(|)"],
    ["count(sum(x), |y)", "da(", "coun|t"],
    ["count(sum(x), |y)", "cib*<escape>", "count(|*)"],
    ["count(|)", "ci(*<escape>", "count(|*)"],
    ["{ a: [1, |2] }", "di[", "{ a: [|] }"],
  ])("%j %s", (start, keys, expected) => {
    expect(after(start, keys)).toBe(expected);
  });

  test("u undoes a change and ctrl-r redoes it; an insert session undoes as one", () => {
    const { editor, vi, press } = setup("select |1");
    press("dw");
    expect(editor.value).toBe("select ");
    press("u");
    expect(editor.value).toBe("select 1");
    press("<^r>");
    expect(editor.value).toBe("select ");
    press("uA, 2, 3<escape>");
    expect(editor.value).toBe("select 1, 2, 3");
    press("u");
    expect(editor.value).toBe("select 1");
    expect(vi.mode).toBe("normal");
  });

  test("a paste in replace mode types over the line", () => {
    const { editor, vi, press } = setup("sel|ect");
    press("R");
    vi.pasteText("XY");
    expect(editor.value).toBe("selXYt");
    press("<escape>u");
    expect(editor.value).toBe("select");
  });

  test("an operator waits for its motion, and Esc drops it", () => {
    const { editor, vi, press } = setup("select |id");
    press("2d");
    expect(vi.pendingKey).toBe("2d");
    press("<escape>");
    expect(vi.pendingKey).toBeNull();
    press("w");
    expect(editor.value).toBe("select id");
  });

  test("claims ctrl-r for redo only outside insert mode", () => {
    const { vi, press } = setup("select |1");
    expect(vi.claims(key("^r"))).toBe(true);
    press("i");
    expect(vi.claims(key("^r"))).toBe(false);
  });
});

describe("vi search", () => {
  test("search moves the cursor, n and N go on and back", () => {
    const { editor, vi, press } = setup("select |id from a join b on id = id");
    expect(vi.search("id")).toBe(true);
    expect(editor.cursorAt).toBe(27);
    press("n");
    expect(editor.cursorAt).toBe(32);
    press("n");
    expect(editor.cursorAt).toBe(7);
    press("N");
    expect(editor.cursorAt).toBe(32);
  });
});

describe("vi visual mode", () => {
  test("v selects characters and d deletes them", () => {
    const { editor, vi, press } = setup("select |id, status");
    press("ve");
    expect(vi.label).toBe("VIS");
    expect(editor.selectedText).toBe("id");
    expect(vi.selection).toEqual({ anchor: 7, head: 8 });
    press("d");
    expect(editor.value).toBe("select , status");
    expect(vi.label).toBe("NOR");
    expect(editor.selected).toBeNull();
  });

  test("V selects whole lines; y yanks them for p", () => {
    const { editor, vi, press } = setup("select |1;\nselect 2;\nselect 3;");
    press("Vj");
    expect(vi.label).toBe("VLN");
    expect(editor.selectedText).toBe("select 1;\nselect 2;\n");
    press("yGp");
    expect(editor.value).toBe("select 1;\nselect 2;\nselect 3;\nselect 1;\nselect 2;");
  });

  test("o swaps the ends, iw selects a word, c changes the selection", () => {
    const { editor, press } = setup("select id, |status from t");
    press("viw");
    expect(editor.selectedText).toBe("status");
    press("o");
    expect(editor.cursorAt).toBe(11);
    press("c");
    editor.type("count");
    press("<escape>");
    expect(editor.value).toBe("select id, count from t");
  });
});
