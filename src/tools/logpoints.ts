/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Logpoint} from '../LogpointManager.js';
import {zod} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {definePageTool} from './ToolDefinition.js';

const SET_LOGPOINT_TOOL_NAME = 'set_logpoint';
const LIST_LOGPOINTS_TOOL_NAME = 'list_logpoints';
const REMOVE_LOGPOINT_TOOL_NAME = 'remove_logpoint';
const LIST_SCRIPTS_TOOL_NAME = 'list_scripts';
const LIST_CONSOLE_MESSAGES_TOOL_NAME = 'list_console_messages';

function formatLogpoint(logpoint: Logpoint): string {
  const location = `${logpoint.url ?? logpoint.urlRegex}:${logpoint.lineNumber}${
    logpoint.columnNumber === undefined ? '' : `:${logpoint.columnNumber}`
  }`;
  const mapped = logpoint.generatedLocation
    ? ` (via source map at ${logpoint.generatedLocation.url}:${logpoint.generatedLocation.lineNumber}:${logpoint.generatedLocation.columnNumber})`
    : '';
  const status =
    logpoint.resolvedLocations > 0
      ? 'active'
      : 'pending (no matching script parsed yet)';
  return `Logpoint ${logpoint.id} at ${location}${mapped} logging \`${logpoint.expression}\` [${status}]`;
}

export const setLogpoint = definePageTool({
  name: SET_LOGPOINT_TOOL_NAME,
  description: `Set a logpoint in a script of the currently selected page. A logpoint logs the value of one or more expressions to the console every time a line of code executes, without pausing execution and without modifying the source code. It works like logpoints in the Chrome DevTools Sources panel and replaces temporarily instrumenting code with console.log() calls. The location may be given as the URL of a script as served to the browser, or as an original source file (for example a TypeScript file) which is resolved through the source maps of the parsed scripts and re-resolved automatically when a rebuilt bundle is loaded. Use ${LIST_SCRIPTS_TOOL_NAME} to inspect the available scripts and their original sources. The logged output appears as regular console messages that can be read with ${LIST_CONSOLE_MESSAGES_TOOL_NAME}. Logpoints stay active across page reloads and navigations until they are removed or the page is closed.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    url: zod
      .string()
      .optional()
      .describe(
        'The URL of the script to set the logpoint in, or the path of an original source file resolvable through source maps (suffix match, e.g. "src/app.ts" or "app.ts"). Specify either url or urlRegex, not both.',
      ),
    urlRegex: zod
      .string()
      .optional()
      .describe(
        'A regular expression matching the URL of the script(s) or source-map source to set the logpoint in, for example "app\\.js$". Specify either url or urlRegex, not both.',
      ),
    lineNumber: zod
      .number()
      .int()
      .min(1)
      .describe(
        'The 1-based line number to log at, in the coordinates of the given url (for original source files: the line in that source file). The logpoint fires whenever this line executes. If the line contains no executable code, the logpoint is moved to the next possible location.',
      ),
    columnNumber: zod
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Optional 1-based column number, useful for lines containing multiple statements (for example, in minified scripts).',
      ),
    expression: zod
      .string()
      .describe(
        `The expression(s) to log, formatted like the arguments of console.log(). Evaluated in the scope of the logpoint location, so local variables are accessible. Example: 'cart total:', cart.total, cart.items.length`,
      ),
  },
  blockedByDialog: false,
  verifyFilesSchema: [],
  handler: async (request, response) => {
    const {url, urlRegex, lineNumber, columnNumber, expression} =
      request.params;
    if ((url === undefined) === (urlRegex === undefined)) {
      throw new Error('Specify either "url" or "urlRegex", but not both.');
    }
    const logpoint = await request.page.setLogpoint({
      url,
      urlRegex,
      lineNumber,
      columnNumber,
      expression,
    });
    response.appendResponseLine(`${formatLogpoint(logpoint)}.`);
    if (logpoint.generatedLocation) {
      response.appendResponseLine(
        'The location was resolved through a source map and is re-resolved automatically when a matching source map loads again (for example after a reload with a regenerated bundle). Note: on the first page load after a rebuild, code that runs during the load itself is not logged yet; if a load-time logpoint stays silent right after a rebuild, reload once more before concluding that the line does not run.',
      );
    } else if (logpoint.resolvedLocations === 0) {
      response.appendResponseLine(
        `The location matches neither the URL of a parsed script nor an original source file in the source maps of parsed scripts. The logpoint activates only if a script with a matching URL is parsed later. Note that url/urlRegex match the URLs of scripts as served to the browser; original source files (for example TypeScript) resolve only through source maps. Use ${LIST_SCRIPTS_TOOL_NAME} to see the parsed scripts and their original sources.`,
      );
    }
    response.appendResponseLine(
      `Logged output appears in ${LIST_CONSOLE_MESSAGES_TOOL_NAME} once the line executes.`,
    );
  },
});

export const listScripts = definePageTool({
  name: LIST_SCRIPTS_TOOL_NAME,
  description: `List the scripts parsed by the currently selected page, including the original source files from their source maps. Useful to find the correct location for ${SET_LOGPOINT_TOOL_NAME}, for example which bundle contains a given original source file.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: true,
  },
  schema: {
    filter: zod
      .string()
      .optional()
      .describe(
        'Case-insensitive substring matched against script URLs and against the original source file paths from source maps. When omitted, all scripts are listed.',
      ),
    pageSize: zod
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Maximum number of scripts to return. When omitted, returns all scripts.',
      ),
    pageIdx: zod
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Page number to return (0-based). When omitted, returns the first page.',
      ),
  },
  blockedByDialog: false,
  verifyFilesSchema: [],
  handler: async (request, response) => {
    const {filter, pageSize, pageIdx} = request.params;
    const scripts = await request.page.listScripts(filter);
    if (!scripts.length) {
      response.appendResponseLine(
        filter
          ? `No parsed script or source-map source matches "${filter}".`
          : 'No scripts have been parsed on the selected page.',
      );
      return;
    }

    let shown = scripts;
    if (pageSize !== undefined) {
      const start = (pageIdx ?? 0) * pageSize;
      shown = scripts.slice(start, start + pageSize);
    }
    response.appendResponseLine(
      `${scripts.length} script(s)${filter ? ` matching "${filter}"` : ''}, showing ${shown.length}:`,
    );
    const maxSourcesShown = 10;
    for (const script of shown) {
      const sourceMapInfo = script.hasSourceMap
        ? script.sourceCount === undefined
          ? ' [has source map]'
          : ` [source map: ${script.sourceCount} original source(s)]`
        : '';
      response.appendResponseLine(`${script.url}${sourceMapInfo}`);
      for (const source of script.matchedSources.slice(0, maxSourcesShown)) {
        response.appendResponseLine(`  matching source: ${source}`);
      }
      if (script.matchedSources.length > maxSourcesShown) {
        response.appendResponseLine(
          `  ... and ${script.matchedSources.length - maxSourcesShown} more matching sources`,
        );
      }
    }
  },
});

