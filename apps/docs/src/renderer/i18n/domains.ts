/**
 * Per-domain dictionary shapes shared by the locale entries (langs/<lang>.ts)
 * and the loader in strings.ts. Type-only: nothing here reaches the runtime
 * bundle, so locale chunks must not pull the zh fallback through it.
 */
export interface DomainDicts {
  app: Record<string, string>
  ribbon: Record<string, string>
  table: Record<string, string>
  editor: Record<string, string>
  ai: Record<string, string>
  zotero: Record<string, string>
}
