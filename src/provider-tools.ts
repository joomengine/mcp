// The active site's providers use their existing protocol and keep their own namespaces.
export function providerTools(composer: boolean) {
  const provider = { type: 'string', enum: composer ? ['joomla', 'native', 'composer'] : ['joomla', 'native'],
    description: 'joomla is the TypeScript server on the current site; native is the installed site MCP; composer is the host-configured remote site.' };
  const text = { type: 'string', minLength: 1 };
  const listing = { cursor: { ...text, description: 'The nextCursor from a previous page.' } };
  const tool = (name: string, description: string, fields: Record<string, object> = {}, required: string[] = []) => ({
    name, description, inputSchema: { type: 'object' as const, properties: { provider, ...fields }, required: ['provider', ...required], additionalProperties: false }
  });
  return [
    tool('provider_info', 'Read the selected provider’s negotiated capabilities, identity, version and instructions.'),
    tool('provider_resources', 'List the resources currently offered by a Joomla MCP provider.', listing),
    tool('provider_resource_templates', 'List the parameterized resource URI templates offered by the selected provider.', listing),
    tool('provider_resource', 'Read a discovered resource URI through the same provider, including binary content.', { uri: text }, ['uri']),
    tool('provider_prompts', 'List the selected provider’s prompts and their available arguments.', listing),
    tool('provider_prompt', 'Retrieve a named prompt and its messages from the selected provider.', {
      name: text, arguments: { type: 'object', additionalProperties: { type: 'string' } }
    }, ['name']),
  ];
}
