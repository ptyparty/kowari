import type { EditorKind } from "../connections/config.ts";
import type { KeyCommand, KeyGroup } from "../context.ts";

export type KeyContext =
  | "connections"
  | "filter"
  | "password"
  | "confirm"
  | "normal"
  | "insert"
  | "completion"
  | "tables"
  | "results"
  | "grid"
  | "detail"
  | "menu"
  | "help"
  | "finder"
  | "history"
  | "command"
  | "search";

export type MenuAction = "find" | "history" | "connections" | "run" | "detail" | "copyCell" | "copyRow" | "help" | "quit";

export type Binding = {
  group: string;
  label: string;
  keys: string;
  send?: string;
  when: KeyContext[];
  menu?: { letter: string; action: MenuAction };
  editor?: EditorKind;
};


const esc = "\u001b";
const workspace: KeyContext[] = ["normal", "insert", "tables", "results", "grid", "detail"];
const menuFrom: KeyContext[] = ["normal", "tables", "results", "grid", "connections"];
const panes: KeyContext[] = ["normal", "tables", "results", "grid"];

function menu(letter: string, label: string, action: MenuAction, when: KeyContext[]): Binding {
  return { group: "Menu", label, keys: `␣ ${letter}`, send: ` ${letter}`, when, menu: { letter, action } };
}

