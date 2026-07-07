/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {describe, it} from 'node:test';

import type {ParsedArguments} from '../../src/bin/chrome-devtools-mcp-cli-options.js';
import type {McpContext} from '../../src/McpContext.js';
import {McpResponse} from '../../src/McpResponse.js';
import {listConsoleMessages} from '../../src/tools/console.js';
import {
  listLogpoints,
  removeLogpoint,
  setLogpoint,
} from '../../src/tools/logpoints.js';
import {serverHooks} from '../server.js';
import {
  getTextContent,
  html,
  waitExecutionFor,
  withMcpContext,
} from '../utils.js';

const APP_SCRIPT = `function greet(name) {
  const message = 'Hello, ' + name;
  return message;
}
function withDebuggerStatement() {
  debugger;
  return 42;
}
`;

function serveAppScript(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
  res.statusCode = 200;
  res.end(APP_SCRIPT);
}

async function readConsoleMessages(context: McpContext): Promise<string> {
  const response = new McpResponse({} as ParsedArguments);
  response.setPage(context.getSelectedMcpPage());
  await listConsoleMessages().handler(
    {params: {}, page: context.getSelectedMcpPage()},
    response,
    context,
  );
  const formatted = await response.handle('test', context);
  return getTextContent(formatted.content[0]);
}

async function waitForConsoleText(
  context: McpContext,
  expected: string,
): Promise<void> {
  await waitExecutionFor(async () => {
    const text = await readConsoleMessages(context);
    if (!text.includes(expected)) {
      throw new Error(`Console messages do not include "${expected}" yet.`);
    }
  }, 5000);
}

function evaluateWithTimeout(
  page: ReturnType<McpContext['getSelectedPptrPage']>,
  expression: string,
): Promise<unknown> {
  return Promise.race([
    page.evaluate(expression),
    new Promise((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error('Evaluation timed out: the debugger paused the page'));
      }, 10_000);
    }),
  ]);
}

