const id = { type: 'string', minLength: 1 };
const name = { type: 'string', minLength: 1, maxLength: 100 };
const key = { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$' };
const tool = (suffix: string, description: string, properties: Record<string, object> = {}, required: string[] = []) => ({
  name: 'workspace_' + suffix, description, inputSchema: { type: 'object' as const, properties, required, additionalProperties: false }
});
export const lifecycleTools = [
  tool('sites', 'List this owner profile’s saved sites, protected storage keys and current running, stopped or idle state.'),
  tool('start', 'Start the stopped site again, or launch the selected deployment from an idle dashboard.'),
  tool('stop', 'Save and stop the exact current site, keeping the owner and its saved data available.', { workspaceId: id }, ['workspaceId']),
  tool('restart', 'Restart PHP in the current site while retaining its files, database and owner.', { workspaceId: id }, ['workspaceId']),
  tool('reset', 'Erase the selected running or stopped site and launch the default deployment. Pass its exact workspace ID.', { workspaceId: id }, ['workspaceId']),
  tool('resume', 'Resume a stored site by its key. Use replaceWorkspaceId to allow a switch from the current site.', { storageKey: key, replaceWorkspaceId: id }, ['storageKey']),
  tool('rename', 'Rename the display name of a saved site in this browser profile.', { storageKey: key, name }, ['storageKey','name']),
  tool('delete', 'Delete a saved site by storage key. The current and stopped sites are protected.', { storageKey: key }, ['storageKey']),
];

export async function workspaceLifecycle(runtime: any, operation: string, args: Record<string, unknown>) {
  if (!runtime.agentOwner) throw new Error('This action requires the Playground owner API. Update the self-hosted Playground or reload an updated owner.');
  return runtime.agentOwner.perform(operation === 'workspace_sites' ? 'list' : operation.slice('workspace_'.length), args);
}
