import { ApiClient } from './api-client';
import { ConfigStorage } from './config-storage';

export interface ProjectItem {
  id: string;
  name: string;
  slug: string;
  ownerUserId?: string | null;
}

/**
 * Projects are where applications live: one namespace each, so applications
 * of one project share their building blocks. A new application goes to the
 * project named here or, when none is named, to the caller's personal one.
 */
export class ProjectClient {
  private readonly api: ApiClient;

  constructor(api: ApiClient) {
    this.api = api;
  }

  static fromConfig(): ProjectClient {
    const cfg = new ConfigStorage();
    const apiUrl = cfg.getApiUrlOrThrow();
    const apiKey = cfg.getApiKeyOrThrow();
    return new ProjectClient(new ApiClient({ baseUrl: apiUrl, apiKey }));
  }

  async list(): Promise<ProjectItem[]> {
    return this.api.get<ProjectItem[]>('/projects');
  }

  async create(input: {
    name: string;
    description?: string;
  }): Promise<ProjectItem> {
    return this.api.post<ProjectItem>('/projects', input);
  }

  async rename(id: string, name: string): Promise<ProjectItem> {
    return this.api.patch<ProjectItem>(`/projects/${encodeURIComponent(id)}`, {
      name,
    });
  }

  async remove(id: string): Promise<void> {
    await this.api.delete(`/projects/${encodeURIComponent(id)}`);
  }

  /** `ref` is a slug, an id or a name: whichever the person has at hand. */
  async resolveId(ref: string): Promise<string> {
    return resolveProjectId(await this.list(), ref);
  }
}

export function resolveProjectId(projects: ProjectItem[], ref: string): string {
  const wanted = ref.trim();
  const byKey = projects.find((p) => p.slug === wanted || p.id === wanted);
  if (byKey) return byKey.id;
  const byName = projects.filter(
    (p) => p.name.toLowerCase() === wanted.toLowerCase(),
  );
  if (byName.length === 1) return byName[0].id;
  if (byName.length > 1) {
    throw new Error(
      `More than one project is called "${ref}". Use its slug: ${byName.map((p) => p.slug).join(', ')}`,
    );
  }
  throw new Error(
    `No project "${ref}". See the projects you can use with: flui project list`,
  );
}
