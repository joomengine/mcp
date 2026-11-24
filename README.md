# JoomEngine MCP

`@joomengine/mcp` lets an agent build and test Joomla extensions in JoomEngine Playground. The server supplies the JoomEngine Skills workflows, operates the active Joomla site and development tools, and delivers compiled installers and complete site archives.

| Workspace | Connection | Lifecycle |
| --- | --- | --- |
| Agent's own cloud browser | `workspace_open` launches an isolated Chromium instance on the MCP host | The agent selects a deployment and exports wanted work before closing. |
| Client's browser | `workspace_attach` connects to the designated running owner in Chromium or Firefox | The client and agent share the same live files and database. Detach leaves the site running. |
| JoomEngine Desktop | `workspace_attach` connects to the application's designated webview | The desktop profile retains its site. [Browser and desktop setup](docs/attach.md) |

## Start from this checkout

Node.js 22.16 or later, npm, Git, and a browser host with Playwright's Chromium dependencies are required for the cloud path. On Linux the Playwright install command can install system dependencies.

```sh
git clone https://github.com/joomengine/mcp.git
cd mcp
npm ci
npm run skills
npm run build
npx playwright install --with-deps chromium
mkdir -p artifacts
export JOOMENGINE_ARTIFACT_DIR="$PWD/artifacts"
node dist/cli.js
```

Before this branch is merged, check out `feature/playground-agent-workspaces` after cloning. The final command starts the stdio server. For an MCP client configuration, use `node` as the command and the absolute path printed by `realpath dist/cli.js` as its only argument. Pass `JOOMENGINE_ARTIFACT_DIR` through the MCP client's environment settings if the client starts from another shell. A prebuilt npm tarball is produced by the package verification workflow. After installing that archive, use the `joomengine-playground-mcp` executable.

## Build a component

1. Read `joomengine://skills/SKILL.md` and the request-to-extension workflow, or select a build prompt through MCP. Skills, supporting examples and tools are available offline in the package. Each build records the exact upstream revision in `skills/manifest.json`.
2. Call `workspace_open` with `{"deployId":"jcb-mcp"}` to start Joomla with JCB and the native MCP. Use `{"deployId":"blank"}` for Joomla only. Use `workspace_attach` when you want an existing site. Inspect the returned workspace identity before editing.
3. Discover the site's actions with `native_tools` and use `native_call` with the returned schemas. The maintained TypeScript implementation exposes Joomla Web Services via `joomla_tools` and `joomla_call`. The optional Composer bridge connects to its configured remote site. The site controls its grants and write confirmations. [Joomla connections](docs/joomla.md)
4. Author native JCB records, compile, install the resulting package, exercise its administrator and site pages, and verify any generated API. Browser tools can inspect and operate Joomla forms. Editor, database, PHP debugger, and mail tools operate on that workspace. [Compilation and verification](docs/jcb.md)
5. Save the installer and a complete site archive to the artifact directory, then restore the archive in a fresh workspace and read back the expected data. Wait for the result of each install, compile or restore before starting the next mutation. Configure extended client timeouts for these operations. [Artifact transfer](docs/artifacts.md)

## Host options

| Variable | Purpose |
| --- | --- |
| `JOOMENGINE_CHROMIUM_PATH` | Use an existing compatible Chromium executable for an agent-owned browser. |
| `JOOMENGINE_HEADED=1` | Show the agent-owned Chromium window on a host with a display. |
| `JOOMENGINE_BROWSER_ENDPOINT` | Enable attachment to a specific loopback browser or desktop debugging endpoint. |
| `JOOMENGINE_PLAYGROUND_URL` | Select a trusted alternative Playground root. The default is `https://playground.joomengine.org/`. |
| `JOOMENGINE_ARTIFACT_DIR` | Existing host directory for binary import and export. |
| `JOOMENGINE_COMPOSER_SITE` | Enable the existing Composer client's stdio bridge for this configured site alias. |
| `JOOMENGINE_MCP_COMPOSER_BIN` | Absolute path to the Composer launcher when it is outside PATH. |
| `JOOMENGINE_MCP_TOKEN` | Bearer credential for the optional Streamable HTTP listener. |

For a single operator using a Streamable HTTP client, set `JOOMENGINE_MCP_TOKEN` and start `node dist/cli.js --http --port 8787`. Connect to `http://127.0.0.1:8787/mcp` with the matching Bearer header. A cloud agent can run the server and browser together in its own environment. Each MCP session has its own active workspace. Runtime handles, artifact IDs, and client-browser attachments belong to the session that created them. Keep the debug endpoint private to the machine running the browser.

## Verify and package

```sh
npm run skills
npm run build
npm test
node test/cloud-live.mjs blank
node test/cloud-live.mjs jcb-mcp
node test/jcb-live.mjs
npm pack
```

The live checks use the hosted Playground and need network access. Prepack resolves the current canonical Skills revision and includes its full distribution and license. The Joomla providers retain their upstream licenses and release cycles. [Playground](https://github.com/joomengine/playground) · [JoomEngine Desktop](https://github.com/joomengine/joomengine) · [JoomEngine Skills](https://github.com/joomengine/skills)
