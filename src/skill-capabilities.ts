import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Snapshot } from './skill-distribution.js';

type Group = { id: string; title: string; tools: string[]; guides: string[];
  includeRegisteredSkills?: boolean; includeRegisteredModules?: boolean };

export async function loadCapabilityGroups(snapshot: Snapshot) {
  async function json(path: string) { return JSON.parse((await snapshot.read(path)).toString('utf8')); }
  const [registry, skills, modules] = await Promise.all([
    json('registries/playground-mcp.json'), json('registries/skills.json'), json('registries/modules.json'),
  ]);
  if (registry.version !== 1 || !Array.isArray(registry.capabilities) || !registry.capabilities.length) {
    throw new Error('Unsupported Playground capability registry');
  }
  const files = new Set(snapshot.files);
  const ids = new Set<string>();
  return (registry.capabilities as Group[]).map(group => {
    if (!/^[a-z][a-z0-9-]*$/.test(group.id) || ids.has(group.id) || typeof group.title !== 'string' ||
      !Array.isArray(group.tools) || !group.tools.length || !group.tools.every(rule => /^[a-z][a-z0-9_]*\*?$/.test(rule)) ||
      !Array.isArray(group.guides) || !group.guides.length) throw new Error('Invalid Playground capability: ' + group.id);
    ids.add(group.id);
    const guides = new Set(group.guides);
    if (group.includeRegisteredSkills) for (const entry of skills.skills) guides.add(entry.path);
    if (group.includeRegisteredModules) for (const entry of modules.modules) {
      for (const key of ['skill_entrypoint', 'entrypoint', 'test_workflow', 'source_baseline']) if (entry[key]) guides.add(entry[key]);
    }
    for (const path of guides) if (!files.has(path)) throw new Error('Missing capability guide: ' + path);
    return { ...group, guides: [...guides] };
  });
}

export function resolveCapabilities(groups: Group[], tools: Tool[], selected?: string) {
  if (selected && !groups.some(group => group.id === selected)) throw new Error('Unknown Skills capability: ' + selected);
  const owners = new Map<string, string>();
  const capabilities = groups.map(group => {
    const operations = tools.filter(tool => group.tools.some(pattern =>
      pattern.endsWith('*') ? tool.name.startsWith(pattern.slice(0, -1)) : tool.name === pattern)).map(tool => {
      const previous = owners.get(tool.name);
      if (previous) throw new Error('Ambiguous Skills routing for ' + tool.name + ': ' + previous + ', ' + group.id);
      owners.set(tool.name, group.id);
      const properties = tool.inputSchema.properties as Record<string, { enum?: unknown[] }> | undefined;
      return { name: tool.name,
        ...(Array.isArray(properties?.action?.enum) ? { actions: properties.action.enum } : {}),
        ...(Array.isArray(properties?.provider?.enum) ? { providers: properties.provider.enum } : {}),
      };
    });
    return {
      id: group.id, title: group.title, available: operations.length > 0, operations,
      guides: group.guides.map(path => 'joomengine://skills/' + path.split('/').map(encodeURIComponent).join('/')),
    };
  });
  return { capabilities: selected ? capabilities.filter(group => group.id === selected) : capabilities,
    unmappedTools: tools.filter(tool => !owners.has(tool.name)).map(tool => tool.name) };
}
