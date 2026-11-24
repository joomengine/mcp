# JoomEngine MCP

`@joomengine/mcp` connects an agent to a JoomEngine Playground workspace and the JoomEngine Skills workflows for building, testing and delivering Joomla extensions with Joomla Component Builder.

The project targets three workspaces: an isolated browser owned by the agent, a selected client browser session, and the workspace open in JoomEngine Desktop. The workspace owns its PHP runtime, MariaDB database and files. The active Joomla installation determines which extension APIs and MCP operations are available.

The maintained [TypeScript Joomla MCP](https://github.com/joomengine/joomla-mcp), the [Joomla-native MCP package](https://github.com/joomengine/mcp_package), and its [Composer stdio client](https://github.com/joomengine/mcp_client) provide the Joomla integrations. The [JoomEngine Skills](https://github.com/joomengine/skills) repository provides the authoring and verification workflows.
