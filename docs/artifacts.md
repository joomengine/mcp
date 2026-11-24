# Deliver extension installers and portable sites

Set `JOOMENGINE_ARTIFACT_DIR` to an existing directory on the machine running the MCP process. Each filename addresses one file directly inside that directory. In an agent-owned cloud environment this is the agent's filesystem. A local MCP process can use a directory on the client's workstation.

1. After a successful compilation, pass the returned installer path to `file_export`. To deliver the entire site, call `site_export` with `{"format":"bundle"}`. Each result contains an artifact ID, filename, byte size and SHA-256.
2. Call `artifact_save` with the returned `id` and optionally a new `filename`. The implementation transfers binary chunks directly between the browser and the configured directory. It checks the byte count and SHA-256 before publishing the file. An existing destination is preserved.
3. To use a saved archive in another workspace, call `artifact_load` with its `filename` and `kind`. Choose `site` for a complete site ZIP, or `file` for a Joomla extension package. The returned ID belongs to the receiving workspace connection. Pass a site ID to `site_restore`. For an installer, pass the uploaded artifact to `extension_install` as documented by its tool schema.
4. When finished, `artifact_release` frees an artifact held in the browser. Sites and files already saved to the host directory remain available. For a client implementing its own download destination, `artifact_read` provides sequential base64 byte ranges using `nextOffset`, with the same size and SHA-256 verification contract.

Complete site archives carry the site's files, database and deployment configuration and can include credentials. Use `backup_save` when the desired destination is the current Playground profile's Backups panel. Transfer a stored backup to the host through `backup_export` and `artifact_save`.