describe('logpoints', () => {
  const server = serverHooks();

  function setupRoutes() {
    server.addRoute('/app.js', serveAppScript);
    server.addHtmlRoute('/', html`<script src="/app.js"></script>`);
  }

  describe('set_logpoint', () => {
    it('logs the expression when the line executes', async () => {
      await withMcpContext(async (response, context) => {
        setupRoutes();
        const page = context.getSelectedPptrPage();
        await page.goto(server.getRoute('/'));

        await setLogpoint.handler(
          {
            params: {
              url: server.getRoute('/app.js'),
              lineNumber: 2,
              expression: `'greeting for', name`,
            },
            page: context.getSelectedMcpPage(),
          },
          response,
          context,
        );

        assert.ok(
          response.responseLines[0].includes('[active]'),
          `Expected an active logpoint, got: ${response.responseLines[0]}`,
        );

        await page.evaluate(`greet('World')`);
        await waitForConsoleText(context, 'greeting for World');
      });
    });

    it('supports urlRegex and activates when the script loads later', async () => {
      await withMcpContext(async (response, context) => {
        setupRoutes();
        const page = context.getSelectedPptrPage();

        await setLogpoint.handler(
          {
            params: {
              urlRegex: 'app\\.js$',
              lineNumber: 2,
              expression: `'set before load', name`,
            },
            page: context.getSelectedMcpPage(),
          },
          response,
          context,
        );

        assert.ok(
          response.responseLines[0].includes('[pending'),
          `Expected a pending logpoint, got: ${response.responseLines[0]}`,
        );

        await page.goto(server.getRoute('/'));
        await page.evaluate(`greet('Later')`);
        await waitForConsoleText(context, 'set before load Later');
      });
    });

    it('does not pause execution on debugger statements', async () => {
      await withMcpContext(async (response, context) => {
        setupRoutes();
        const page = context.getSelectedPptrPage();
        await page.goto(server.getRoute('/'));

        await setLogpoint.handler(
          {
            params: {
              url: server.getRoute('/app.js'),
              lineNumber: 2,
              expression: `'logpoint is set'`,
            },
            page: context.getSelectedMcpPage(),
          },
          response,
          context,
        );

        const result = await evaluateWithTimeout(
          page,
          `withDebuggerStatement()`,
        );
        assert.strictEqual(result, 42);
      });
    });

    it('does not pause on debugger statements after a navigation', async () => {
      await withMcpContext(async (response, context) => {
        setupRoutes();
        const page = context.getSelectedPptrPage();

        // Setting the logpoint before the navigation exercises that the
        // skip-all-pauses state survives navigations.
        await setLogpoint.handler(
          {
            params: {
              urlRegex: 'app\\.js$',
              lineNumber: 2,
              expression: `'logpoint is set'`,
            },
            page: context.getSelectedMcpPage(),
          },
          response,
          context,
        );

        await page.goto(server.getRoute('/'));
        const result = await evaluateWithTimeout(
          page,
          `withDebuggerStatement()`,
        );
        assert.strictEqual(result, 42);
      });
    });

    it('reports errors thrown by the expression to the console', async () => {
      await withMcpContext(async (response, context) => {
        setupRoutes();
        const page = context.getSelectedPptrPage();
        await page.goto(server.getRoute('/'));

        await setLogpoint.handler(
          {
            params: {
              url: server.getRoute('/app.js'),
              lineNumber: 2,
              expression: `notDefinedAnywhere.value`,
            },
            page: context.getSelectedMcpPage(),
          },
          response,
          context,
        );

        await page.evaluate(`greet('World')`);
        await waitForConsoleText(context, 'Logpoint threw:');
      });
    });

    it('rejects an expression that does not compile', async () => {
      await withMcpContext(async (response, context) => {
        setupRoutes();
        const page = context.getSelectedPptrPage();
        await page.goto(server.getRoute('/'));

        await assert.rejects(
          setLogpoint.handler(
            {
              params: {
                url: server.getRoute('/app.js'),
                lineNumber: 2,
                expression: `'unbalanced', (`,
              },
              page: context.getSelectedMcpPage(),
            },
            response,
            context,
          ),
          /does not compile/,
        );
      });
    });

    it('rejects when both or neither of url and urlRegex are provided', async () => {
      await withMcpContext(async (response, context) => {
        await assert.rejects(
          setLogpoint.handler(
            {
              params: {lineNumber: 1, expression: `'x'`},
              page: context.getSelectedMcpPage(),
            },
            response,
            context,
          ),
          /either "url" or "urlRegex"/,
        );
        await assert.rejects(
          setLogpoint.handler(
            {
              params: {
                url: 'http://example.com/a.js',
                urlRegex: 'a\\.js$',
                lineNumber: 1,
                expression: `'x'`,
              },
              page: context.getSelectedMcpPage(),
            },
            response,
            context,
          ),
          /either "url" or "urlRegex"/,
        );
      });
    });

    it('rejects a duplicate logpoint at the same location', async () => {
      await withMcpContext(async (response, context) => {
        setupRoutes();
        const page = context.getSelectedPptrPage();
        await page.goto(server.getRoute('/'));

        const params = {
          url: server.getRoute('/app.js'),
          lineNumber: 2,
          expression: `'first'`,
        };
        await setLogpoint.handler(
          {params, page: context.getSelectedMcpPage()},
          response,
          context,
        );
        await assert.rejects(
          setLogpoint.handler(
            {
              params: {...params, expression: `'second'`},
              page: context.getSelectedMcpPage(),
            },
            response,
            context,
          ),
          /already exists/,
        );
      });
    });
  });

  describe('remove_logpoint', () => {
    it('stops logging after removal', async () => {
      await withMcpContext(async (response, context) => {
        setupRoutes();
        const page = context.getSelectedPptrPage();
        await page.goto(server.getRoute('/'));

        await setLogpoint.handler(
          {
            params: {
              url: server.getRoute('/app.js'),
              lineNumber: 2,
              expression: `'before removal'`,
            },
            page: context.getSelectedMcpPage(),
          },
          response,
          context,
        );
        await page.evaluate(`greet('World')`);
        await waitForConsoleText(context, 'before removal');

        response.resetResponseLineForTesting();
        await removeLogpoint.handler(
          {params: {id: 1}, page: context.getSelectedMcpPage()},
          response,
          context,
        );
        assert.ok(response.responseLines[0].startsWith('Removed Logpoint 1'));

        await page.evaluate(`greet('World')`);
        await page.evaluate(`console.log('sentinel after removal')`);
        await waitForConsoleText(context, 'sentinel after removal');

        const text = await readConsoleMessages(context);
        const occurrences = text.split('before removal').length - 1;
        assert.strictEqual(
          occurrences,
          1,
          `Expected exactly one logged message, got ${occurrences}:\n${text}`,
        );
      });
    });

    it('removes all logpoints when no id is provided', async () => {
      await withMcpContext(async (response, context) => {
        setupRoutes();
        const page = context.getSelectedPptrPage();
        await page.goto(server.getRoute('/'));

        for (const lineNumber of [2, 3]) {
          await setLogpoint.handler(
            {
              params: {
                url: server.getRoute('/app.js'),
                lineNumber,
                expression: `'line ${lineNumber}'`,
              },
              page: context.getSelectedMcpPage(),
            },
            response,
            context,
          );
        }

        response.resetResponseLineForTesting();
        await listLogpoints.handler(
          {params: {}, page: context.getSelectedMcpPage()},
          response,
          context,
        );
        assert.strictEqual(response.responseLines.length, 2);

        response.resetResponseLineForTesting();
        await removeLogpoint.handler(
          {params: {}, page: context.getSelectedMcpPage()},
          response,
          context,
        );
        assert.strictEqual(response.responseLines.length, 2);

        response.resetResponseLineForTesting();
        await listLogpoints.handler(
          {params: {}, page: context.getSelectedMcpPage()},
          response,
          context,
        );
        assert.ok(response.responseLines[0].includes('No logpoints are set'));
      });
    });

    it('reports an error for an unknown id', async () => {
      await withMcpContext(async (response, context) => {
        await assert.rejects(
          removeLogpoint.handler(
            {params: {id: 99}, page: context.getSelectedMcpPage()},
            response,
            context,
          ),
          /No logpoint found with id 99/,
        );
      });
    });
  });
});