export const bindings: Binding[] = [
  { group: "Menu", label: "open the menu", keys: "␣", send: " ", when: menuFrom },
  menu("f", "find table", "find", panes),
  menu("h", "query history", "history", panes),
  menu("r", "run statement", "run", panes),
  menu("d", "open the cell", "detail", ["grid"]),
  menu("y", "copy cell", "copyCell", ["grid"]),
  menu("Y", "copy row", "copyRow", ["grid"]),
  menu("c", "connections", "connections", panes),
  menu("?", "help", "help", menuFrom),
  menu("q", "quit", "quit", menuFrom),

  { group: "Workspace", label: "run statement under the cursor", keys: "F5  ^⏎", send: `${esc}[15~`, when: [...workspace, "completion"] },
  { group: "Workspace", label: "next pane", keys: "Tab", send: "\t", when: workspace },
  { group: "Workspace", label: "previous pane", keys: "⇧Tab", send: `${esc}[Z`, when: workspace },
  { group: "Workspace", label: "query history", keys: "^r", send: "\u0012", when: [...workspace, "completion"], editor: "helix" },
  { group: "Workspace", label: "query history", keys: "^r", send: "\u0012", when: ["insert", "tables", "results", "grid", "detail", "completion"], editor: "vi" },
  { group: "Workspace", label: "connections", keys: "^o", send: "\u000f", when: [...workspace, "completion"] },
  { group: "Workspace", label: "cancel the running statement", keys: "^c", send: "\u0003", when: [...workspace, "completion"] },
  { group: "Workspace", label: "quit", keys: "^q", send: "\u0011", when: [...workspace, "completion", "connections", "filter"] },

  { group: "Connections", label: "choose", keys: "↑↓  jk", when: ["connections"] },
  { group: "Connections", label: "connect", keys: "⏎", send: "\r", when: ["connections"] },
  { group: "Connections", label: "filter by name", keys: "/", send: "/", when: ["connections"] },
  { group: "Connections", label: "reload config", keys: "r", send: "r", when: ["connections"] },
  { group: "Connections", label: "forget the stored password", keys: "f", send: "f", when: ["connections"] },
  { group: "Connections", label: "add Claude Code deny rules", keys: "D", send: "D", when: ["connections"] },
  { group: "Connections", label: "back to the workspace", keys: "Esc", send: esc, when: ["connections"] },

  { group: "Filter", label: "type to filter", keys: "abc", when: ["filter"] },
  { group: "Filter", label: "choose", keys: "↑↓  ^n ^p", when: ["filter"] },
  { group: "Filter", label: "connect", keys: "⏎", send: "\r", when: ["filter"] },
  { group: "Filter", label: "clear the filter", keys: "Esc", send: esc, when: ["filter"] },

  { group: "Password", label: "connect and store it", keys: "⏎", send: "\r", when: ["password"] },
  { group: "Password", label: "cancel", keys: "Esc", send: esc, when: ["password"] },
  { group: "Confirm", label: "yes", keys: "y", send: "y", when: ["confirm"] },
  { group: "Confirm", label: "cancel", keys: "Esc", send: esc, when: ["confirm"] },

  { group: "Move", label: "left, down, up, right", keys: "h j k l", when: ["normal"] },
  { group: "Move", label: "next word, word end, previous word", keys: "w e b", when: ["normal"] },
  { group: "Move", label: "first line", keys: "gg", send: "gg", when: ["normal"] },
  { group: "Move", label: "last line", keys: "ge", send: "ge", when: ["normal"], editor: "helix" },
  { group: "Move", label: "line start, first non-blank, line end", keys: "gh gs gl", when: ["normal"], editor: "helix" },
  { group: "Move", label: "to or till a character", keys: "f t F T", when: ["normal"] },
  { group: "Move", label: "search the SQL", keys: "/", send: "/", when: ["normal"] },
  { group: "Move", label: "next, previous match", keys: "n N", when: ["normal"] },
  { group: "Select", label: "extend selections", keys: "v", send: "v", when: ["normal"], editor: "helix" },
  { group: "Select", label: "select line, then the next", keys: "x", send: "x", when: ["normal"], editor: "helix" },
  { group: "Select", label: "select everything", keys: "%", send: "%", when: ["normal"], editor: "helix" },
  { group: "Select", label: "collapse the selection", keys: ";", send: ";", when: ["normal"], editor: "helix" },
  { group: "Edit", label: "insert before, after", keys: "i a", when: ["normal"] },
  { group: "Edit", label: "insert at line start, end", keys: "I A", when: ["normal"] },
  { group: "Edit", label: "open a line below, above", keys: "o O", when: ["normal"] },
  { group: "Edit", label: "delete, change", keys: "d c", when: ["normal"], editor: "helix" },
  { group: "Edit", label: "yank, paste after, before", keys: "y p P", when: ["normal"], editor: "helix" },
  { group: "Edit", label: "undo, redo", keys: "u U", when: ["normal"], editor: "helix" },
  { group: "Move", label: "line start, first non-blank, end", keys: "0 ^ $", when: ["normal"], editor: "vi" },
  { group: "Move", label: "last line, or line n with a count", keys: "G", send: "G", when: ["normal"], editor: "vi" },
  { group: "Move", label: "next, previous WORD, WORD end", keys: "W B E", when: ["normal"], editor: "vi" },
  { group: "Move", label: "repeat the find, backwards", keys: "; ,", when: ["normal"], editor: "vi" },
  { group: "Move", label: "matching bracket", keys: "%", send: "%", when: ["normal"], editor: "vi" },
  { group: "Move", label: "repeat a motion or edit n times", keys: "2w 3dd", when: ["normal"], editor: "vi" },
  { group: "Select", label: "select characters, lines", keys: "v V", when: ["normal"], editor: "vi" },
  { group: "Select", label: "other end of the selection", keys: "o", when: ["normal"], editor: "vi" },
  { group: "Edit", label: "delete, change, yank + motion", keys: "d c y", when: ["normal"], editor: "vi" },
  { group: "Edit", label: "the whole line", keys: "dd cc yy", when: ["normal"], editor: "vi" },
  { group: "Edit", label: "inside, around a word", keys: "iw aw", when: ["normal"], editor: "vi" },
  { group: "Edit", label: "inside, around ( [ { ' \"", keys: "i( a'", when: ["normal"], editor: "vi" },
  { group: "Edit", label: "delete a character, before", keys: "x X", when: ["normal"], editor: "vi" },
  { group: "Edit", label: "delete, change to line end", keys: "D C", when: ["normal"], editor: "vi" },
  { group: "Edit", label: "substitute character, line", keys: "s S", when: ["normal"], editor: "vi" },
  { group: "Edit", label: "replace a character, replace mode", keys: "r R", when: ["normal"], editor: "vi" },
  { group: "Edit", label: "join lines, toggle case", keys: "J ~", when: ["normal"], editor: "vi" },
  { group: "Edit", label: "paste after, before", keys: "p P", when: ["normal"], editor: "vi" },
  { group: "Edit", label: "undo, redo", keys: "u ^r", when: ["normal"], editor: "vi" },
  { group: "Edit", label: "command line", keys: ":", send: ":", when: ["normal"] },
  { group: "Edit", label: "quit", keys: ":q", send: ":q\r", when: ["normal"] },
  { group: "Insert", label: "back to normal mode", keys: "Esc", send: esc, when: ["insert"] },
  { group: "Insert", label: "complete", keys: "^␣", send: "\u0000", when: ["insert"] },
  { group: "Completion", label: "choose", keys: "↑↓", when: ["completion"] },
  { group: "Completion", label: "complete as far as the matches agree", keys: "Tab", send: "\t", when: ["completion"] },
  { group: "Completion", label: "take the highlighted one", keys: "⇧Tab", send: `${esc}[Z`, when: ["completion"] },
  { group: "Completion", label: "close and leave insert mode", keys: "Esc", send: esc, when: ["completion"] },

  { group: "Tables", label: "choose", keys: "↑↓  jk", when: ["tables"] },
  { group: "Tables", label: "select its first 100 rows", keys: "⏎", send: "\r", when: ["tables"] },

  { group: "Results", label: "move", keys: "hjkl  ←↓↑→", when: ["grid"] },
  { group: "Results", label: "first, last row", keys: "g G", when: ["grid"] },
  { group: "Results", label: "page up, down", keys: "PgUp PgDn", when: ["grid"] },
  { group: "Results", label: "open the cell", keys: "⏎", send: "\r", when: ["grid"] },
  { group: "Results", label: "search cells", keys: "/", send: "/", when: ["grid"] },
  { group: "Results", label: "next match", keys: "n", send: "n", when: ["grid"] },
  { group: "Results", label: "previous match", keys: "N", send: "N", when: ["grid"] },
  { group: "Results", label: "clear the search", keys: "Esc", send: esc, when: ["grid"] },
  { group: "Results", label: "copy cell, row", keys: "y Y", when: ["grid"] },
  { group: "Results", label: "select a block of cells", keys: "V", send: "V", when: ["grid"] },
  { group: "Results", label: "copy the block, its whole rows", keys: "y Y", when: ["grid"] },
  { group: "Cell", label: "scroll", keys: "↑↓  jk", when: ["detail"] },
  { group: "Cell", label: "close", keys: "Esc  q", send: esc, when: ["detail"] },

  { group: "Find table", label: "type to filter", keys: "abc", when: ["finder"] },
  { group: "Find table", label: "choose", keys: "↑↓  ^n ^p", when: ["finder"] },
  { group: "Find table", label: "select its first 100 rows", keys: "⏎", send: "\r", when: ["finder"] },
  { group: "Find table", label: "close", keys: "Esc", send: esc, when: ["finder"] },
  { group: "History", label: "type words to find", keys: "abc", when: ["history"] },
  { group: "History", label: "choose", keys: "↑↓  ^n ^p", when: ["history"] },
  { group: "History", label: "older", keys: "^r", send: "\u0012", when: ["history"] },
  { group: "History", label: "put it in the editor", keys: "⏎", send: "\r", when: ["history"] },
  { group: "History", label: "close", keys: "Esc", send: esc, when: ["history"] },
  { group: "Command line", label: "quit", keys: ":q", send: "q\r", when: ["command"] },
  { group: "Command line", label: "help", keys: ":help", send: "help\r", when: ["command"] },
  { group: "Command line", label: "run it", keys: "⏎", send: "\r", when: ["command"] },
  { group: "Command line", label: "close", keys: "Esc", send: esc, when: ["command"] },
  { group: "Search", label: "type what to find", keys: "abc", when: ["search"] },
  { group: "Search", label: "find it", keys: "⏎", send: "\r", when: ["search"] },
  { group: "Search", label: "cancel", keys: "Esc", send: esc, when: ["search"] },
  { group: "Help", label: "scroll", keys: "↑↓  jk", when: ["help"] },
  { group: "Help", label: "close", keys: "Esc  q", send: esc, when: ["help"] },
];

