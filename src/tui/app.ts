import {
  bg,
  bold,
  BoxRenderable,
  fg,
  RGBA,
  StyledText,
  SyntaxStyle,
  TextareaRenderable,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type PasteEvent,
  type TextChunk,
} from "@opentui/core";
import { listTables } from "../agent/catalog.ts";
import { type Resolution, type ResolvedConnection } from "../connections/resolve.ts";
import { displayValue } from "../format.ts";
import { emptyCatalog, loadCatalog, type Catalog } from "../sql/catalog.ts";
import { complete, matchesPrefix, type Completion, type CompletionKind, type CompletionResult } from "../sql/complete.ts";
import { quoteIdent } from "../sql/ident.ts";
import { statementAt, statementText } from "../sql/statements.ts";
import { scan, type TokenKind } from "../sql/tokens.ts";
import { Database, type Run } from "./database.ts";
import { Helix, type Mode } from "./helix.ts";
import { clamp, layoutGrid, moveCursor, type GridCursor, type Line, type Rows } from "./grid.ts";
import { environmentColor, levelColor, theme } from "./theme.ts";

const selectionBg = RGBA.fromHex(theme.selection);
const selectionFg = RGBA.fromHex(theme.text);

export type AppOptions = {
  resolve: () => Promise<Resolution>;
  open?: (connection: ResolvedConnection) => Promise<Database>;
  onQuit: () => void;
};

type Screen = "connections" | "workspace";

type Pane = "tables" | "editor" | "results";

const panes: Pane[] = ["tables", "editor", "results"];

type Detail = { title: string; lines: string[]; top: number };

type Message = { text: string; kind: "info" | "error" };

type Popup = { result: CompletionResult; index: number };

const popupRows = 8;

const kindLabel: Record<CompletionKind, string> = {
  column: "col",
  table: "tbl",
  view: "view",
  schema: "sch",
  alias: "as",
  function: "fn",
  keyword: "kw",
};

export class App {
  private readonly banner: TextRenderable;
  private readonly connectionsScreen: BoxRenderable;
  private readonly listBox: BoxRenderable;
  private readonly listText: TextRenderable;
  private readonly inspectBox: BoxRenderable;
  private readonly inspectText: TextRenderable;
  private readonly workspace: BoxRenderable;
  private readonly tablesBox: BoxRenderable;
  private readonly tablesText: TextRenderable;
  private readonly editorBox: BoxRenderable;
  private readonly editor: TextareaRenderable;
  private readonly resultsBox: BoxRenderable;
  private readonly resultsText: TextRenderable;
  private readonly status: TextRenderable;
  private readonly popupBox: BoxRenderable;
  private readonly popupText: TextRenderable;
  private readonly styleIds: Partial<Record<TokenKind, number>> = {};

