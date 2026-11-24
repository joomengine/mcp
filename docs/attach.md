# Connect to an existing Playground

Run the MCP on the machine with the browser or JoomEngine Desktop. Open or resume the intended site in that application. Configure the MCP process with the local debugger address in `JOOMENGINE_BROWSER_ENDPOINT`, then call `workspace_attach`. A cloud agent creating its own site uses `workspace_open` directly.

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

- `workspace_attach` returns the workspace ID, site name, runtime versions and persistence status. When multiple owner windows match, call it again with a returned `tabId`. The MCP excludes Joomla previews, detached editor windows and unrelated tabs.
- `JOOMENGINE_PLAYGROUND_URL` selects a self-hosted Playground base URL. Include its installation path and trailing slash. HTTPS and local HTTP development hosts are supported.
- `workspace_close` releases the companion connection. The owner tab, unsaved form drafts, PHP workers and profile remain with the client.
- To restore an exported complete site, call `site_restore` with its artifact ID. The owner displays its standard site replacement confirmation. A successful result contains the new workspace ID. After a cancellation, inspect `workspace_info` before submitting a different restore.
- `deployment_configure` sends PHP settings through the owner’s PHP controls. Changes to the site name, initial path, language, automatic login, multilingual options, extensions, startup commands, menus, content and overlays use the owner’s Configure Deployment → Apply flow. Close any unfinished deployment form before using this tool.
- Exit the browser or desktop application and launch normally to end its debug listener. Keep the listener on loopback. A client with access to a browser debugger has control of its browser profile.
