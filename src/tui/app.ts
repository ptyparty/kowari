import {
  bg,
  bold,
  BoxRenderable,
  fg,
  StyledText,
  SyntaxStyle,
  TextareaRenderable,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type TextChunk,
} from "@opentui/core";
import { listTables } from "../agent/catalog.ts";
import { type Resolution, type ResolvedConnection } from "../connections/resolve.ts";
import { displayValue } from "../format.ts";
import { statementAt, statementText } from "../sql/statements.ts";
import { scan, type TokenKind } from "../sql/tokens.ts";
import { Database, type Run } from "./database.ts";
import { clamp, layoutGrid, moveCursor, type GridCursor, type Line, type Rows } from "./grid.ts";
import { environmentColor, levelColor, theme } from "./theme.ts";

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
      onContentChange: () => this.highlight(),
    });
    this.editorBox.add(this.editor);
    this.resultsBox = pane(renderer, "Results", { height: "55%", onSizeChange: () => this.renderResults() });
    this.resultsText = new TextRenderable(renderer, { content: "", wrapMode: "none", flexGrow: 1 });
    this.resultsBox.add(this.resultsText);
    right.add(this.editorBox);
    right.add(this.resultsBox);
    this.workspace.add(this.tablesBox);
    this.workspace.add(right);

    this.status = new TextRenderable(renderer, { content: "", height: 1, wrapMode: "none", flexShrink: 0 });

    frame.add(this.banner);
    frame.add(this.connectionsScreen);
    frame.add(this.workspace);
    frame.add(this.status);
    renderer.root.add(frame);
  }

  async start(): Promise<void> {
    this.renderer.keyInput.on("keypress", this.onKey);
    await this.reload();
  }

  async stop(): Promise<void> {
    this.renderer.keyInput.off("keypress", this.onKey);
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
    if (this.focus === "tables") this.tablesKey(key);
    else if (this.focus === "results") this.resultsKey(key);
  };

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
      if (this.connected?.db.busy) {
        this.say("a statement is still running (Ctrl-C cancels it)", "error");
        return;
      }
      const select = `select * from ${quoteIdent(String(row[0]))}.${quoteIdent(String(row[1]))} limit 100;`;
      const existing = this.editor.plainText.trimEnd();
      this.editor.editBuffer.setCursor(0, 0);
      this.moveCursorToEnd();
      this.editor.editBuffer.insertText(`${existing === "" ? "" : "\n\n"}${select}`);
      this.highlight();
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
    const tables = await listTables(async (q) => (await db.run(q)).result);
    if (this.connected?.db !== db) return;
    this.tables = tables.kind === "rows" ? tables : null;
    this.tableIndex = 0;
    this.message = null;
    this.focus = "editor";
    this.showScreen("workspace");
  }

  private async runStatementUnderCursor(): Promise<void> {
    if (!this.connected) return;
    if (this.connected.db.busy) {
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
    const run = await db.run(statementText(text, span));
    if (this.connected?.db !== db) return;
    this.run = run;
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
    const rows = connections.map((c, i) => {
      const selected = i === this.connectionIndex;
      const marker = selected ? fg(theme.accent)("▸ ") : "  ";
      const active = this.connected?.connection.name === c.name ? fg(theme.good)("● ") : "  ";
      const name = fg(c.target.kind === "unavailable" ? theme.muted : theme.text)(c.name.padEnd(nameWidth + 2));
      return [marker, active, name, fg(environmentColor[c.environment])(c.environment.padEnd(14)), fg(levelColor[c.agent])(c.agent)];
    });
    this.listText.content = styled(joinLines([header, ...rows]));
    this.inspectText.content = this.inspection(connections[this.connectionIndex]!);
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
      lines.push(field("password", p.password === null ? "missing" : "set"));
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

  private renderStatus(): void {
    const message = this.message ? [fg(this.message.kind === "error" ? theme.error : theme.muted)(` ${this.message.text}`)] : [];
    const hints =
      this.screen === "connections"
        ? " ↑↓ choose · Enter connect · r reload · Ctrl-Q quit"
        : " Ctrl-Enter run · Tab pane · Ctrl-O connections · Ctrl-C cancel · Ctrl-Q quit";
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

function newlineCounts(text: string): number[] {
  const counts = new Array<number>(text.length + 1);
  let seen = 0;
  for (let i = 0; i <= text.length; i++) {
    counts[i] = seen;
    if (text[i] === "\n") seen += 1;
  }
  return counts;
}

function quoteIdent(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`;
}

