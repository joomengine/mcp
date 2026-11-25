# Connect to an existing Playground

Run the MCP on the machine with the browser or JoomEngine Desktop. Open or resume the intended site in that application. Configure the MCP process with the local debugger address in `JOOMENGINE_BROWSER_ENDPOINT`, then call `workspace_list` and pass the intended owner’s `tabId` to `workspace_attach`. A cloud agent creating its own site uses `workspace_open` directly.

## Firefox

Quit Firefox after Playground shows **Saved locally**, then start the profile that owns the site with its WebDriver BiDi listener enabled.

```sh
firefox --remote-debugging-port 9222 https://playground.joomengine.org/
```

Set `JOOMENGINE_BROWSER_ENDPOINT=ws://127.0.0.1:9222/session` in the MCP host. Use a separate port if that Firefox session already has a WebDriver client. For macOS the Firefox executable is `/Applications/Firefox.app/Contents/MacOS/firefox`. [Mozilla connection instructions](https://developer.mozilla.org/en-US/docs/Web/WebDriver/How_to/Create_BiDi_connection)

## Chromium, Chrome or Edge

Use a persistent Playground profile, reopening the same directory between sessions. Chrome 136 and later require a non-default data directory for command-line remote debugging. To bring an existing site to that profile, download **Complete site** in the original browser and use **Upload** in the new profile.

```sh
google-chrome --user-data-dir="$HOME/.local/share/joomengine-agent-browser" \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
  https://playground.joomengine.org/
```

Set `JOOMENGINE_BROWSER_ENDPOINT=http://127.0.0.1:9222` in the MCP host. Use the installed Chromium or Edge executable in place of `google-chrome` when applicable. [Chrome debugging and profiles](https://developer.chrome.com/blog/remote-debugging-port)

## JoomEngine Desktop

Quit the app after **Saved locally**, then launch it with the debugging listener enabled. Open the same desktop profile and resume its site. All three platforms use `JOOMENGINE_BROWSER_ENDPOINT=http://127.0.0.1:9222`.

| Platform | Launch |
| --- | --- |
| Linux, native package | `QTWEBENGINE_REMOTE_DEBUGGING=127.0.0.1:9222 joomengine` |
| macOS, installed application | `QTWEBENGINE_REMOTE_DEBUGGING=127.0.0.1:9222 /Applications/JoomEngine.app/Contents/MacOS/JoomEngine` |
| Windows, extracted ZIP in PowerShell | Run the commands below from the folder containing JoomEngine.exe. |

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-address=127.0.0.1 --remote-debugging-port=9222"
Start-Process .\JoomEngine.exe
Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
```

The Linux and macOS builds expose the Qt WebEngine page debugger. The Windows build exposes WebView2's page debugger. The MCP selects the page serving the Playground shell and uses the same companion API as detached Playground windows. [Qt debugging](https://doc.qt.io/qt-6/qtwebengine-debugging.html) · [Microsoft WebView2 debugging](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/debug-visual-studio-code) · [Desktop profiles](https://github.com/joomengine/joomengine/blob/main/docs/using.md)

## Workspace identity and lifecycle

- `workspace_list` lists each owner tab’s title, available site name, storage key, deployment and preview status, including owners at the startup screen. The list works before and after attaching. `workspace_attach` selects the returned tab ID and reports the selected workspace’s identity and runtime state. In Firefox, a full page reload creates a new owner document ID. Refresh the list after a reload. Joomla previews, detached editor windows and unrelated tabs stay outside this list.
- `JOOMENGINE_PLAYGROUND_URL` selects a self-hosted Playground base URL. Include its installation path and trailing slash. HTTPS and local HTTP development hosts are supported.
- If Firefox reports that the selected owner document changed, close the attachment, list owners again, and attach with the intended tab ID. Read `workspace_info` and inspect any in-flight operation’s result in the site before repeating a write. A full document reload ends its old debugger handles on both Firefox and Chromium.
- `workspace_close` releases the companion connection. The owner tab, unsaved form drafts, PHP workers and profile remain with the client.
- To restore an exported complete site, call `site_restore` with its artifact ID. Pass the active `workspace_info.workspaceId` as `replaceWorkspaceId` to authorize replacing that exact site. The MCP verifies the owner again at its replacement prompt and selects Continue. With that argument omitted, the client chooses in the owner window. Separate prompts about unsaved edits remain under client control. A successful result contains the new workspace ID. After a cancellation, inspect `workspace_info` before submitting a different restore.
- `deployment_configure` sends PHP settings through the owner’s PHP controls. Changes to the site name, initial path, language, automatic login, multilingual options, extensions, startup commands, menus, content and overlays use the owner’s Configure Deployment → Apply flow. Close any unfinished deployment form before using this tool.
- Exit the browser or desktop application and launch normally to end its debug listener. Keep the listener on loopback. A client with access to a browser debugger has control of its browser profile.

## Operate the visible application

`browser_inspect`, `browser_click`, `browser_fill`, `browser_select`, `browser_check` and `browser_upload` address the current Joomla preview by default. Select `scope: "playground"` for the owner toolbar, deployment form, activity, settings and dialogs. Each inspection returns control references bound to its document. Inspect again after navigation. `framePath` accepts selectors or iframe references in order, for example to inspect the editable body inside a rich-text field. `browser_select` accepts a list of values for multiple selects. To submit a file, retain it with `artifact_load` or `file_export`, call `browser_upload` with its `artifactIds`, then submit the form using its normal controls.

| Surface | How to operate it |
| --- | --- |
| Joomla site or administrator | Use site-relative `browser_navigate` and the default site scope. Use `reload: true` to refresh a route. |
| Playground owner | Inspect and click `scope: "playground"`. React to the selected site's visible menus, language, theme, status, editors, dialogs and feedback. |
| JoomEngine Code | Open the Code button from the shell and use `scope: "code"`. Use the shell toolbar for opening Code's auxiliary panels. |
| Adminer | Open DB from the shell and use `scope: "database"`. SQL import accepts an artifact through the native file input. |
| Editor AI | Open the AI button in Code. Use `browser_screenshot`, `browser_pointer` and `browser_keyboard` with `scope: "ai"`. The provider login and conversation run inside the editor's isolated iframe. |
| Detached editor or DB | Use the owner layout's redock control to return an auxiliary editor to its dock. Its live files and database remain available through the workspace tools. |

Read ordinary editable form values with `browser_inspect` and `includeValues: true`. Use `browser_options` with a filter or offset for choices beyond the first inspection page. `browser_scroll` scrolls a visible surface using native wheel events. A click, pointer or keyboard action can receive `dialogResponses` for native browser alerts, confirms and prompts. Each response gives the exact dialog `type`, `message` and `accept` choice, plus optional prompt `text`. An unexpected dialog is dismissed and its message is returned so the agent can choose an explicit response. For an HTML dialog, inspect its controls and click the required button.

A screenshot returns a PNG image and its workspace artifact ID. Use `artifact_save` to deliver it or `artifact_release` after reading it. Pointer coordinates are CSS pixels relative to the visible surface. Click a control before sending keyboard input. Use `browser_keyboard` with `key` and `modifiers` for editor shortcuts. The pointer supports hover, double-click and drag as well as a single click. In the editor AI panel, connecting an account and sending project content follow the provider and permission choices made for that workspace.

## Verify a rendered extension

Call `browser_diagnostics` before navigating to an installed extension or exercising its controls. Call it again to read JavaScript exceptions and console warnings/errors from this Joomla site, along with resource names, load times, transfer sizes and HTTP status where the browser exposes it. Use `offset` and `limit` to page through resources. External resources are represented by their origin. Use `clear: true` to reset the collected messages between test cases. A fresh connection starts a new observation period.

## Verify an upstream Playground change

A pull request that depends on an open Playground PR can include a single line in its description beginning with `Depends on ` followed by the full GitHub URL of that PR. The browser attachment jobs verify the upstream run and artifact digest, serve the tested distribution on loopback, and run the complete scenario in Chromium and Firefox. They also open a JCB workspace on the public Playground, reconnect, and read back a saved file. Other PRs, main, and scheduled compatibility checks run the complete hosted scenario on production.
