# Deployment recipes and running sites

The cloud browser, attached browser and JoomEngine Desktop use the deployment controller in the Playground that owns the site. Saved recipes belong to that browser or desktop profile. A recipe describes how to build a site. Backups preserve an existing site's files and database.

## Pick the deployment and inspect its fields

Call `deployment_catalog` to read language packages, built-in presets and installed/staged or downloadable Joomla, PHP and JCB versions. Each preset includes its supported Joomla majors, JCB requirements, description and link to its source manifest. Pass a `deployId` to read the entire built-in manifest, including version-specific variants, before opening the site. Call `deployment_schema` to get the complete portable document schema from the same Playground. Fetch a section by passing its name, including names used by local `$ref` references.

Open a recipe with `workspace_open`. On the running installation, `deployment_discover` returns available collection names and counts. Pass `section` and optional `offset` and `limit` to read templates, menus, menu item layouts or native configuration targets. A target from the installed site can describe Joomla core, JCB or another installed extension. For example, request the Content component's configuration form with:

```json
{"target":{"kind":"component","component":"com_content"}}
```

Call `deployment_capture` with a discovered target and the saved record ID, or select records in the Joomla administrator and omit the target. It returns the overlay, its native field schema, related overlays and any warnings about site-specific relationships. Include the related overlays along with the primary overlay in the deployment document. To preserve other overlay entries when editing a site, read the existing configuration first and merge them by key.

## Apply a change or start an independent site

Use `deployment_configure` to change the running site's name, startup path, automatic login, languages, extensions, CLI commands, menus, template, content or overlays. Pass just the top-level fields to change. Arrays supply the complete desired collection. For example:

```json
{"configuration":{"siteName":"Documentation","initialPath":"/administrator/"}}
```

Submit PHP settings or a compatible PHP version in a separate `deployment_configure` call. The owner restarts PHP and keeps its site configuration and preview in step. For example:

```json
{"configuration":{"phpSettings":{"max_input_vars":12000}}}
```

For a change of Joomla distribution, JCB version, administrator, or underlying recipe, create an independent deployment. Use `workspace_open` when starting an owner. In an active owner, `deployment_launch` accepts a `source` and the exact `replaceWorkspaceId` returned by `workspace_info`. The owner handles unsaved edits and site replacement as in the dashboard. Re-read `workspace_info` after launch. The new installation has its own workspace ID.

To preserve the live files and database in a second installation, call `deployment_clone` with the source `replaceWorkspaceId`. Supply optional configuration overrides for the copy, including a compatible JCB upgrade or changed sandbox administrator. Playground checkpoints the source and opens the copy under a new identity.

A source may name a `deployId`, provide a portable JSON `document`, import a public hosted `sourceURL`, or consume a `shareURL` from the same Playground. Add `configuration` overrides alongside the chosen source. The configured Playground resolves available packages and compatibility using its own catalog.

## Save, import, update and share

1. Call `deployment_export` to read the running deployment or provide a `source` to inspect a recipe. The default is public JSON. With `format: "share"`, the owner produces a shareable URL, with optional `immediate: true` for automatic launch. Use JSON for a recipe too large for a share link.
2. Call `deployment_recipe_save` with a unique `name` to save an independent copy. Omit `source` to use the running deployment. A `source.document` may be public v1 or full v2/v3. A full private export (`format: "private"`) can contain sandbox administrator credentials and private package configuration. The public export follows the Playground's public-document rules.
3. Call `deployment_recipes` to see names, IDs and revisions. Read a saved recipe using `deployment_export` with `{"source":{"deployId":"…"}}`. To rename, send its ID, current `expectedRevision`, new name and the same source to `deployment_recipe_save`. To update its contents, supply the revised source. Omit the ID and revision to create a distinct copy.
4. Call `deployment_recipe_delete` with an ID and its current `expectedRevision` to remove that recipe from the profile. If it changed since you read it, refresh the list before reconciling your changes.
