# JoomEngine MCP

`@joomengine/mcp` lets an agent build and test Joomla extensions in JoomEngine Playground. The server supplies the JoomEngine Skills workflows, operates the active Joomla site and development tools, and delivers compiled installers and complete site archives.

| Workspace | Connection | Lifecycle |
| --- | --- | --- |
| Agent's own cloud browser | `workspace_open` launches an isolated Chromium instance on the MCP host | The default session is disposable. Set `JOOMENGINE_PROFILE_DIR` to keep saved sites across sessions. |
| Client's browser | `workspace_attach` connects to the designated running owner in Chromium or Firefox | The client and agent share the same live files and database. Detach leaves the site running. |
| JoomEngine Desktop | `workspace_attach` connects to the application's designated webview | The desktop profile retains its site. [Browser and desktop setup](docs/attach.md) |

## Install from npm

Use Node.js 22.16 or newer. In the directory where you run your MCP client, install the server and the Chromium build that matches its Playwright dependency. The browser installation is needed when the agent launches its own Playground. On Linux, add `--with-deps` to install any missing system libraries.

```sh
npm install @joomengine/mcp
npx --no-install playwright install chromium
npx --no-install joomengine-playground-mcp --help
```

For a client that supports `mcpServers`, the following configuration starts the published server over stdio:

```json
{
  "mcpServers": {
    "joomengine": {
      "command": "npx",
      "args": ["--yes", "@joomengine/mcp"]
    }
  }
}
```

A global installation with `npm install --global @joomengine/mcp` also exposes `joomengine-playground-mcp` on PATH. Use the client's environment settings for `JOOMENGINE_BROWSER_ENDPOINT` to attach to an existing browser or desktop and `JOOMENGINE_ARTIFACT_DIR` to exchange files. [npm package](https://www.npmjs.com/package/@joomengine/mcp)

## Work from source

```sh
git clone https://github.com/joomengine/mcp.git
cd mcp
npm ci
npm run skills
npm run build
npx --no-install playwright install chromium
mkdir -p artifacts
export JOOMENGINE_ARTIFACT_DIR="$PWD/artifacts"
node dist/cli.js
```

## Manage a workspace

`workspace_open` starts a deployment in the real Playground dashboard. For a previously saved profile, pass `{"idle":true}`, call `workspace_sites`, and supply a returned `storageKey` to `workspace_resume`. Opening with `{"savedSiteKey":"…"}` resumes a known site directly. A dedicated `JOOMENGINE_PROFILE_DIR` preserves files, database, settings and named backups between MCP processes. Closing an attached connection leaves the user's application running.

Use `workspace_stop`, `workspace_start` and `workspace_restart` for runtime management. Use `workspace_rename` or `workspace_delete` for saved sites. A reset deletes the selected site's data and launches the dashboard's default deployment. Pass the exact ID returned by `workspace_info` to reset. A separately exported complete-site backup can be restored later. The native owner checks pending forms and editor changes during transitions.

To change a running deployment or save, update and launch a recipe, use the [deployment tools](docs/deployment.md). For file changes, database inspection, PHP debugging, captured messages, storage recovery and backup management, see [Playground development tools](docs/platform.md).

## Find the right Skills and tools

Call `skills_capabilities` to see which operations are available on this MCP host and which canonical Skills guide each operation. Use `skills_search` to find examples and workflows by topic. MCP clients can read resources and select prompts directly. Tool-only clients can use `skills_list` and `skills_read`.

The npm package includes a full offline distribution. When Skills are used online, the installed server checks the canonical default branch, validates any newer snapshot and makes its resources and prompts available together. `skills_status` reports the active and bundled revisions and any synchronization error. Use `{"refresh":true}` to check immediately. [Skills synchronization and offline operation](docs/skills.md)

## Build a component

1. Read `joomengine://skills/SKILL.md` and the request-to-extension workflow, or select a build prompt through MCP.
2. Call `deployment_catalog` to inspect the available recipes and Joomla, JCB, and PHP releases. Call `workspace_open` with `{"deployId":"jcb-mcp"}` to start Joomla with JCB and the native MCP. Use `{"deployId":"blank"}` for Joomla only. Use `workspace_attach` when you want an existing site. Inspect the returned workspace identity before editing.
3. Discover the site's actions with `native_tools` and use `native_call` with the returned schemas. The maintained TypeScript implementation exposes Joomla Web Services via `joomla_tools` and `joomla_call`. The optional Composer bridge connects to its configured remote site. The site controls its grants and write confirmations. [Joomla connections](docs/joomla.md)
4. Author native JCB records, compile, install the resulting package, exercise its administrator and site pages, and verify any generated API. Browser tools can inspect and operate Joomla forms. Editor, database, PHP debugger, and mail tools operate on that workspace. [Compilation and verification](docs/jcb.md)
5. Save the installer and a complete site archive to the artifact directory, then restore the archive in a fresh workspace and read back the expected data. Wait for the result of each install, compile or restore before starting the next mutation. For a client with a short tool-call timeout, wrap a long-running tool in `operation_start` and poll `operation_status` on the same MCP connection. For example, start `{"tool":"jcb_compile","arguments":{"componentId":1,"joomlaMajor":6}}` with the actual component ID returned by `jcb_list_components`. If a start response is lost, call `operation_status` without an ID to find the existing operation. [Artifact transfer](docs/artifacts.md)

## Host options

| Variable | Purpose |
| --- | --- |
| `JOOMENGINE_CHROMIUM_PATH` | Use an existing compatible Chromium executable for an agent-owned browser. |
| `JOOMENGINE_PROFILE_DIR` | Absolute path to a dedicated, persistent Chromium profile for agent-owned sites. Use one MCP owner at a time. |
| `JOOMENGINE_HEADED=1` | Show the agent-owned Chromium window on a host with a display. |
| `JOOMENGINE_BROWSER_ENDPOINT` | Enable attachment to a specific loopback browser or desktop debugging endpoint. |
| `JOOMENGINE_PLAYGROUND_URL` | Select a trusted alternative Playground root. The default is `https://playground.joomengine.org/`. |
| `JOOMENGINE_ARTIFACT_DIR` | Existing host directory for binary import and export. |
| `JOOMENGINE_COMPOSER_SITE` | Enable the existing Composer client's stdio bridge for this configured site alias. |
| `JOOMENGINE_MCP_COMPOSER_BIN` | Absolute path to the Composer launcher when it is outside PATH. |
| `JOOMENGINE_SKILLS_CACHE` | Directory for verified canonical Skills snapshots shared by MCP sessions. |
| `JOOMENGINE_SKILLS_OFFLINE=1` | Use the last verified cached revision or the full npm-bundled fallback. |
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

## Publish a version

Run `npm version patch --no-git-tag-version` (or choose the intended minor or major increment) and merge `package.json` and `package-lock.json` into `main`. The **Publish npm release** workflow builds and tests the MCP, packages the current Skills revision and installs the tarball as a consumer. It records the source tag and exact tarball in a GitHub release, publishes to public npm with provenance, and verifies the registry integrity before making the GitHub release public. Stable releases use `latest` and prereleases use `next`. To resume the current version, run the same workflow from `main`. A retry uses the saved release tarball.

Configure npm trusted publishing for GitHub organization `joomengine`, repository `mcp`, workflow `publish-release.yml`, and environment `release`. For the first publication, the workflow can also use the `NPM_TOKEN` secret in the GitHub `release` environment with permission to publish under `@joomengine`. [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
