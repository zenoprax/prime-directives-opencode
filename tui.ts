// Compatibility shim: some OpenCode V2 builds resolve a plugin directory's CLI
// entry by file convention (tui.ts beside index.ts) instead of reading the
// "./tui" export from package.json. Re-exporting keeps overrides in one place:
// the real implementation lives in tui.tsx.
export { default } from "./tui.tsx"
