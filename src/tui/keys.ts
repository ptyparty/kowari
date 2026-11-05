import type { KeyCommand, KeyGroup } from "../context.ts";

export type KeyContext =
  | "connections"
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
  | "command"
  | "search";

export type MenuAction = "find" | "connections" | "run" | "detail" | "copyCell" | "copyRow" | "help" | "quit";

export type Binding = {
  group: string;
  label: string;
  keys: string;
  send?: string;
  when: KeyContext[];
  menu?: { letter: string; action: MenuAction };
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
  { group: "Workspace", label: "connections", keys: "^o", send: "\u000f", when: [...workspace, "completion"] },
  { group: "Workspace", label: "cancel the running statement", keys: "^c", send: "\u0003", when: [...workspace, "completion"] },
  { group: "Workspace", label: "quit", keys: "^q", send: "\u0011", when: [...workspace, "completion", "connections"] },

  { group: "Connections", label: "choose", keys: "↑↓  jk", when: ["connections"] },
  { group: "Connections", label: "connect", keys: "⏎", send: "\r", when: ["connections"] },
  { group: "Connections", label: "reload config", keys: "r", send: "r", when: ["connections"] },
  { group: "Connections", label: "forget the stored password", keys: "f", send: "f", when: ["connections"] },
  { group: "Connections", label: "add Claude Code deny rules", keys: "D", send: "D", when: ["connections"] },
  { group: "Connections", label: "back to the workspace", keys: "Esc", send: esc, when: ["connections"] },

  { group: "Password", label: "connect and store it", keys: "⏎", send: "\r", when: ["password"] },
  { group: "Password", label: "cancel", keys: "Esc", send: esc, when: ["password"] },
  { group: "Confirm", label: "yes", keys: "y", send: "y", when: ["confirm"] },
  { group: "Confirm", label: "cancel", keys: "Esc", send: esc, when: ["confirm"] },

  { group: "Move", label: "left, down, up, right", keys: "h j k l", when: ["normal"] },
  { group: "Move", label: "next word, word end, previous word", keys: "w e b", when: ["normal"] },
  { group: "Move", label: "first line", keys: "gg", send: "gg", when: ["normal"] },
  { group: "Move", label: "last line", keys: "ge", send: "ge", when: ["normal"] },
  { group: "Move", label: "line start, first non-blank, line end", keys: "gh gs gl", when: ["normal"] },
  { group: "Move", label: "to or till a character", keys: "f t F T", when: ["normal"] },
  { group: "Move", label: "search the SQL", keys: "/", send: "/", when: ["normal"] },
  { group: "Move", label: "next, previous match", keys: "n N", when: ["normal"] },
  { group: "Select", label: "extend selections", keys: "v", send: "v", when: ["normal"] },
  { group: "Select", label: "select line, then the next", keys: "x", send: "x", when: ["normal"] },
  { group: "Select", label: "select everything", keys: "%", send: "%", when: ["normal"] },
  { group: "Select", label: "collapse the selection", keys: ";", send: ";", when: ["normal"] },
  { group: "Edit", label: "insert before, after", keys: "i a", when: ["normal"] },
  { group: "Edit", label: "insert at line start, end", keys: "I A", when: ["normal"] },
  { group: "Edit", label: "open a line below, above", keys: "o O", when: ["normal"] },
  { group: "Edit", label: "delete, change", keys: "d c", when: ["normal"] },
  { group: "Edit", label: "yank, paste after, before", keys: "y p P", when: ["normal"] },
  { group: "Edit", label: "undo, redo", keys: "u U", when: ["normal"] },
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
  { group: "Cell", label: "scroll", keys: "↑↓  jk", when: ["detail"] },
  { group: "Cell", label: "close", keys: "Esc  q", send: esc, when: ["detail"] },

  { group: "Find table", label: "type to filter", keys: "abc", when: ["finder"] },
  { group: "Find table", label: "choose", keys: "↑↓  ^n ^p", when: ["finder"] },
  { group: "Find table", label: "select its first 100 rows", keys: "⏎", send: "\r", when: ["finder"] },
  { group: "Find table", label: "close", keys: "Esc", send: esc, when: ["finder"] },
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
      return ["normal", "insert", "completion", "command"];
    case "tables":
      return ["tables", "finder"];
    case "grid":
      return ["grid", "search", "detail", "finder"];
    default:
      return [from];
  }
}

export function groupsFor(contexts: KeyContext[]): KeyGroup[] {
  const groups = new Map<string, KeyCommand[]>();
  const seen = new Set<string>();
  for (const b of bindings) {
    if (!b.when.some((c) => contexts.includes(c))) continue;
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