export const listLogpoints = definePageTool({
  name: LIST_LOGPOINTS_TOOL_NAME,
  description: `List the logpoints that are currently set on the selected page. Logpoints are set with ${SET_LOGPOINT_TOOL_NAME}.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: true,
  },
  schema: {},
  blockedByDialog: false,
  verifyFilesSchema: [],
  handler: async (request, response) => {
    const logpoints = request.page.getLogpoints();
    if (!logpoints.length) {
      response.appendResponseLine(
        `No logpoints are set on the selected page. Use ${SET_LOGPOINT_TOOL_NAME} to set one.`,
      );
      return;
    }
    for (const logpoint of logpoints) {
      response.appendResponseLine(formatLogpoint(logpoint));
    }
  },
});

export const removeLogpoint = definePageTool({
  name: REMOVE_LOGPOINT_TOOL_NAME,
  description: `Remove a logpoint that was set with ${SET_LOGPOINT_TOOL_NAME} from the currently selected page.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    id: zod
      .number()
      .int()
      .optional()
      .describe(
        `The id of the logpoint to remove, as reported by ${SET_LOGPOINT_TOOL_NAME} or ${LIST_LOGPOINTS_TOOL_NAME}. When omitted, all logpoints on the page are removed.`,
      ),
  },
  blockedByDialog: false,
  verifyFilesSchema: [],
  handler: async (request, response) => {
    const removed = await request.page.removeLogpoint(request.params.id);
    if (!removed.length) {
      response.appendResponseLine('No logpoints to remove.');
      return;
    }
    for (const logpoint of removed) {
      response.appendResponseLine(`Removed ${formatLogpoint(logpoint)}.`);
    }
  },
});
