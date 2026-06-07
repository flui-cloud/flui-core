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
  spec: { schemaId: string; apiVersion: string };
  sources: unknown;
}

export interface CompiledKb {
  kbVersion: string;
  compatibility: KbCompatibility;
  guardrails: string;
  sections: KbSection[];
}
