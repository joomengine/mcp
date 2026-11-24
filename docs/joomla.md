# Joomla and JCB connections

Open a Playground site with `workspace_open` or select a running client workspace with `workspace_attach`. The agent can use the following interfaces on the selected site.

| Interface | Target | Discovery and execution |
| --- | --- | --- |
| TypeScript `@joomengine/joomla-mcp` | Joomla Web Services on every deployment and JCB on sites exposing its Web Services routes | `joomla_tools` and `joomla_call` |
| Site's native MCP | The Joomla MCP package deployed with **JCB + MCP** | `native_tools` and `native_call` |
| Composer `joomengine/mcp-client` | A separately configured, reachable Joomla site with its native MCP package | `composer_tools` and `composer_call` |

## Discover provider capabilities

Select `joomla` for the embedded TypeScript provider, `native` for the installed Joomla site package, or `composer` for the configured remote site. Start with `provider_info({"provider":"native"})` to read that server's identity, instructions and negotiated capabilities. `provider_resources`, `provider_resource_templates` and `provider_prompts` list the provider's advertised entries. Follow each returned `nextCursor` on that same provider. Pass a discovered URI to `provider_resource` or a prompt name and its string arguments to `provider_prompt`. Resources retain their MIME type and text or base64 body. The bundled Skills remain available through `skills_read` even before connecting to a site.

Opening the native site MCP creates one session for discovery, grants, plans and execution. Closing or replacing the workspace ends this session. Each browser attachment has its own session. If the site expires a session or rotates its token, the interrupted call reports its HTTP error. The next call starts a new session. Read the affected records and acquire new grants or plans before applying further changes. The Composer bridge keeps its remote connection independent of the browser workspace.

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

The upstream compatibility workflow tests the exact current npm release of the Joomla provider in real Joomla and JCB deployments. Dependabot tracks the provider dependency and its lockfile through the normal PR checks.

The bridge embeds the published TypeScript library and forwards its API actions through the selected runtime. A fresh agent-owned site can create its administrator's missing core API token using Joomla's user-token plugin. On an attached site, use an existing enabled Joomla token for the workspace administrator. Joomla's token plugins, API access permissions and MFA requirements apply. The token stays in the browser. Core updater operations require their own update token. Native OS console operations require a server-hosted Joomla installation.

On a JCB-enabled site, use `joomla_call` with `joomla_actions_search` and `{"domain":"jcb"}` to discover the TypeScript provider's JCB operations. For example, `joomla_action_read` with `{"action":"jcb.api.joomla_components.list","transport":"api","input":{"limit":1}}` lists a component through Joomla Web Services. Use `jcb_compile` to run the installed compiler in Playground. For the commands provided by Joomla inside the browser, call `site_console` with `{"argv":["list"]}` and use `["help", commandName]` to inspect one. Commands run inside the selected Joomla application with its files and database. The standalone CLI companion and queued jobs that spawn native executables run on their configured native host. Browser compilation uses JCB’s built-in compiler form.

For writes, use the upstream permission, plan, confirmation and read-back tools exposed by the provider. Keep the workspace open between planning and applying. Closing the workspace ends its TypeScript MCP session and invalidates that session's plans. [TypeScript server contracts](https://github.com/joomengine/joomla-mcp/blob/main/docs/USAGE.md)

## JCB and generated extension actions

Use the JCB + MCP recipe for native discovery of the site's published operations, and follow each returned input schema. In Playground, install the extension and its generated webservices plugin, enable the plugin and call `jcb_refresh_tools` with the component element, such as `{"component":"com_demo"}`. The installed MCP registers its routes and synchronizes its catalogue for that component. On a native Joomla server, **JoomEngine MCP → Operations → Refresh JCB definitions** can also inventory native CLI commands. The Playground compiler uses the browser site's own administrator compiler flow. [Joomla and JCB discovery](https://github.com/joomengine/mcp_component/blob/main/docs/integrations/JCB.md) · [Playground skills](https://github.com/joomengine/skills/blob/main/testing/playground/README.md)

## Reach a separate native Joomla site over Composer stdio

Install the stable client with `composer require joomengine/mcp-client:^1.0.1`. The integration workflow installs this public Packagist package and exercises its stdio server against an HTTPS site. [Composer client on Packagist](https://packagist.org/packages/joomengine/mcp-client)

From the Composer project's root, register an alias using the private credential prompt and configure the host:

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
