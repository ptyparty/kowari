export const theme = {
  background: "#15171d",
  surface: "#1b1e26",
  surface2: "#20242d",
  raised: "#262a35",
  line: "#2c313d",
  text: "#d5d8e0",
  muted: "#868c9c",
  faint: "#4f5566",
  selection: "#283350",
  accent: "#66c7c2",
  ok: "#9fd07e",
  warning: "#f0a36a",
  error: "#ef6b6b",
  keyword: "#b99cf0",
  function: "#8ea8ff",
  type: "#66c7c2",
  string: "#a9d48a",
  number: "#f2a2c0",
  operator: "#c9b27f",
  comment: "#6b7285",
  punctuation: "#9aa0b0",
  parameter: "#f2a2c0",
} as const;

export const levelColor = {
  none: theme.muted,
  "read-only": theme.ok,
  "approve-writes": theme.warning,
  write: theme.error,
} as const;

export const environmentColor = {
  local: "#9fd07e",
  testing: "#e9b765",
  production: "#ef6b6b",
} as const;

export const environmentWash = {
  local: "#1c2420",
  testing: "#262218",
  production: "#2b1a1d",
} as const;
