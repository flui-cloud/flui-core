/**
 * The read-only tools the dashboard assistant offers a sandbox guest, chosen by
 * hand. A guest acts through the dashboard (install, deploy, restart); the
 * assistant explains and looks things up, so it is not handed the 80-odd tools
 * the fence would allow, which cost a guest's token budget on every step.
 * Each entry says why it is here. MCP keeps the fence-derived list
 * (`isOfferedToGuest`); every name here must also pass it.
 */
export const GUEST_ASSISTANT_TOOLS: Readonly<Record<string, string>> = {
  get_started: 'how this instance is operated, the first thing an agent reads',
  my_permissions:
    'what the trial allows and leaves out, so the answer never promises a missing area',
  project_list: 'where the guest’s applications live',
  cluster_list: 'which cluster the guest is looking at',
  cluster_resources: '“will this fit?” before the guest installs something',
  app_list: 'the guest’s applications',
  app_get: 'one application, including its real access URL',
  app_status: 'is it running right now',
  app_debug: 'why an application is failing or stuck',
  app_logs: 'opens the guest’s logs in the viewer',
  app_events: 'what happened to an application',
  app_releases: 'deploy and rollback history',
  app_metrics: 'CPU, memory and disk of an application',
  app_variables: 'configuration, secret values masked',
  operation_status: 'how a deploy or install the guest started went',
  catalog_search: 'what can be installed',
  catalog_get_app: 'what an installable app needs, and whether it fits now',
  template_list: 'starter templates for a new project',
  app_manifest_validate: 'checks a flui.yaml the guest is writing',
  repo_list: 'connected repositories, and why the list is empty',
};

const GUEST_TOOL_NAMES = new Set(Object.keys(GUEST_ASSISTANT_TOOLS));

export function isGuestAssistantTool(name: string): boolean {
  return GUEST_TOOL_NAMES.has(name);
}