export function opensMenu(context: KeyContext): boolean {
  return menuFrom.includes(context);
}

export function menuEntries(from: KeyContext): Binding[] {
  return bindings.filter((b) => b.menu && b.when.includes(from));
}

export function menuAction(from: KeyContext, letter: string): MenuAction | undefined {
  return menuEntries(from).find((b) => b.menu!.letter === letter)?.menu!.action;
}

export function helpContexts(from: KeyContext): KeyContext[] {
  switch (from) {
    case "normal":
    case "insert":
    case "completion":
      return ["normal", "insert", "completion", "command", "history"];
    case "tables":
      return ["tables", "finder"];
    case "grid":
      return ["grid", "search", "detail", "finder"];
    default:
      return [from];
  }
}

export function groupsFor(contexts: KeyContext[], editor: EditorKind): KeyGroup[] {
  const groups = new Map<string, KeyCommand[]>();
  const seen = new Set<string>();
  for (const b of bindings) {
    if (!b.when.some((c) => contexts.includes(c)) || (b.editor && b.editor !== editor)) continue;
    const id = `${b.group}\u0000${b.label}\u0000${b.keys}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const commands = groups.get(b.group) ?? [];
    commands.push(b.send === undefined ? { label: b.label, keys: b.keys } : { label: b.label, keys: b.keys, send: b.send });
    groups.set(b.group, commands);
  }
  return [...groups].map(([name, commands]) => ({ name, commands }));
}

export function menuGroups(from: KeyContext): KeyGroup[] {
  return [
    {
      name: "Menu",
      commands: [...menuEntries(from).map((b) => ({ label: b.label, keys: b.menu!.letter, send: b.menu!.letter })), { label: "close", keys: "Esc", send: esc }],
    },
  ];
}
