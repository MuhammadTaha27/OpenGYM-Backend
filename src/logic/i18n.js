// The server returns English templates; the app translates them (its `t` takes the same
// template + args). This only fills placeholders for the few strings stored as plain text.
export const t = (s, ...args) => String(s).replace(/\{(\d+)\}/g, (m, i) => (args[i] ?? m))