  private resolution: Resolution | null = null;
  private connectionIndex = 0;
  private connected: { connection: ResolvedConnection; db: Database } | null = null;
  private tables: Rows | null = null;
  private tableIndex = 0;
  private run: Run | null = null;
  private grid: GridCursor = { row: 0, col: 0, top: 0, left: 0 };
  private detail: Detail | null = null;
  private screen: Screen = "connections";
  private focus: Pane = "editor";
  private message: Message | null = null;
  private connectAttempt = 0;
  private catalog: Catalog = emptyCatalog;
  private popup: Popup | null = null;
  private acceptedText: string | null = null;
  private userRunning = false;
  private readonly helix: Helix;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly options: AppOptions,
  ) {
    const syntax = SyntaxStyle.fromStyles(
      {
        default: {},
        keyword: { fg: theme.keyword, bold: true },
        string: { fg: theme.string },
        number: { fg: theme.number },
        comment: { fg: theme.comment, italic: true },
        operator: { fg: theme.operator },
        parameter: { fg: theme.parameter },
      },
      renderer.nativeScene,
    );
    for (const kind of ["keyword", "string", "number", "comment", "operator", "parameter"] as const) {
      const id = syntax.getStyleId(kind);
      if (id !== null) this.styleIds[kind] = id;
    }

    const frame = new BoxRenderable(renderer, {
      flexDirection: "column",
      width: "100%",
      height: "100%",
      backgroundColor: theme.background,
      onSizeChange: () => this.renderBanner(),
    });
    this.banner = new TextRenderable(renderer, { content: "", height: 1, wrapMode: "none", flexShrink: 0 });

    this.connectionsScreen = new BoxRenderable(renderer, { flexDirection: "row", flexGrow: 1 });
    this.listBox = pane(renderer, "Connections", { width: "45%" });
    this.listText = new TextRenderable(renderer, { content: "", wrapMode: "none", flexGrow: 1 });
    this.listBox.add(this.listText);
    this.inspectBox = pane(renderer, "Details", { flexGrow: 1 });
    this.inspectText = new TextRenderable(renderer, { content: "", wrapMode: "word", flexGrow: 1 });
    this.inspectBox.add(this.inspectText);
    this.connectionsScreen.add(this.listBox);
    this.connectionsScreen.add(this.inspectBox);

    this.workspace = new BoxRenderable(renderer, { flexDirection: "row", flexGrow: 1, visible: false });
    this.tablesBox = pane(renderer, "Tables", { width: 32, flexShrink: 0, onSizeChange: () => this.renderTables() });
    this.tablesText = new TextRenderable(renderer, { content: "", wrapMode: "none", flexGrow: 1 });
    this.tablesBox.add(this.tablesText);
    const right = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1 });
    this.editorBox = pane(renderer, "SQL", { flexGrow: 1 });
    this.editor = new TextareaRenderable(renderer, {
      flexGrow: 1,
      wrapMode: "none",
      textColor: theme.text,
      focusedTextColor: theme.text,
      backgroundColor: theme.background,
      focusedBackgroundColor: theme.background,
      cursorColor: theme.accent,
      selectionBg: theme.selection,
      syntaxStyle: syntax,
      placeholder: "select …   (Ctrl-Enter runs the statement under the cursor)",
      placeholderColor: theme.muted,
      onContentChange: () => {
        this.highlight();
        this.completeAfterEdit();
      },
      onCursorChange: () => this.cursorMoved(),
      cursorStyle: { style: "block", blinking: false },
    });
    this.editorBox.add(this.editor);
    this.helix = new Helix({
      text: () => this.editor.plainText,
      cursor: () => this.cursorIndex(this.editor.plainText),
      setCursor: (index) => {
        const at = this.position(this.editor.plainText, index);
        this.editor.editBuffer.setCursor(at.row, at.col);
      },
      showSelection: (start, end) => {
        const text = this.editor.plainText;
        this.editor.editorView.setSelection(this.offsetOf(text, start), this.offsetOf(text, end), selectionBg, selectionFg);
      },
      clearSelection: () => this.editor.editorView.resetSelection(),
      replace: (start, end, insert) => this.replaceRange(start, end, insert),
      restore: (text) => {
        this.editor.editBuffer.replaceText(text);
        this.highlight();
      },
      measure: (text) => this.editor.editBuffer.measureText(text),
      modeChanged: (mode) => this.modeChanged(mode),
    });
    this.resultsBox = pane(renderer, "Results", { height: "55%", onSizeChange: () => this.renderResults() });
    this.resultsText = new TextRenderable(renderer, { content: "", wrapMode: "none", flexGrow: 1 });
    this.resultsBox.add(this.resultsText);
    right.add(this.editorBox);
    right.add(this.resultsBox);
    this.workspace.add(this.tablesBox);
    this.workspace.add(right);

    this.status = new TextRenderable(renderer, { content: "", height: 1, wrapMode: "none", flexShrink: 0 });

    this.popupBox = new BoxRenderable(renderer, {
      position: "absolute",
      zIndex: 10,
      visible: false,
      border: true,
      borderStyle: "rounded",
      borderColor: theme.border,
      backgroundColor: theme.surface,
      paddingLeft: 1,
      paddingRight: 1,
    });
    this.popupText = new TextRenderable(renderer, { content: "", wrapMode: "none" });
    this.popupBox.add(this.popupText);

    frame.add(this.banner);
    frame.add(this.connectionsScreen);
    frame.add(this.workspace);
    frame.add(this.status);
    frame.add(this.popupBox);
    renderer.root.add(frame);
  }

  async start(): Promise<void> {
    this.renderer.keyInput.on("keypress", this.onKey);
    this.renderer.keyInput.on("paste", this.onPaste);
    await this.reload();
  }

  async stop(): Promise<void> {
    this.renderer.keyInput.off("keypress", this.onKey);
    this.renderer.keyInput.off("paste", this.onPaste);
    await this.connected?.db.close();
    this.connected = null;
  }

  get text(): string {
    return this.editor.plainText;
  }

  setText(text: string): void {
    this.editor.editBuffer.setText(text);
    this.moveCursorToEnd();
    this.highlight();
    this.helix.reset();
  }

  private moveCursorToEnd(): void {
    const lines = this.editor.plainText.split("\n");
    const last = lines[lines.length - 1] ?? "";
    this.editor.editBuffer.setCursor(lines.length - 1, this.editor.editBuffer.measureText(last));
  }

  private async reload(): Promise<void> {
    this.resolution = await this.options.resolve();
    this.connectionIndex = Math.min(this.connectionIndex, Math.max(0, this.resolution.connections.length - 1));
    this.renderAll();
  }

  private readonly onPaste = (event: PasteEvent): void => {
    if (this.screen !== "workspace" || this.focus !== "editor" || this.helix.mode !== "normal") return;
    event.preventDefault();
    this.helix.pasteText(new TextDecoder().decode(event.bytes).replaceAll("\r\n", "\n").replaceAll("\r", "\n"));
    this.highlight();
  };

  private readonly onKey = (key: KeyEvent): void => {
    if (key.ctrl && key.name === "q") {
      key.preventDefault();
      this.options.onQuit();
      return;
    }
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      if (this.connected?.db.cancel()) this.say("cancelling…", "info");
      return;
    }
    if (this.screen === "connections") {
      this.connectionsKey(key);
      return;
    }
    if (key.ctrl && key.name === "o") {
      key.preventDefault();
      this.showScreen("connections");
      return;
    }
    if (this.focus === "editor" && this.completionKey(key)) {
      key.preventDefault();
      return;
    }
    if (key.name === "tab") {
      key.preventDefault();
      this.cycleFocus(key.shift ? -1 : 1);
      return;
    }
    if ((key.name === "return" && (key.ctrl || key.meta || key.option)) || key.name === "f5") {
      key.preventDefault();
      void this.runStatementUnderCursor();
      return;
    }
    if (this.focus === "editor") {
      if (this.helix.handle(key)) {
        key.preventDefault();
        this.renderStatus();
      }
      return;
    }
    if (this.focus === "tables") this.tablesKey(key);
    else if (this.focus === "results") this.resultsKey(key);
  };

  private completionKey(key: KeyEvent): boolean {
    if (key.ctrl && key.name === "space") {
      if (this.helix.mode === "insert") this.openCompletion(true);
      return true;
    }
    if (!this.popup) return false;
    switch (key.name) {
      case "up":
        this.popup.index = Math.max(0, this.popup.index - 1);
        this.renderPopup();
        return true;
      case "down":
        this.popup.index = Math.min(this.popup.result.items.length - 1, this.popup.index + 1);
        this.renderPopup();
        return true;
      case "tab":
        if (key.shift) this.acceptCompletion();
        else this.completeCommonPrefix();
        return true;
      case "escape":
        this.closeCompletion();
        return false;
      case "left":
      case "right":
      case "home":
      case "end":
      case "return":
        this.closeCompletion();
        return false;
      default:
        return false;
    }
  }

  private completeAfterEdit(): void {
    if (this.focus !== "editor" || !this.connected || this.helix.mode !== "insert") return;
    const text = this.editor.plainText;
    if (text === this.acceptedText) return;
    this.acceptedText = null;
    const cursor = this.cursorIndex(text);
    const typed = text[cursor - 1] ?? "";
    if (this.popup || /[A-Za-z0-9_$.]/.test(typed)) this.openCompletion(false);
  }

  private openCompletion(explicit: boolean): void {
    const text = this.editor.plainText;
    const result = complete(text, this.cursorIndex(text), this.catalog);
    const worthShowing = result !== null && result.items.length > 0 && (explicit || result.word.length > 0 || text[result.from - 1] === ".");
    const exactOnly = result?.items.length === 1 && result.items[0]!.insert === result.word;
    if (!worthShowing || exactOnly) {
      this.closeCompletion();
      return;
    }
    this.popup = { result, index: 0 };
    this.renderPopup();
  }

  private completeCommonPrefix(): void {
    const fresh = this.freshCompletion();
    if (!fresh) return;
    const candidates = fresh.result.items.filter((i) => matchesPrefix(i, fresh.result.word));
    if (candidates.length === 1) {
      this.replaceWord(fresh.result, candidates[0]!.insert, true);
      return;
    }
    const word = fresh.result.word.toLowerCase();
    if (!candidates.every((i) => i.insert.toLowerCase().startsWith(word))) return;
    const prefix = commonPrefix(candidates.map((i) => i.insert));
    if (prefix.length > word.length) this.replaceWord(fresh.result, prefix, false);
  }

  private acceptCompletion(): void {
    const fresh = this.freshCompletion();
    if (fresh?.selected) this.replaceWord(fresh.result, fresh.selected.insert, true);
  }

  private freshCompletion(): { result: CompletionResult; selected: Completion | null } | null {
    const popup = this.popup;
    if (!popup) return null;
    const text = this.editor.plainText;
    const result = complete(text, this.cursorIndex(text), this.catalog);
    if (!result || result.from !== popup.result.from) {
      this.closeCompletion();
      return null;
    }
    const was = popup.result.items[popup.index];
    const selected = result.items.find((i) => was && i.kind === was.kind && i.label === was.label) ?? result.items[0] ?? null;
    return { result, selected };
  }

  private cursorMoved(): void {
    if (this.helix.mode === "normal") this.helix.follow(this.cursorIndex(this.editor.plainText));
    if (!this.popup) return;
    const text = this.editor.plainText;
    const result = complete(text, this.cursorIndex(text), this.catalog);
    if (!result || result.from !== this.popup.result.from) this.closeCompletion();
  }

  private replaceWord(result: CompletionResult, insert: string, accept: boolean): void {
    if (accept) this.closeCompletion();
    this.replaceRange(result.from, result.to, insert);
    this.acceptedText = accept ? this.editor.plainText : null;
    this.highlight();
    if (accept && insert.endsWith(".")) this.openCompletion(true);
  }

  private replaceRange(start: number, end: number, insert: string): void {
    const text = this.editor.plainText;
    const from = this.position(text, start);
    const to = this.position(text, end);
    if (end > start) this.editor.editBuffer.deleteRange(from.row, from.col, to.row, to.col);
    this.editor.editBuffer.setCursor(from.row, from.col);
    if (insert !== "") this.editor.editBuffer.insertText(insert);
  }

  private offsetOf(text: string, index: number): number {
    const at = this.position(text, index);
    return this.editor.editBuffer.positionToOffset(at.row, at.col);
  }

  private modeChanged(mode: Mode): void {
    this.editor.cursorStyle = mode === "insert" ? { style: "line", blinking: true } : { style: "block", blinking: false };
    if (mode === "normal") this.closeCompletion();
    this.renderStatus();
  }

  private closeCompletion(): void {
    this.popup = null;
    this.popupBox.visible = false;
  }

  private position(text: string, index: number): { row: number; col: number } {
    const before = text.slice(0, index);
    const row = before.split("\n").length - 1;
    const lineStart = before.lastIndexOf("\n") + 1;
    return { row, col: this.editor.editBuffer.measureText(text.slice(lineStart, index)) };
  }

  private renderPopup(): void {
    const popup = this.popup;
    if (!popup) return;
    const items = popup.result.items;
    const top = Math.max(0, Math.min(popup.index - Math.floor(popupRows / 2), items.length - popupRows));
    const shown = items.slice(top, top + popupRows);
    const labelWidth = Math.min(32, Math.max(...shown.map((i) => i.label.length)));
    const detailWidth = Math.min(36, Math.max(0, ...shown.map((i) => i.detail.length)));
    const lines = shown.map((item, i) => {
      const selected = top + i === popup.index;
      const label = item.label.length > labelWidth ? `${item.label.slice(0, labelWidth - 1)}…` : item.label.padEnd(labelWidth);
      const detail = item.detail.length > detailWidth ? `${item.detail.slice(0, detailWidth - 1)}…` : item.detail.padEnd(detailWidth);
      const row = [fg(theme.muted)(kindLabel[item.kind].padEnd(5)), fg(theme.text)(label), fg(theme.muted)(`  ${detail}`)];
      return selected ? row.map((chunk) => bg(theme.selection)(chunk)) : row;
    });
    this.popupText.content = styled(joinLines(lines));

    const width = 5 + labelWidth + 2 + detailWidth + 4;
    const height = shown.length + 2;
    const text = this.editor.plainText;
    const anchor = this.position(text, popup.result.from);
    const cursorRow = this.editor.visualCursor.visualRow - this.editor.scrollY;
    const x = Math.max(0, Math.min(this.renderer.width - width, this.editor.screenX + anchor.col - 7));
    const below = this.editor.screenY + cursorRow + 1;
    const y = below + height <= this.renderer.height - 1 ? below : Math.max(0, this.editor.screenY + cursorRow - height);
    this.popupBox.left = x;
    this.popupBox.top = y;
    this.popupBox.width = width;
    this.popupBox.height = height;
    this.popupBox.visible = true;
  }

  private connectionsKey(key: KeyEvent): void {
    key.preventDefault();
    const count = this.resolution?.connections.length ?? 0;
    const step = listStep(key);
    if (step !== 0) {
      this.connectionIndex = clamp(this.connectionIndex + step, 0, Math.max(0, count - 1));
      this.renderConnections();
    } else if (key.name === "return") {
      const connection = this.resolution?.connections[this.connectionIndex];
      if (connection) void this.connect(connection);
    } else if (key.name === "r") {
      this.reload().catch((e: unknown) => this.say(`could not reload: ${e instanceof Error ? e.message : String(e)}`, "error"));
    } else if (key.name === "escape" && this.connected) {
      this.showScreen("workspace");
    }
  }

  private tablesKey(key: KeyEvent): void {
    const count = this.tables?.rows.length ?? 0;
    const step = listStep(key);
    if (step !== 0) {
      key.preventDefault();
      this.tableIndex = clamp(this.tableIndex + step, 0, Math.max(0, count - 1));
      this.renderTables();
    } else if (key.name === "return") {
      key.preventDefault();
      const row = this.tables?.rows[this.tableIndex];
      if (!row) return;
      if (this.userRunning) {
        this.say("a statement is still running (Ctrl-C cancels it)", "error");
        return;
      }
      const select = `select * from ${quoteIdent(String(row[0]))}.${quoteIdent(String(row[1]))} limit 100;`;
      const existing = this.editor.plainText.trimEnd();
      this.helix.beforeExternalChange();
      this.editor.editBuffer.setCursor(0, 0);
      this.moveCursorToEnd();
      this.editor.editBuffer.insertText(`${existing === "" ? "" : "\n\n"}${select}`);
      this.highlight();
      this.helix.reset();
      void this.runStatementUnderCursor();
    }
  }

  private resultsKey(key: KeyEvent): void {
    if (this.detail) {
      key.preventDefault();
      if (key.name === "escape" || key.name === "q") this.detail = null;
      else this.detail.top = clamp(this.detail.top + listStep(key), 0, Math.max(0, this.detail.lines.length - 1));
      this.renderResults();
      return;
    }

    const rows = this.run?.result.kind === "rows" ? this.run.result : null;
    if (!rows) return;
    const height = this.resultsHeight;
    const page = Math.max(1, height - 3);
    const moves: Record<string, [number, number]> = {
      up: [-1, 0],
      k: [-1, 0],
      down: [1, 0],
      j: [1, 0],
      left: [0, -1],
      h: [0, -1],
      right: [0, 1],
      l: [0, 1],
      pageup: [-page, 0],
      pagedown: [page, 0],
      home: [-rows.rows.length, 0],
      end: [rows.rows.length, 0],
    };
    const name = key.name === "g" ? (key.shift ? "end" : "home") : key.name;
    const move = moves[name];
    if (move) {
      key.preventDefault();
      this.grid = moveCursor(this.grid, rows, move[0], move[1], height);
      this.renderResults();
    } else if (key.name === "return") {
      key.preventDefault();
      this.openDetail(rows);
    }
  }

  private showScreen(screen: Screen): void {
    this.screen = screen;
    this.connectionsScreen.visible = screen === "connections";
    this.workspace.visible = screen === "workspace";
    this.closeCompletion();
    if (screen === "workspace") this.setFocus(this.focus);
    else this.editor.blur();
    this.renderAll();
  }

  private cycleFocus(step: number): void {
    const index = (panes.indexOf(this.focus) + step + panes.length) % panes.length;
    this.setFocus(panes[index]!);
  }

  private setFocus(next: Pane): void {
    this.focus = next;
    if (next === "editor") this.editor.focus();
    else this.editor.blur();
    this.closeCompletion();
    this.renderAll();
  }

  private async connect(connection: ResolvedConnection): Promise<void> {
    if (connection.target.kind === "unavailable") {
      this.say(`${connection.name} is unavailable: ${connection.target.reason}`, "error");
      return;
    }
    const params = connection.target.params;
    const attempt = ++this.connectAttempt;
    this.say(`connecting to ${connection.name}…`, "info");

    let db: Database;
    try {
      db = await (this.options.open ? this.options.open(connection) : Database.open(params));
    } catch (e) {
      if (attempt === this.connectAttempt) {
        this.say(`could not connect to ${connection.name}: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
      return;
    }
    if (attempt !== this.connectAttempt) {
      await db.close().catch(() => {});
      return;
    }

    const previous = this.connected;
    this.connected = { connection, db };
    this.run = null;
    this.detail = null;
    this.tables = null;
    await previous?.db.close().catch(() => {});
    this.catalog = emptyCatalog;
    this.closeCompletion();
    const tables = await listTables(async (q) => (await db.run(q)).result);
    if (this.connected?.db !== db) return;
    this.tables = tables.kind === "rows" ? tables : null;
    this.tableIndex = 0;
    this.message = null;
    this.focus = "editor";
    this.showScreen("workspace");
    await this.refreshCatalog(db);
  }

  private async refreshTables(db: Database): Promise<void> {
    const tables = await listTables(async (q) => (await db.run(q)).result);
    if (this.connected?.db !== db || tables.kind !== "rows") return;
    this.tables = tables;
    this.tableIndex = Math.min(this.tableIndex, Math.max(0, tables.rows.length - 1));
    this.renderTables();
  }

  private async refreshCatalog(db: Database): Promise<void> {
    const loading: Message = { text: "reading the catalog for completion…", kind: "info" };
    if (this.catalog === emptyCatalog) {
      this.message = loading;
      this.renderStatus();
    }
    try {
      const catalog = await loadCatalog(async (q) => (await db.run(q, 1_000_000)).result);
      if (this.connected?.db !== db) return;
      this.catalog = catalog;
      if (this.message === loading) {
        this.message = null;
        this.renderStatus();
      }
    } catch (e) {
      if (this.connected?.db === db) this.say(`completion is unavailable: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  private async runStatementUnderCursor(): Promise<void> {
    if (!this.connected) return;
    if (this.userRunning) {
      this.say("a statement is still running (Ctrl-C cancels it)", "error");
      return;
    }
    const text = this.editor.plainText;
    const span = statementAt(text, this.cursorIndex(text));
    if (!span) {
      this.say("nothing to run", "error");
      return;
    }

    this.say("running…", "info");
    const db = this.connected.db;
    this.userRunning = true;
    let run: Run;
    try {
      run = await db.run(statementText(text, span));
    } finally {
      this.userRunning = false;
    }
    if (this.connected?.db !== db) return;
    this.run = run;
    if (run.result.kind === "rows" && /^(CREATE|ALTER|DROP|SET|RESET|COMMENT|GRANT|REVOKE|RENAME)/.test(run.result.command ?? "")) {
      void this.refreshTables(db).then(() => this.refreshCatalog(db));
    }
    this.grid = { row: 0, col: 0, top: 0, left: 0 };
    this.detail = null;
    this.message = null;
    this.renderAll();
  }

  private cursorIndex(text: string): number {
    const { row, col } = this.editor.logicalCursor;
    const lines = text.split("\n");
    const lineStart = lines.slice(0, row).reduce((sum, line) => sum + line.length + 1, 0);
    const line = lines[row] ?? "";
    let index = 0;
    while (index < line.length && this.editor.editBuffer.measureText(line.slice(0, index)) < col) {
      index += line.codePointAt(index)! > 0xffff ? 2 : 1;
    }
    return lineStart + index;
  }

  private openDetail(rows: Rows): void {
    const value = rows.rows[this.grid.row]?.[this.grid.col];
    const column = rows.columns[this.grid.col]?.name ?? "";
    this.detail = { title: `${column} · row ${this.grid.row + 1}`, lines: detailText(value).split("\n"), top: 0 };
    this.renderResults();
  }

  private highlight(): void {
    const buffer = this.editor.editBuffer;
    buffer.clearAllHighlights();
    const text = this.editor.plainText;
    const newlinesBefore = newlineCounts(text);
    for (const token of scan(text).tokens) {
      const styleId = this.styleIds[token.kind];
      if (styleId === undefined) continue;
      const start = token.start - newlinesBefore[token.start]!;
      const end = token.end - newlinesBefore[token.end]!;
      buffer.addHighlightByCharRange({ start, end, styleId });
    }
  }

  private say(text: string, kind: Message["kind"]): void {
    this.message = { text, kind };
    this.renderStatus();
  }

  private get resultsHeight(): number {
    return Math.max(3, this.resultsBox.height - 2);
  }

  private get accent(): string {
    return this.connected ? environmentColor[this.connected.connection.environment] : theme.accent;
  }

  private renderAll(): void {
    this.renderBanner();
    this.renderConnections();
    this.renderTables();
    this.renderEditorTitle();
    this.renderResults();
    this.renderStatus();
  }

  private renderBanner(): void {
    const c = this.connected?.connection;
    if (!c) {
      this.banner.content = styled([bold(fg(theme.text)(" kowari · not connected"))]);
      return;
    }
    const color = environmentColor[c.environment];
    const target = c.target.kind === "ready" ? `${c.target.params.user}@${c.target.params.host}:${c.target.params.port}/${c.target.params.database}` : "";
    const text = ` ${c.environment.toUpperCase()} · ${c.name} · ${target} · Claude: ${c.agent} `;
    this.banner.content = styled([bold(bg(color)(fg(theme.background)(text.padEnd(this.renderer.width))))]);
  }

  private renderConnections(): void {
    setBorder(this.listBox, this.screen === "connections" ? theme.accent : theme.border);
    const connections = this.resolution?.connections ?? [];
    if (connections.length === 0) {
      this.listText.content = styled([fg(theme.muted)("No connections.\n\nAdd .kowari.toml to the repo,\nor ~/.config/kowari/connections.toml")]);
      this.inspectText.content = this.problemsText();
      return;
    }
    const nameWidth = Math.max("Name".length, ...connections.map((c) => c.name.length));
    const header: Line = [bold(fg(theme.muted)(`    ${"Name".padEnd(nameWidth + 2)}${"Environment".padEnd(14)}Claude`))];
    const grouped = new Set(connections.map((c) => c.group)).size > 1;
    const lines: Line[] = [header];
    connections.forEach((c, i) => {
      if (grouped && c.group !== connections[i - 1]?.group) {
        if (i > 0) lines.push([]);
        lines.push([bold(fg(groupColor(c.group))(`  ${c.group}`))]);
      }
      const selected = i === this.connectionIndex;
      const marker = selected ? fg(theme.accent)("▸ ") : "  ";
      const active = this.connected?.connection.name === c.name ? fg(theme.good)("● ") : "  ";
      const name = fg(c.target.kind === "unavailable" ? theme.muted : theme.text)(c.name.padEnd(nameWidth + 2));
      lines.push([marker, active, name, fg(environmentColor[c.environment])(c.environment.padEnd(14)), fg(levelColor[c.agent])(c.agent)]);
    });
    this.listText.content = styled(joinLines(lines));
    this.inspectText.content = this.inspection(connections[this.connectionIndex]!);
  }

  private inspection(c: ResolvedConnection): StyledText {
    const field = (label: string, value: string, color: string = theme.text): Line => [fg(theme.muted)(label.padEnd(13)), fg(color)(value)];
    const lines: Line[] = [[bold(fg(theme.text)(c.name))], []];
    lines.push(field("environment", c.environment, environmentColor[c.environment]));
    if (c.group !== c.environment) lines.push(field("group", c.group));
    lines.push(field("defined in", c.source === "user" ? "your config" : `.kowari.toml in ${this.resolution?.worktree.root ?? ""}`));
    if (c.target.kind === "ready") {
      const p = c.target.params;
      lines.push(field("host", `${p.host}:${p.port}`));
      lines.push(field("database", p.database));
      lines.push(field("user", p.user));
      lines.push(field("password", p.password === null ? "missing" : "set"));
      lines.push(field("sslmode", p.sslmode));
      if (p.sslrootcert) lines.push(field("sslrootcert", p.sslrootcert));
    } else {
      lines.push(field("unavailable", c.target.reason, theme.error));
    }
    lines.push([]);
    lines.push(field("Claude", c.agent, levelColor[c.agent]));
    if (c.agentNote) lines.push(field("", c.agentNote, theme.warning));
    lines.push([]);
    lines.push([fg(theme.muted)("Enter connects · r reloads config · Esc back")]);
    const problems = this.resolution?.problems ?? [];
    if (problems.length > 0) {
      lines.push([]);
      lines.push([bold(fg(theme.warning)("Config problems"))]);
      for (const p of problems) lines.push([fg(theme.warning)(`• ${p}`)]);
    }
    return styled(joinLines(lines));
  }

  private problemsText(): StyledText {
    const problems = this.resolution?.problems ?? [];
    return styled(joinLines(problems.map((p) => [fg(theme.warning)(`• ${p}`)])));
  }

  private renderTables(): void {
    setBorder(this.tablesBox, this.focus === "tables" ? this.accent : theme.border);
    if (!this.tables) {
      this.tablesText.content = styled([fg(theme.muted)("No tables")]);
      return;
    }
    const height = Math.max(1, this.tablesBox.height - 2);
    const top = Math.max(0, Math.min(this.tableIndex - Math.floor(height / 2), this.tables.rows.length - height));
    const lines = this.tables.rows.slice(top, top + height).map((row, i) => {
      const selected = top + i === this.tableIndex;
      const marker = selected ? fg(this.focus === "tables" ? this.accent : theme.text)("▸ ") : "  ";
      const schema = String(row[0]);
      const name = schema === "public" ? String(row[1]) : `${schema}.${row[1]}`;
      return [marker, fg(theme.text)(name.padEnd(18)), fg(theme.muted)(` ${displayValue(row[4])}`)];
    });
    this.tablesText.content = styled(joinLines(lines));
  }

  private renderEditorTitle(): void {
    setBorder(this.editorBox, this.focus === "editor" ? this.accent : theme.border);
  }

  private renderResults(): void {
    setBorder(this.resultsBox, this.focus === "results" ? this.accent : theme.border);
    const width = Math.max(10, this.resultsBox.width - 4);
    const height = this.resultsHeight;

    if (this.detail) {
      this.resultsBox.title = `${this.detail.title} · Esc closes`;
      this.resultsText.content = styled(joinLines(this.detail.lines.slice(this.detail.top, this.detail.top + height).map((l) => [fg(theme.text)(l)])));
      return;
    }

    const run = this.run;
    if (!run) {
      this.resultsBox.title = "Results";
      this.resultsText.content = "";
      return;
    }
    if (run.result.kind !== "rows") {
      this.resultsBox.title = `Error · ${formatMs(run.ms)}`;
      this.resultsText.content = styled([fg(theme.error)(run.result.kind === "error" ? run.result.message : run.result.reason)]);
      return;
    }

    const rows = run.result;
    this.resultsBox.title = `${resultSummary(rows)} · ${formatMs(run.ms)}`;
    if (rows.columns.length === 0) {
      this.resultsText.content = styled([fg(theme.muted)(rows.command ? `${rows.command}${rows.count !== null ? ` ${rows.count}` : ""}` : "done")]);
      return;
    }
    const laid = layoutGrid(rows, this.grid, width, height);
    this.grid = laid.cursor;
    this.resultsText.content = styled(joinLines(laid.lines));
  }

  private modeBadge(): TextChunk {
    const label = this.helix.mode === "insert" ? " INS " : this.helix.extending ? " EXT " : " NOR ";
    const pending = this.helix.pendingKey ? ` ${this.helix.pendingKey}…` : "";
    const color = this.helix.mode === "insert" ? theme.good : this.helix.extending ? theme.warning : theme.accent;
    return bold(bg(color)(fg(theme.background)(`${label}${pending}`)));
  }

  private renderStatus(): void {
    const message = this.message ? [fg(this.message.kind === "error" ? theme.error : theme.muted)(` ${this.message.text}`)] : [];
    if (this.screen === "workspace" && this.focus === "editor") message.unshift(this.modeBadge());
    const hints =
      this.screen === "connections"
        ? " ↑↓ choose · Enter connect · r reload · Ctrl-Q quit"
        : " Ctrl-Enter run · Ctrl-Space complete · Tab pane · Ctrl-O connections · Ctrl-C cancel · Ctrl-Q quit";
    this.status.content = styled([...message, fg(theme.muted)(hints)]);
  }
}

function pane(renderer: CliRenderer, title: string, size: Record<string, unknown>): BoxRenderable {
  return new BoxRenderable(renderer, {
    ...size,
    flexDirection: "column",
    border: true,
    borderStyle: "rounded",
    borderColor: theme.border,
    title,
    paddingLeft: 1,
    paddingRight: 1,
  });
}

function groupColor(group: string): string {
  return group in environmentColor ? environmentColor[group as keyof typeof environmentColor] : theme.text;
}

function setBorder(box: BoxRenderable, color: string): void {
  box.borderColor = color;
}

function styled(parts: (string | TextChunk)[]): StyledText {
  return new StyledText(parts.map((part) => (typeof part === "string" ? { __isChunk: true, text: part } : part)));
}

function joinLines(lines: (string | TextChunk)[][]): (string | TextChunk)[] {
  return lines.flatMap((line, i) => (i === 0 ? line : ["\n", ...line]));
}

function listStep(key: KeyEvent): number {
  if (key.name === "up" || key.name === "k") return -1;
  if (key.name === "down" || key.name === "j") return 1;
  if (key.name === "pageup") return -10;
  if (key.name === "pagedown") return 10;
  return 0;
}

function resultSummary(rows: Rows): string {
  if (rows.truncated) return `first ${rows.rows.length} rows (more not fetched)`;
  if (rows.columns.length === 0) return rows.command ?? "done";
  return `${rows.rows.length} ${rows.rows.length === 1 ? "row" : "rows"}`;
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function detailText(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object" && !(value instanceof Date) && !(value instanceof Uint8Array)) {
    return JSON.stringify(value, null, 2);
  }
  if (typeof value === "string" && /^\s*[[{]/.test(value)) {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return displayValue(value);
}

function commonPrefix(values: string[]): string {
  if (values.length === 0) return "";
  let prefix = values[0]!;
  for (const value of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < value.length && prefix[i]!.toLowerCase() === value[i]!.toLowerCase()) i += 1;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}

function newlineCounts(text: string): number[] {
  const counts = new Array<number>(text.length + 1);
  let seen = 0;
  for (let i = 0; i <= text.length; i++) {
    counts[i] = seen;
    if (text[i] === "\n") seen += 1;
  }
  return counts;
}


