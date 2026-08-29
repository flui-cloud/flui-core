export interface KbSection {
  id: string;
  title: string;
  source: string;
  body: string;
}

export interface KbCompatibility {
  cli: string;
  platform: {
    version: string;
    bootstrapRef: string;
    images: { fluiApi: string; fluiWeb: string; fluiAuthz: string };
  };
  /**
   * One binding per manifest kind. A single field forced a choice between the
   * two contracts, and reported the catalog one as though it were the spec.
   */
  spec: {
    application: { schemaId: string; apiVersion: string };
    catalogApp: { schemaId: string; apiVersion: string };
  };
  sources: unknown;
}

export interface CompiledKb {
  kbVersion: string;
  compatibility: KbCompatibility;
  guardrails: string;
  sections: KbSection[];
}
