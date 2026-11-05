import {
  bg,
  bold,
  BoxRenderable,
  fg,
  LineNumberRenderable,
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
import path from "node:path";
import { listTables } from "../agent/catalog.ts";
import { addDenies, checkDenies, claudeSettingsPath, keyringDenyRules, type DenyCheck } from "../claude/deny.ts";
import { keyringKey, systemKeyring, type Keyring } from "../connections/keyring.ts";
import { type ConnectionParams, type Resolution, type ResolvedConnection } from "../connections/resolve.ts";
import { displayValue } from "../format.ts";
import { emptyCatalog, loadCatalog, type Catalog } from "../sql/catalog.ts";
import { complete, matchesPrefix, type Completion, type CompletionKind, type CompletionResult } from "../sql/complete.ts";
import { quoteIdent } from "../sql/ident.ts";
import { statementAt, statementText } from "../sql/statements.ts";
import { scan, type TokenKind } from "../sql/tokens.ts";
import type { Attachment } from "../context.ts";
import { kowariContext } from "./context.ts";
import { Database, type Run } from "./database.ts";
import { Helix, type Mode } from "./helix.ts";
import { clamp, layoutGrid, moveCursor, paint, type GridCursor, type Line, type Rows } from "./grid.ts";
import { environmentColor, environmentWash, levelColor, theme } from "./theme.ts";

const selectionBg = RGBA.fromHex(theme.selection);
const selectionFg = RGBA.fromHex(theme.text);

export type AppOptions = {
  resolve: () => Promise<Resolution>;
  open?: (params: ConnectionParams) => Promise<Database>;
  keyring?: Keyring;
  claudeSettings?: string;
  setTitle?: (title: string) => void;
  onQuit: () => void;
};

type PasswordPrompt = { connection: ResolvedConnection; value: string; error: string | null };

type PasswordSource = "config" | "keyring" | "asks" | "keyring locked" | "no keyring";

type Screen = "connections" | "workspace";

type Pane = "tables" | "editor" | "results";

const panes: Pane[] = ["tables", "editor", "results"];

type Detail = { title: string; lines: string[]; top: number };

type Message = { text: string; kind: "info" | "error" };

type Popup = { result: CompletionResult; index: number };

type Hint = [key: string, label: string];

const connectionHints: Hint[] = [
  ["↑↓", "choose"],
  ["⏎", "connect"],
  ["r", "reload"],
  ["^q", "quit"],
];

const workspaceHints: Hint[] = [
  ["^⏎", "run"],
  ["^␣", "complete"],
  ["Tab", "pane"],
  ["^o", "connections"],
  ["^c", "cancel"],
  ["^q", "quit"],
];

const paneLabel: Record<Pane, string> = { tables: "tables", editor: "sql", results: "results" };

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
  private readonly listLabel: TextRenderable;
  private readonly listText: TextRenderable;
  private readonly inspectBox: BoxRenderable;
  private readonly inspectLabel: TextRenderable;
  private readonly inspectText: TextRenderable;
  private readonly workspace: BoxRenderable;
  private readonly tablesBox: BoxRenderable;
  private readonly tablesLabel: TextRenderable;
  private readonly tablesText: TextRenderable;
  private readonly editorLabel: TextRenderable;
  private readonly editor: TextareaRenderable;
  private readonly resultsBox: BoxRenderable;
  private readonly resultsLabel: TextRenderable;
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
  private runSql: string | null = null;
  private grid: GridCursor = { row: 0, col: 0, top: 0, left: 0 };
  private detail: Detail | null = null;
  private screen: Screen = "connections";
  private focus: Pane = "editor";
  private message: Message | null = null;
  private connectAttempt = 0;
  private afterConnect: Message | null = null;
  private catalog: Catalog = emptyCatalog;
  private popup: Popup | null = null;
  private acceptedText: string | null = null;
  private prompt: PasswordPrompt | null = null;
  private passwordSources = new Map<string, PasswordSource>();
  private denies: DenyCheck | null = null;
  private confirmingDenies = false;
  private confirmingForget = false;
  private userRunning = false;
  private title = "";
  private readonly helix: Helix;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly options: AppOptions,
  ) {
    const syntax = SyntaxStyle.fromStyles(
      {
        default: {},
        keyword: { fg: theme.keyword },
        string: { fg: theme.string },
        number: { fg: theme.number },
        comment: { fg: theme.comment, italic: true },
        operator: { fg: theme.operator },
        parameter: { fg: theme.parameter },
        semicolon: { fg: theme.punctuation },
      },
      renderer.nativeScene,
    );
    for (const kind of ["keyword", "string", "number", "comment", "operator", "parameter", "semicolon"] as const) {
      const id = syntax.getStyleId(kind);
      if (id !== null) this.styleIds[kind] = id;
    }

    const frame = new BoxRenderable(renderer, {
      flexDirection: "column",
      width: "100%",
      height: "100%",
      backgroundColor: theme.background,
      onSizeChange: () => {
        this.renderBanner();
        this.renderConnections();
        this.renderStatus();
      },
    });
    this.banner = new TextRenderable(renderer, { content: "", height: 1, wrapMode: "none", flexShrink: 0, bg: theme.surface });

    this.connectionsScreen = new BoxRenderable(renderer, { flexDirection: "row", flexGrow: 1 });
    [this.listBox, this.listLabel] = section(renderer, { width: 44, flexShrink: 0, backgroundColor: theme.surface });
    this.listText = new TextRenderable(renderer, { content: "", wrapMode: "none", flexGrow: 1 });
    this.listBox.add(this.listText);
    [this.inspectBox, this.inspectLabel] = section(renderer, { flexGrow: 1, marginLeft: 1 });
    this.inspectText = new TextRenderable(renderer, { content: "", wrapMode: "word", flexGrow: 1, marginLeft: 1, marginRight: 1 });
    this.inspectBox.add(this.inspectText);
    this.connectionsScreen.add(this.listBox);
    this.connectionsScreen.add(this.inspectBox);

    this.workspace = new BoxRenderable(renderer, { flexDirection: "row", flexGrow: 1, visible: false });
    [this.tablesBox, this.tablesLabel] = section(renderer, { width: 32, flexShrink: 0, backgroundColor: theme.surface, onSizeChange: () => this.renderTables() });
    this.tablesText = new TextRenderable(renderer, { content: "", wrapMode: "none", flexGrow: 1 });
    this.tablesBox.add(this.tablesText);
    const right = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, marginLeft: 1 });
    const [editorBox, editorLabel] = section(renderer, { flexGrow: 1 });
    this.editorLabel = editorLabel;
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
    editorBox.add(new LineNumberRenderable(renderer, { target: this.editor, fg: theme.faint, bg: theme.background, minWidth: 3, paddingRight: 1, flexGrow: 1 }));
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
    [this.resultsBox, this.resultsLabel] = section(renderer, { height: "55%", onSizeChange: () => this.renderResults() });
    this.resultsText = new TextRenderable(renderer, { content: "", wrapMode: "none", flexGrow: 1 });
    this.resultsBox.add(this.resultsText);
    const rule = new TextRenderable(renderer, { content: styled([fg(theme.line)("─".repeat(1000))]), height: 1, wrapMode: "none", flexShrink: 0, marginBottom: 1 });
    right.add(editorBox);
    right.add(rule);
    right.add(this.resultsBox);
    this.workspace.add(this.tablesBox);
    this.workspace.add(right);

    this.status = new TextRenderable(renderer, { content: "", height: 1, wrapMode: "none", flexShrink: 0, bg: theme.surface });

    this.popupBox = new BoxRenderable(renderer, {
      position: "absolute",
      zIndex: 10,
      visible: false,
      backgroundColor: theme.raised,
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

  context(): Attachment | string {
    if (this.screen !== "workspace" || !this.connected) return "kowari is not connected to a database";
    const connection = this.connected.connection.name;
    if (this.focus === "tables") {
      const row = this.tables?.rows[this.tableIndex];
      return row ? kowariContext({ kind: "table", connection, table: `${row[0]}.${row[1]}` }) : "No table selected in kowari";
    }
    if (this.focus === "results") {
      const result = this.run?.result;
      if (!this.runSql || result?.kind !== "rows") return "No results to point at in kowari";
      const column = result.columns[this.grid.col];
      if (!column || result.rows.length === 0) return kowariContext({ kind: "sql", connection, sql: this.runSql });
      const table = column.table === undefined ? undefined : this.catalog.tables.find((candidate) => candidate.oid === column.table);
      return kowariContext({ kind: "results", connection, sql: this.runSql, row: this.grid.row + 1, column: column.name, table: table ? `${table.schema}.${table.name}` : null });
    }
    const text = this.editor.plainText;
    const { anchor, head } = this.helix.selection;
    const span = statementAt(text, this.cursorIndex(text));
    const sql = anchor !== head ? text.slice(Math.min(anchor, head), Math.max(anchor, head) + 1) : span ? statementText(text, span) : "";
    return sql.trim() ? kowariContext({ kind: "sql", connection, sql }) : "No SQL to attach in kowari";
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

  private get keyring(): Keyring {
    return this.options.keyring ?? systemKeyring;
  }

  private async reload(): Promise<void> {
    this.resolution = await this.options.resolve();
    this.connectionIndex = Math.min(this.connectionIndex, Math.max(0, this.resolution.connections.length - 1));
    this.renderAll();
    await this.refreshPasswordSources().catch(() => {});
    this.denies = await this.checkDenies();
    this.renderConnections();
  }

  private async checkDenies(): Promise<DenyCheck> {
    const settingsPath = this.options.claudeSettings ?? claudeSettingsPath();
    try {
      return await checkDenies(settingsPath);
    } catch (e) {
      return { settingsPath, missing: [], problem: `could not read ${settingsPath} (${e instanceof Error ? e.message : String(e)})` };
    }
  }

  private async refreshPasswordSources(): Promise<void> {
    const state = await this.keyring.state();
    const sources = new Map<string, PasswordSource>();
    for (const c of this.resolution?.connections ?? []) {
      if (c.target.kind !== "ready") continue;
      if (c.target.params.password !== null) sources.set(c.name, "config");
      else if (state === "locked") sources.set(c.name, "keyring locked");
      else if (state === "unavailable") sources.set(c.name, "no keyring");
      else sources.set(c.name, (await this.keyring.get(keyringKey(c.target.params))) === null ? "asks" : "keyring");
    }
    this.passwordSources = sources;
  }

  private readonly onPaste = (event: PasteEvent): void => {
    if (this.prompt) {
      event.preventDefault();
      this.prompt.value += new TextDecoder().decode(event.bytes).replace(/[\r\n]+$/, "");
      this.renderConnections();
      return;
    }
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
    const width = 2 + 5 + labelWidth + 2 + detailWidth + 1;
    const lines = shown.map((item, i) => {
      const selected = top + i === popup.index;
      const label = item.label.length > labelWidth ? `${item.label.slice(0, labelWidth - 1)}…` : item.label.padEnd(labelWidth);
      const detail = item.detail.length > detailWidth ? `${item.detail.slice(0, detailWidth - 1)}…` : item.detail.padEnd(detailWidth);
      const row: Line = [fg(theme.accent)("▎ "), fg(theme.muted)(kindLabel[item.kind].padEnd(5)), fg(theme.text)(label), fg(theme.muted)(`  ${detail}`)];
      return paint(row, width, selected ? theme.selection : theme.raised);
    });
    this.popupText.content = styled(joinLines(lines));

    const height = shown.length;
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
    if (this.prompt) return this.promptKey(key);
    if (this.confirmingForget) {
      this.confirmingForget = false;
      if (key.name === "y") void this.forgetPassword();
      else this.renderConnections();
      return;
    }
    if (this.confirmingDenies) {
      this.confirmingDenies = false;
      if (key.name === "y") void this.addDenies();
      else this.renderConnections();
      return;
    }
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
    } else if (key.name === "f" && !key.shift && key.sequence === "f") {
      const c = this.resolution?.connections[this.connectionIndex];
      if (c && this.passwordSources.get(c.name) === "keyring") {
        this.confirmingForget = true;
        this.renderConnections();
      }
    } else if (isShifted(key, "d") && (this.denies?.missing.length ?? 0) > 0 && !this.denies?.problem) {
      this.confirmingDenies = true;
      this.renderConnections();
    }
  }

  private promptKey(key: KeyEvent): void {
    const prompt = this.prompt!;
    if (key.name === "escape") {
      this.prompt = null;
    } else if (key.name === "return") {
      if (prompt.value === "") {
        prompt.error = "nothing typed yet; type the password, then Enter";
      } else {
        const typed = prompt.value;
        this.prompt = null;
        void this.connect(prompt.connection, typed);
      }
    } else if (key.name === "backspace") {
      prompt.value = [...prompt.value].slice(0, -1).join("");
    } else if (!key.ctrl && !key.meta && key.sequence && key.sequence.length >= 1 && key.sequence >= " ") {
      prompt.value += key.sequence;
    }
    this.renderConnections();
  }

  private async forgetPassword(): Promise<void> {
    const c = this.resolution?.connections[this.connectionIndex];
    if (!c || c.target.kind !== "ready" || c.target.params.password !== null) return;
    try {
      await this.keyring.forget(keyringKey(c.target.params));
      this.say(`forgot the stored password for ${c.name}`, "info");
    } catch (e) {
      this.say(`could not forget the password: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
    await this.refreshPasswordSources();
    this.renderConnections();
  }

  private async addDenies(): Promise<void> {
    try {
      const added = await addDenies(this.options.claudeSettings ?? claudeSettingsPath());
      this.say(`added ${added.length} deny ${added.length === 1 ? "rule" : "rules"} to ${this.denies?.settingsPath}`, "info");
    } catch (e) {
      this.say(`could not add the rules: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
    this.denies = await this.checkDenies();
    this.renderConnections();
  }

  private tablesKey(key: KeyEvent): void {
    const count = this.tables?.rows.length ?? 0;
    const step = listStep(key);
    if (step !== 0) {
      key.preventDefault();
      this.tableIndex = clamp(this.tableIndex + step, 0, Math.max(0, count - 1));
      this.renderTables();
      this.renderStatus();
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
      this.renderStatus();
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

  private async connect(connection: ResolvedConnection, typed: string | null = null): Promise<void> {
    if (connection.target.kind === "unavailable") {
      this.say(`${connection.name} is unavailable: ${connection.target.reason}`, "error");
      return;
    }
    const params = { ...connection.target.params };
    const key = keyringKey(params);
    let fromKeyring = false;
    if (params.password === null) {
      if (typed !== null) {
        params.password = typed;
      } else {
        params.password = await this.keyring.get(key);
        fromKeyring = params.password !== null;
        if (params.password === null) {
          const state = await this.keyring.state();
          this.askPassword(connection, state === "unlocked" ? null : "the keyring is locked or not running, so this password will not be stored");
          return;
        }
      }
    }
    const attempt = ++this.connectAttempt;
    this.say(`connecting to ${connection.name}…`, "info");

    let db: Database;
    try {
      db = await (this.options.open ? this.options.open(params) : Database.open(params));
    } catch (e) {
      if (attempt !== this.connectAttempt) return;
      const message = e instanceof Error ? e.message : String(e);
      if ((typed !== null || fromKeyring) && /password authentication failed|28P01/.test(message)) {
        this.askPassword(connection, `${fromKeyring ? "the stored password was rejected" : "that password was rejected"}: ${message}`);
        return;
      }
      this.say(`could not connect to ${connection.name}: ${message}`, "error");
      return;
    }
    this.afterConnect = null;
    if (typed !== null && (await this.keyring.state()) === "unlocked") {
      try {
        await this.keyring.set(key, typed);
      } catch (e) {
        this.afterConnect = { text: `connected, but the password was not stored: ${e instanceof Error ? e.message : String(e)}`, kind: "error" };
      }
      this.refreshPasswordSources().catch(() => {});
    } else if (typed !== null) {
      this.afterConnect = { text: "connected; the password was not stored, because the keyring is locked or not running", kind: "error" };
    }
    if (attempt !== this.connectAttempt) {
      await db.close().catch(() => {});
      return;
    }

    const previous = this.connected;
    this.connected = { connection, db };
    this.run = null;
    this.runSql = null;
    this.detail = null;
    this.tables = null;
    await previous?.db.close().catch(() => {});
    this.catalog = emptyCatalog;
    this.closeCompletion();
    const tables = await listTables(async (q) => (await db.run(q)).result);
    if (this.connected?.db !== db) return;
    this.tables = tables.kind === "rows" ? tables : null;
    this.tableIndex = 0;
    this.message = this.afterConnect;
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
    if (this.catalog === emptyCatalog && this.message === null) {
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
    this.renderEditorTitle();
    const sql = statementText(text, span);
    let run: Run;
    try {
      run = await db.run(sql);
    } finally {
      this.userRunning = false;
    }
    if (this.connected?.db !== db) return;
    this.run = run;
    this.runSql = sql;
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
    const place = this.resolution ? path.basename(this.resolution.worktree.root) : "";
    this.setTitle(c && this.screen === "workspace" ? `${place} › ${c.name}` : "connections");
    if (!c) {
      this.banner.bg = theme.surface;
      this.banner.content = styled(spread([fg(theme.muted)(" not connected")], [], this.renderer.width));
      return;
    }
    const pill = bold(bg(environmentColor[c.environment])(fg(theme.background)(` ● ${c.environment.toUpperCase()} `)));
    const target = c.target.kind === "ready" ? `${c.target.params.user}@${c.target.params.host}:${c.target.params.port}/${c.target.params.database}` : "";
    const claude: Line = [fg(theme.muted)("Claude "), fg(levelColor[c.agent])(c.agent)];
    const full: Line = [pill, fg(theme.muted)(`  ${target}  `), ...claude];
    this.banner.bg = environmentWash[c.environment];
    this.banner.content = styled(spread(lineWidth(full) <= this.renderer.width ? full : [pill, "  ", ...claude], [], this.renderer.width));
  }

  private setTitle(title: string): void {
    if (title === this.title) return;
    this.title = title;
    this.options.setTitle?.(title);
  }

  private renderConnections(): void {
    const connections = this.resolution?.connections ?? [];
    this.listLabel.content = sectionLabel("CONNECTIONS", this.screen === "connections" && !this.prompt);
    this.inspectLabel.content = sectionLabel("DETAILS", this.prompt !== null);
    if (connections.length === 0) {
      this.listText.content = styled([fg(theme.muted)("No connections.\n\nAdd .kowari.toml to the repo,\nor ~/.config/kowari/connections.toml")]);
      this.inspectText.content = this.problemsText();
      return;
    }
    const fixedColumns = 4 + 2 + 14 + "approve-writes".length;
    const longestName = Math.max("Name".length, ...connections.map((c) => c.name.length));
    const maxListWidth = Math.max(fixedColumns + 12, Math.floor(this.renderer.width * 0.6));
    this.listBox.width = Math.min(maxListWidth, longestName + fixedColumns + 4);
    const nameWidth = Math.max(8, Math.min(longestName, maxListWidth - 4 - fixedColumns));
    const header: Line = [bold(fg(theme.muted)(`     ${"name".padEnd(nameWidth + 2)}${"environment".padEnd(14)}claude`))];
    const rows = connections.map((c, i) => {
      const selected = i === this.connectionIndex;
      const marker = selected ? fg(theme.accent)("▎▸ ") : "   ";
      const active = this.connected?.connection.name === c.name ? fg(theme.ok)("● ") : "  ";
      const shown = c.name.length > nameWidth ? `${c.name.slice(0, nameWidth - 1)}…` : c.name;
      const name = fg(c.target.kind === "unavailable" ? theme.muted : theme.text)(shown.padEnd(nameWidth + 2));
      const row: Line = [marker, active, name, fg(environmentColor[c.environment])(c.environment.padEnd(14)), fg(levelColor[c.agent])(c.agent)];
      return selected ? paint(row, this.listBox.width, theme.selection) : row;
    });
    this.listText.content = styled(joinLines([header, ...rows]));
    this.inspectText.content = this.prompt
      ? this.promptText(this.prompt)
      : this.confirmingDenies
        ? this.denyConfirmation()
        : this.confirmingForget
          ? styled(joinLines(this.card(theme.warning, [[bold(fg(theme.warning)(`Forget the stored password for ${connections[this.connectionIndex]!.name}?`))], [], [fg(theme.muted)("You will be asked for it on the next connect.")], [], hintLine([["y", "forgets it"], ["any other key", "cancels"]])])))
        : this.inspection(connections[this.connectionIndex]!);
  }

  private askPassword(connection: ResolvedConnection, error: string | null): void {
    this.prompt = { connection, value: "", error };
    this.message = null;
    this.renderAll();
  }

  private promptText(prompt: PasswordPrompt): StyledText {
    const p = prompt.connection.target.kind === "ready" ? prompt.connection.target.params : null;
    const inner = Math.max(12, Math.min(48, this.inspectBox.width - 8));
    const typed = [...prompt.value].length;
    const dots = "•".repeat(Math.min(typed, inner - 1));
    const field = (text: string): TextChunk => bg(theme.background)(fg(theme.text)(text));
    const lines: Line[] = [
      [bold(fg(theme.text)(`Password for ${prompt.connection.name}`))],
      [fg(theme.muted)(p ? `${p.user}@${p.host}:${p.port}/${p.database}` : "")],
      [],
      [field(` ${dots}`), bg(theme.accent)(" "), field(" ".repeat(inner - dots.length))],
      [fg(theme.muted)(typed === 0 ? "type the password" : `${typed} ${typed === 1 ? "character" : "characters"}`)],
      [],
    ];
    if (prompt.error) lines.push([fg(theme.error)(prompt.error)], []);
    lines.push(hintLine([["⏎", "connects and stores it in your keyring"], ["Esc", "cancels"]]));
    return styled(joinLines(this.card(theme.accent, lines)));
  }

  private denyText(): Line[] {
    const denies = this.denies;
    if (!denies) return [];
    if (denies.problem) return [[], [fg(theme.warning)(`Claude Code settings: ${denies.problem}`)]];
    if (denies.missing.length === 0) return [];
    return [
      [],
      [fg(theme.warning)(`Claude Code can ${exposure(denies.missing)}: ${denies.missing.length} deny ${denies.missing.length === 1 ? "rule is" : "rules are"} missing from ${denies.settingsPath}. D adds them.`)],
    ];
  }

  private denyConfirmation(): StyledText {
    const denies = this.denies!;
    return styled(
      joinLines(this.card(theme.warning, [
        [bold(fg(theme.warning)("Keep Claude Code out of your keyring and kowari's config"))],
        [],
        [fg(theme.text)(`Add these to permissions.deny in ${denies.settingsPath}:`)],
        [],
        ...denies.missing.map((rule) => [fg(theme.text)(`  ${rule}`)]),
        [],
        [fg(theme.muted)("The rest of the file is kept, rewritten as formatted JSON.")],
        [fg(theme.muted)("They stop keyring tools and Claude Code's file tools, not a")],
        [fg(theme.muted)("shell command Claude writes; the Bash sandbox, where on, does.")],
        [],
        hintLine([["y", "adds them"], ["any other key", "cancels"]]),
      ])),
    );
  }

  private inspection(c: ResolvedConnection): StyledText {
    const field = (label: string, value: string, color: string = theme.text): Line => [fg(theme.muted)(label.padEnd(13)), fg(color)(value)];
    const lines: Line[] = [[bold(fg(theme.text)(c.name))], []];
    lines.push(field("environment", c.environment, environmentColor[c.environment]));
    lines.push(field("defined in", c.source === "user" ? "your config" : `.kowari.toml in ${this.resolution?.worktree.root ?? ""}`));
    if (c.target.kind === "ready") {
      const p = c.target.params;
      lines.push(field("host", `${p.host}:${p.port}`));
      lines.push(field("database", p.database));
      lines.push(field("user", p.user));
      lines.push(field("password", passwordLabel(this.passwordSources.get(c.name) ?? (p.password === null ? "asks" : "config"))));
      lines.push(field("sslmode", p.sslmode));
      if (p.sslrootcert) lines.push(field("sslrootcert", p.sslrootcert));
    } else {
      lines.push(field("unavailable", c.target.reason, theme.error));
    }
    lines.push([]);
    lines.push(field("Claude", c.agent, levelColor[c.agent]));
    if (c.agentNote) lines.push(field("", c.agentNote, theme.warning));
    lines.push([]);
    const forget = this.passwordSources.get(c.name) === "keyring";
    const hints: Hint[] = [["⏎", "connects"], ["r", "reloads config"]];
    if (forget) hints.push(["f", "forgets the stored password"]);
    if (this.connected) hints.push(["Esc", "back"]);
    lines.push(hintLine(hints));
    lines.push(...this.denyText());
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

  private card(stripe: string, lines: Line[]): Line[] {
    const width = Math.min(Math.max(20, this.inspectBox.width - 2), Math.max(...lines.map(lineWidth)) + 4);
    return [[], ...lines, []].map((line) => paint([fg(stripe)("▎ "), ...line], width, theme.raised));
  }

  private renderTables(): void {
    this.tablesLabel.content = sectionLabel("TABLES", this.focus === "tables");
    if (!this.tables) {
      this.tablesText.content = styled([fg(theme.muted)("   No tables")]);
      return;
    }
    const width = this.tablesBox.width;
    const height = Math.max(1, this.tablesBox.height - 2);
    const top = Math.max(0, Math.min(this.tableIndex - Math.floor(height / 2), this.tables.rows.length - height));
    const lines = this.tables.rows.slice(top, top + height).map((row, i) => {
      const selected = top + i === this.tableIndex;
      const focused = selected && this.focus === "tables";
      const marker = selected ? fg(theme.accent)(focused ? "▎▸ " : " ▸ ") : "   ";
      const schema = String(row[0]);
      const name = schema === "public" ? String(row[1]) : `${schema}.${row[1]}`;
      const size = ` ${displayValue(row[4])} `;
      const line: Line = [marker, fg(theme.text)(name.padEnd(Math.max(1, width - 3 - size.length))), fg(theme.muted)(size)];
      return focused ? paint(line, width, theme.selection) : line;
    });
    this.tablesText.content = styled(joinLines(lines));
  }

  private renderEditorTitle(): void {
    this.editorLabel.content = sectionLabel("SQL", this.focus === "editor", [this.userRunning ? fg(theme.warning)("running…") : fg(theme.faint)("ready")]);
  }

  private renderResults(): void {
    const focused = this.focus === "results";
    const width = Math.max(10, this.resultsBox.width - 1);
    const height = this.resultsHeight;
    const label = (...parts: TextChunk[]) => (this.resultsLabel.content = sectionLabel("RESULTS", focused, parts));

    if (this.detail) {
      label(fg(theme.text)(this.detail.title), fg(theme.muted)("Esc closes"));
      const body = this.detail.lines.slice(this.detail.top, this.detail.top + height).map((l) => paint([fg(theme.accent)("▎ "), fg(theme.text)(l)], width, theme.raised));
      this.resultsText.content = styled(joinLines(body));
      return;
    }

    const run = this.run;
    if (!run) {
      label();
      this.resultsText.content = "";
      return;
    }
    if (run.result.kind !== "rows") {
      label(fg(theme.error)("error"), fg(theme.muted)(formatMs(run.ms)));
      this.resultsText.content = styled([fg(theme.error)(`  ${run.result.kind === "error" ? run.result.message : run.result.reason}`)]);
      return;
    }

    const rows = run.result;
    label(fg(theme.text)(resultSummary(rows)), fg(theme.muted)(formatMs(run.ms)));
    if (rows.columns.length === 0) {
      this.resultsText.content = styled([fg(theme.muted)(`  ${rows.command ? `${rows.command}${rows.count !== null ? ` ${rows.count}` : ""}` : "done"}`)]);
      return;
    }
    const laid = layoutGrid(rows, this.grid, width, height);
    this.grid = laid.cursor;
    if (laid.first > 0 || laid.last < laid.total - 1) {
      label(fg(theme.text)(resultSummary(rows)), fg(theme.muted)(`columns ${laid.first + 1}–${laid.last + 1} of ${laid.total}`), fg(theme.muted)(formatMs(run.ms)));
    }
    this.resultsText.content = styled(joinLines(laid.lines));
  }

  private modeBadge(): TextChunk {
    const label = this.helix.mode === "insert" ? " INS " : this.helix.extending ? " EXT " : " NOR ";
    const pending = this.helix.pendingKey ? `${this.helix.pendingKey}… ` : "";
    return pill(`${label}${pending}`);
  }

  private statusContext(): string {
    if (this.screen === "connections") {
      const count = this.resolution?.connections.length ?? 0;
      return `${count} ${count === 1 ? "connection" : "connections"}`;
    }
    if (this.focus === "tables") {
      const row = this.tables?.rows[this.tableIndex];
      return row ? `tables · ${row[0]}.${row[1]}` : "tables";
    }
    if (this.focus === "results" && this.run?.result.kind === "rows" && this.run.result.rows.length > 0) {
      return `results · row ${(this.grid.row + 1).toLocaleString("en-US")} · ${this.run.result.columns[this.grid.col]?.name ?? ""}`;
    }
    return paneLabel[this.focus];
  }

  private renderStatus(): void {
    const left: Line = [this.screen === "workspace" ? this.modeBadge() : pill(" CONNECT "), " "];
    left.push(this.message ? fg(this.message.kind === "error" ? theme.error : theme.muted)(this.message.text) : fg(theme.muted)(this.statusContext()));
    const hints = [...(this.screen === "connections" ? connectionHints : workspaceHints)];
    let right = [...hintLine(hints), " "];
    while (hints.length > 0 && lineWidth(left) + lineWidth(right) + 2 > this.renderer.width) {
      hints.pop();
      right = [...hintLine(hints), " "];
    }
    this.status.content = styled(spread(left, right, this.renderer.width));
  }
}

function section(renderer: CliRenderer, size: Record<string, unknown>): [BoxRenderable, TextRenderable] {
  const box = new BoxRenderable(renderer, { ...size, flexDirection: "column" });
  const label = new TextRenderable(renderer, { content: "", height: 1, wrapMode: "none", flexShrink: 0, marginBottom: 1 });
  box.add(label);
  return [box, label];
}

function sectionLabel(name: string, focused: boolean, parts: TextChunk[] = []): StyledText {
  const color = focused ? theme.accent : theme.muted;
  return styled([fg(theme.accent)(focused ? "▎" : " "), bold(fg(color)(name)), ...parts.flatMap((part) => [fg(theme.faint)("  ·  "), part])]);
}

function pill(text: string): TextChunk {
  return bold(bg(theme.accent)(fg(theme.background)(text)));
}

function hintLine(hints: Hint[]): Line {
  return hints.flatMap(([key, label], i) => [...(i > 0 ? ["  "] : []), fg(theme.text)(key), fg(theme.muted)(` ${label}`)]);
}

function lineWidth(line: Line): number {
  return line.reduce((sum, part) => sum + Bun.stringWidth(typeof part === "string" ? part : part.text), 0);
}

function spread(left: Line, right: Line, width: number): Line {
  return [...left, " ".repeat(Math.max(1, width - lineWidth(left) - lineWidth(right))), ...right];
}

function isShifted(key: KeyEvent, letter: string): boolean {
  return key.sequence === letter.toUpperCase() || key.name === letter.toUpperCase() || (key.name === letter && key.shift);
}

function passwordLabel(source: PasswordSource): string {
  switch (source) {
    case "config":
      return "set in config";
    case "keyring":
      return "stored in your keyring";
    case "asks":
      return "asks on connect, then stored in your keyring";
    case "keyring locked":
      return "keyring is locked; unlock it to connect";
    case "no keyring":
      return "no keyring running; asks on connect, not stored";
  }
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
  return `${rows.rows.length.toLocaleString("en-US")} ${rows.rows.length === 1 ? "row" : "rows"}`;
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

function exposure(missing: string[]): string {
  const keyring = missing.some((rule) => keyringDenyRules.includes(rule));
  const config = missing.some((rule) => !keyringDenyRules.includes(rule));
  return keyring && config ? "run keyring tools and read or edit kowari's config" : keyring ? "run keyring tools" : "read or edit kowari's config";
}
