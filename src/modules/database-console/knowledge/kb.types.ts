export interface SqlKbSection {
  id: string;
  title: string;
  body: string;
}

export interface SqlKb {
  /** Curated, version-agnostic. Live server version is injected as a binding at runtime. */
  kbVersion: string;
  /** Dialect tag, e.g. `postgres` | `mysql`. */
  dialect: string;
  guardrails: string;
  sections: SqlKbSection[];
}
