# Joomla and JCB connections

Open a Playground site with `workspace_open` or select a running client workspace with `workspace_attach`. The agent can use the following interfaces on the selected site.

| Interface | Target | Discovery and execution |
| --- | --- | --- |
| TypeScript `@joomengine/joomla-mcp` | Core Joomla Web Services in the current workspace, including **Joomla only** | `joomla_tools` and `joomla_call` |
| Site's native MCP | The Joomla MCP package deployed with **JCB + MCP** | `native_tools` and `native_call` |
| Composer `joomengine/mcp-client` | A separately configured, reachable Joomla site with its native MCP package | `composer_tools` and `composer_call` |

## Joomla Web Services from Playground

`joomla_tools` returns the TypeScript server's current tool schemas. For example, call `joomla_call` with these arguments to list categories from the active site:

```json
{
  "name": "joomla_action_read",
  "arguments": {
    "action": "content.categories.list",
    "transport": "api"
  }
}
```

The bridge embeds the published TypeScript library and forwards its API actions through the selected runtime. A fresh agent-owned site can create its administrator's missing core API token using Joomla's user-token plugin. On an attached site, use an existing enabled Joomla token for the workspace administrator. Joomla's token plugins, API access permissions and MFA requirements apply. The token stays in the browser. Core updater operations require their own update token. Native OS console operations require a server-hosted Joomla installation.

For writes, use the upstream permission, plan, confirmation and read-back tools exposed by the provider. Keep the workspace open between planning and applying. Closing the workspace ends its TypeScript MCP session and invalidates that session's plans. [TypeScript server contracts](https://github.com/joomengine/joomla-mcp/blob/main/docs/USAGE.md)

## JCB and generated extension actions

Use the JCB + MCP recipe for native discovery of the site's published operations, and follow each returned input schema. JCB-built components can expose API actions after their generated webservices plugin is installed and enabled and the site catalogue is refreshed in **JoomEngine MCP → Operations → Refresh JCB definitions**. A native operating-system PHP worker job can be unavailable in WebAssembly. The Playground compiler uses the browser site's own administrator compiler flow. [Joomla and JCB discovery](https://github.com/joomengine/mcp_component/blob/main/docs/integrations/JCB.md) · [Playground skills](https://github.com/joomengine/skills/blob/main/testing/playground/README.md)

## Reach a separate native Joomla site over Composer stdio

Install the released PHP client with `composer require joomengine/mcp-client:^1.0`. From that Composer project's root, register an alias using the private credential prompt and configure the host:

```sh
read -r -p 'Joomla HTTPS site URL: ' joomla_site_url
read -r -s -p 'Joomla API token: ' JOOMENGINE_MCP_TOKEN
echo
export JOOMENGINE_MCP_TOKEN
./vendor/bin/joomengine-mcp configure production "$joomla_site_url"
unset JOOMENGINE_MCP_TOKEN
export JOOMENGINE_MCP_COMPOSER_BIN="$(realpath vendor/bin/joomengine-mcp)"
export JOOMENGINE_COMPOSER_SITE=production
```

On Windows specify the absolute path to Composer's generated launcher. Restart the Playground MCP host with these environment settings. `composer_tools` and `composer_call` now use the official client's `serve production` stdio connection. Follow pagination and returned schemas. The operator chooses the executable and alias at startup. The agent never supplies an executable or reads the site's token. [Composer client configuration](https://github.com/joomengine/mcp_client#readme)
