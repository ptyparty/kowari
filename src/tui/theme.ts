export const theme = {
  accent: "#7e9cd8",
  muted: "#727169",
  border: "#54546d",
  focus: "#7e9cd8",
  text: "#dcd7ba",
  background: "#1f1f28",
  surface: "#2a2a37",
  selection: "#2d4f67",
  warning: "#ffa066",
  error: "#e82424",
  good: "#98bb6c",
  keyword: "#957fb8",
  string: "#98bb6c",
  number: "#d27e99",
  comment: "#727169",
  operator: "#c0a36e",
  parameter: "#e6c384",
} as const;

export const levelColor = {
  none: theme.muted,
  "read-only": theme.good,
  "approve-writes": theme.warning,
  write: theme.error,
} as const;

export const environmentColor = {
  local: "#98bb6c",
  testing: "#e6c384",
  production: "#e82424",
} as const;
