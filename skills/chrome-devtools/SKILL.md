---
name: chrome-devtools
description: Uses Chrome DevTools via MCP for efficient debugging, troubleshooting and browser automation. Use when debugging web pages, automating browser interactions, analyzing performance, or inspecting network requests. This skill does not apply to `--slim` mode (MCP configuration).
---

## Core Concepts

**Browser lifecycle**: Browser starts automatically on first tool call using a persistent Chrome profile. Configure via CLI args in the MCP server configuration: `npx chrome-devtools-mcp@latest --help`.
Addional tooling can be enabled by providing the following flags:

- For extension tooling, use the `--categoryExtensions` flag.
- For memory tooling, use the `--memoryDebugging` flag.

**Page selection**: Tools operate on the currently selected page. Use `list_pages` to see available pages, then `select_page` to switch context.
**Element interaction**: Use `take_snapshot` to get page structure with element `uid`s. Each element has a unique `uid` for interaction. If an element isn't found, take a fresh snapshot - the element may have been removed or the page changed.

## Workflow Patterns

### Before interacting with a page

1. Navigate: `navigate_page` or `new_page`
2. Wait: `wait_for` to ensure content is loaded if you know what you look for.
3. Snapshot: `take_snapshot` to understand page structure
4. Interact: Use element `uid`s from snapshot for `click`, `fill`, etc.

### Efficient data retrieval

- Use `filePath` parameter for large outputs (screenshots, snapshots, traces)
- Use pagination (`pageIdx`, `pageSize`) and filtering (`types`) to minimize data
- Set `includeSnapshot: false` on input actions unless you need updated page state

### Tool selection

- **Automation/interaction**: `take_snapshot` (text-based, faster, better for automation)
- **Visual inspection**: `take_screenshot` (when user needs to see visual state)
- **Additional details**: `evaluate_script` for data not in accessibility tree

### Debugging with logpoints

Prefer `set_logpoint` over editing source code to add temporary `console.log()` calls:

1. Locate: `list_scripts` with a `filter` shows the parsed scripts and which bundle contains a given original source file (via source maps).
2. Set: `set_logpoint` with the script `url` (or `urlRegex`), a 1-based `lineNumber` and an `expression` formatted like `console.log()` arguments (local variables are in scope). Original source files (e.g. `src/app.ts`) are resolved through source maps and re-resolved automatically after rebuilds.
3. Trigger: Interact with the page (or `evaluate_script`) so the line executes.
4. Read: `list_console_messages` shows the logged output.
5. Clean up: `remove_logpoint` when done; logpoints otherwise stay active across navigations until the page is closed.

### Inspecting WebSocket traffic

1. Connections: `list_websocket_connections` lists the WebSocket connections of the selected page with their `wsId`.
2. Messages: `list_websocket_messages` with a `wsId` lists sent/received payloads; narrow with `direction` and a payload `filter`.
3. Full payload: `get_websocket_message` returns one message in full (`filePath` saves it to a file).

Messages are recorded from the moment the page is inspected; reload the page to capture a connection from its start.

### Parallel execution

You can send multiple tool calls in parallel, but maintain correct order: navigate → wait → snapshot → interact.

### Testing an extension

> **Before proceeding**: Extension tools (`install_extension`, `list_extensions`, etc.) are only available when the MCP server is started with the `--categoryExtensions` flag. If these tools are not in your tool list, stop and ask the user to update their MCP server configuration:
>
> ```json
> {
>   "mcpServers": {
>     "chrome-devtools": {
>       "command": "npx",
>       "args": ["chrome-devtools-mcp@latest", "--categoryExtensions"]
>     }
>   }
> }
> ```
>
> After updating, the user must restart the MCP server (or their AI client) for the change to take effect.

1. **Install**: Use `install_extension` with the path to the unpacked extension.
2. **Identify**: Get the extension ID from the response or by calling `list_extensions`.
3. **Trigger Action**: Use `trigger_extension_action` to open the popup or side panel if applicable.
4. **Verify Service Worker**: Use `evaluate_script` with `serviceWorkerId` to check extension state or trigger background actions.
5. **Verify Page Behavior**: Navigate to a page where the extension operates and use `take_snapshot` to check if content scripts injected elements or modified the page correctly.

## Troubleshooting

If `chrome-devtools-mcp` is insufficient, guide users to use Chrome DevTools UI:

- https://developer.chrome.com/docs/devtools
- https://developer.chrome.com/docs/devtools/ai-assistance

If there are errors launching `chrome-devtools-mcp` or Chrome, refer to https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/troubleshooting.md.
