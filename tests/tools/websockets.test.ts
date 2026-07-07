/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import type {McpContext} from '../../src/McpContext.js';
import type {McpResponse} from '../../src/McpResponse.js';
import {
  getWebSocketMessage,
  listWebSocketConnections,
  listWebSocketMessages,
} from '../../src/tools/websockets.js';
import {serverHooks} from '../server.js';
import {html, waitExecutionFor, withMcpContext} from '../utils.js';

describe('websockets', () => {
  const server = serverHooks();

  function setupRoutes() {
    server.addHtmlRoute('/', html`<h1>ws test</h1>`);
    server.addWebSocketEchoRoute('/ws');
  }

  function webSocketUrl(): string {
    return `${server.baseUrl.replace('http://', 'ws://')}/ws`;
  }

  async function openWebSocket(context: McpContext): Promise<void> {
    const page = context.getSelectedPptrPage();
    await page.goto(server.getRoute('/'));
    await page.evaluate(`new Promise((resolve, reject) => {
      const ws = new WebSocket('${webSocketUrl()}');
      window.__testWs = ws;
      ws.onopen = () => resolve('open');
      ws.onerror = () => reject(new Error('WebSocket failed to connect'));
    })`);
  }

  async function sendAndAwaitEcho(
    context: McpContext,
    text: string,
  ): Promise<unknown> {
    const page = context.getSelectedPptrPage();
    return await page.evaluate(`new Promise(resolve => {
      window.__testWs.onmessage = e => resolve(e.data);
      window.__testWs.send(${JSON.stringify(text)});
    })`);
  }

  async function callToolUntil(
    response: McpResponse,
    context: McpContext,
    call: () => Promise<void>,
    predicate: () => boolean,
  ): Promise<void> {
    await waitExecutionFor(async () => {
      response.resetResponseLineForTesting();
      await call();
      if (!predicate()) {
        throw new Error(
          `Tool response did not match yet:\n${response.responseLines.join('\n')}`,
        );
      }
    }, 5000);
  }

  it('captures sent and received messages', async () => {
    await withMcpContext(async (response, context) => {
      setupRoutes();
      await openWebSocket(context);
      const echo = await sendAndAwaitEcho(context, 'hello there');
      assert.strictEqual(echo, 'echo: hello there');

      await callToolUntil(
        response,
        context,
        () =>
          listWebSocketConnections.handler(
            {params: {}, page: context.getSelectedMcpPage()},
            response,
            context,
          ),
        () =>
          response.responseLines[0]?.includes('wsId=1') &&
          response.responseLines[0].includes('[open]') &&
          response.responseLines[0].includes('/ws') &&
          response.responseLines[0].includes('1 sent, 1 received'),
      );

      await callToolUntil(
        response,
        context,
        () =>
          listWebSocketMessages.handler(
            {params: {wsId: 1}, page: context.getSelectedMcpPage()},
            response,
            context,
          ),
        () => {
          const text = response.responseLines.join('\n');
          return (
            text.includes('#1 [sent') &&
            text.includes('hello there') &&
            text.includes('#2 [received') &&
            text.includes('echo: hello there')
          );
        },
      );
    });
  });

  it('filters messages by direction and text', async () => {
    await withMcpContext(async (response, context) => {
      setupRoutes();
      await openWebSocket(context);
      await sendAndAwaitEcho(context, 'alpha message');
      await sendAndAwaitEcho(context, 'beta message');

      await callToolUntil(
        response,
        context,
        () =>
          listWebSocketMessages.handler(
            {
              params: {wsId: 1, direction: 'sent', filter: 'alpha'},
              page: context.getSelectedMcpPage(),
            },
            response,
            context,
          ),
        () => {
          const text = response.responseLines.join('\n');
          return (
            text.includes('1 message(s)') &&
            text.includes('alpha message') &&
            !text.includes('beta') &&
            !text.includes('echo:')
          );
        },
      );
    });
  });

  it('truncates large payloads and returns the stored payload', async () => {
    await withMcpContext(async (response, context) => {
      setupRoutes();
      await openWebSocket(context);
      const bigPayload = 'x'.repeat(12_000);
      await sendAndAwaitEcho(context, bigPayload);

      await callToolUntil(
        response,
        context,
        () =>
          getWebSocketMessage.handler(
            {
              params: {wsId: 1, messageId: 1},
              page: context.getSelectedMcpPage(),
            },
            response,
            context,
          ),
        () =>
          response.responseLines[0]?.includes(
            'truncated from 12000 to 10000',
          ) === true,
      );
      const payloadLine = response.responseLines[2];
      assert.strictEqual(payloadLine, 'x'.repeat(10_000));
    });
  });

  it('drops old messages and marks closed connections', async () => {
    await withMcpContext(async (response, context) => {
      setupRoutes();
      await openWebSocket(context);
      const page = context.getSelectedPptrPage();
      // 520 round trips = 1040 messages; only the last 500 are retained.
      await page.evaluate(`new Promise(resolve => {
        let received = 0;
        window.__testWs.onmessage = () => {
          received++;
          if (received === 520) resolve(received);
        };
        for (let i = 0; i < 520; i++) {
          window.__testWs.send('bulk message ' + i);
        }
      })`);

      await callToolUntil(
        response,
        context,
        () =>
          listWebSocketConnections.handler(
            {params: {}, page: context.getSelectedMcpPage()},
            response,
            context,
          ),
        () =>
          response.responseLines[0]?.includes('520 sent, 520 received') ===
            true &&
          response.responseLines[0].includes('540 oldest messages dropped'),
      );

      await assert.rejects(
        getWebSocketMessage.handler(
          {params: {wsId: 1, messageId: 1}, page: context.getSelectedMcpPage()},
          response,
          context,
        ),
        /No message with id 1 is retained/,
      );

      await page.evaluate(`window.__testWs.close()`);
      await callToolUntil(
        response,
        context,
        () =>
          listWebSocketConnections.handler(
            {params: {}, page: context.getSelectedMcpPage()},
            response,
            context,
          ),
        () => response.responseLines[0]?.includes('[closed]') === true,
      );
    });
  });

  it('reports an error for an unknown connection', async () => {
    await withMcpContext(async (response, context) => {
      setupRoutes();
      const page = context.getSelectedPptrPage();
      await page.goto(server.getRoute('/'));
      await assert.rejects(
        listWebSocketMessages.handler(
          {params: {wsId: 42}, page: context.getSelectedMcpPage()},
          response,
          context,
        ),
        /No WebSocket connection with wsId=42/,
      );
    });
  });
});
