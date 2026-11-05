export const theme = {
  background: "#0f1117",
  surface: "#181b24",
  surface2: "#1f2330",
  raised: "#282e3d",
  line: "#323949",
  text: "#e8ebf2",
  muted: "#9298ab",
  faint: "#565e72",
  selection: "#2c3a68",
  accent: "#5ad8cf",
  ok: "#a2e27a",
  warning: "#ffa863",
  error: "#ff6b6b",
  keyword: "#c89dff",
  function: "#8fb0ff",
  type: "#5ad8cf",
  string: "#b4e388",
  number: "#ffa0c8",
  operator: "#e0c27d",
  comment: "#6e7790",
  punctuation: "#a0a7ba",
  parameter: "#ffa0c8",
} as const;

export const levelColor = {
  none: theme.muted,
  "read-only": theme.ok,
  "approve-writes": theme.warning,
  write: theme.error,
} as const;

export const environmentColor = {
  local: "#a2e27a",
  testing: "#ffc45e",
  production: "#ff6b6b",
} as const;

export const environmentWash = {
  local: "#18261d",
  testing: "#2a2416",
  production: "#311a1f",
} as const;
