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
const LIST_CONSOLE_MESSAGES_TOOL_NAME = 'list_console_messages';

function formatLogpoint(logpoint: Logpoint): string {
  const location = `${logpoint.url ?? logpoint.urlRegex}:${logpoint.lineNumber}${
    logpoint.columnNumber === undefined ? '' : `:${logpoint.columnNumber}`
  }`;
  const status =
    logpoint.resolvedLocations > 0
      ? 'active'
      : 'pending (no matching script parsed yet)';
  return `Logpoint ${logpoint.id} at ${location} logging \`${logpoint.expression}\` [${status}]`;
}

export const setLogpoint = definePageTool({
  name: SET_LOGPOINT_TOOL_NAME,
  description: `Set a logpoint in a script of the currently selected page. A logpoint logs the value of one or more expressions to the console every time a line of code executes, without pausing execution and without modifying the source code. It works like logpoints in the Chrome DevTools Sources panel and replaces temporarily instrumenting code with console.log() calls. The logged output appears as regular console messages that can be read with ${LIST_CONSOLE_MESSAGES_TOOL_NAME}. Logpoints stay active across page reloads and navigations until they are removed or the page is closed.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    url: zod
      .string()
      .optional()
      .describe(
        'The full URL of the script to set the logpoint in. Specify either url or urlRegex, not both.',
      ),
    urlRegex: zod
      .string()
      .optional()
      .describe(
        'A regular expression matching the URL of the script(s) to set the logpoint in, for example "app\\.js$". Specify either url or urlRegex, not both.',
      ),
    lineNumber: zod
      .number()
      .int()
      .min(1)
      .describe(
        'The 1-based line number to log at. The logpoint fires whenever this line executes. If the line contains no executable code, the logpoint is moved to the next possible location.',
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
    if (logpoint.resolvedLocations === 0) {
      response.appendResponseLine(
        'No currently loaded script matches the logpoint location. The logpoint activates automatically when a matching script is parsed (for example, after a navigation). If you expected it to be active now, verify the url and lineNumber.',
      );
    }
    response.appendResponseLine(
      `Logged output appears in ${LIST_CONSOLE_MESSAGES_TOOL_NAME} once the line executes.`,
    );
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
