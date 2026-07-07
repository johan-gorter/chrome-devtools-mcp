/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {PageCollector, type ListenerMap} from './PageCollector.js';
import type {
  Browser,
  CDPSession,
  Frame,
  Page,
  Protocol,
} from './third_party/index.js';

/**
 * Number of messages retained per connection. When exceeded, the oldest
 * messages are dropped and counted in `droppedMessages`.
 */
export const MAX_MESSAGES_PER_CONNECTION = 500;

/**
 * Maximum stored payload length per message. Longer payloads are truncated
 * and marked as such; `payloadLength` keeps the original length.
 */
export const MAX_STORED_PAYLOAD_LENGTH = 10_000;

const TEXT_OPCODE = 1;
const BINARY_OPCODE = 2;

export interface WebSocketMessage {
  /** 1-based id, unique within the connection, stable across drops. */
  id: number;
  direction: 'sent' | 'received';
  /** 1 for text messages; 2 for binary messages (payload is base64). */
  opcode: number;
  payload: string;
  truncated: boolean;
  /** Length of the original payload (characters; base64 for binary). */
  payloadLength: number;
  receivedAt: Date;
}

export class WebSocketConnection {
  readonly url: string;
  status: 'open' | 'closed' = 'open';
  droppedMessages = 0;
  sentCount = 0;
  receivedCount = 0;
  #messages: WebSocketMessage[] = [];
  #nextMessageId = 1;

  constructor(url: string) {
    this.url = url;
  }

  addFrame(
    direction: 'sent' | 'received',
    frame: Protocol.Network.WebSocketFrame,
  ): void {
    // Only data frames are stored; control frames (ping/pong/close) are
    // protocol noise for debugging purposes.
    if (frame.opcode !== TEXT_OPCODE && frame.opcode !== BINARY_OPCODE) {
      return;
    }
    if (direction === 'sent') {
      this.sentCount++;
    } else {
      this.receivedCount++;
    }
    const truncated = frame.payloadData.length > MAX_STORED_PAYLOAD_LENGTH;
    this.#messages.push({
      id: this.#nextMessageId++,
      direction,
      opcode: frame.opcode,
      payload: truncated
        ? frame.payloadData.slice(0, MAX_STORED_PAYLOAD_LENGTH)
        : frame.payloadData,
      truncated,
      payloadLength: frame.payloadData.length,
      receivedAt: new Date(),
    });
    if (this.#messages.length > MAX_MESSAGES_PER_CONNECTION) {
      this.#messages.splice(
        0,
        this.#messages.length - MAX_MESSAGES_PER_CONNECTION,
      );
      this.droppedMessages =
        this.#nextMessageId - 1 - MAX_MESSAGES_PER_CONNECTION;
    }
  }

  getMessages(): WebSocketMessage[] {
    return this.#messages;
  }

  getMessage(id: number): WebSocketMessage | undefined {
    return this.#messages.find(message => message.id === id);
  }
}

/**
 * Collects WebSocket connections and their messages per page. Puppeteer
 * does not expose WebSocket frames, so the CDP Network events (which are
 * already enabled on the page session) are consumed directly.
 */
export class WebSocketCollector extends PageCollector<WebSocketConnection> {
  #subscribers = new WeakMap<Page, WebSocketPageSubscriber>();

  constructor(browser: Browser) {
    super(browser, collect => {
      return {
        webSocketCreated: (connection: WebSocketConnection) => {
          collect(connection);
        },
      } as ListenerMap;
    });
  }

  override addPage(page: Page): void {
    super.addPage(page);
    if (!this.#subscribers.has(page)) {
      const subscriber = new WebSocketPageSubscriber(page);
      this.#subscribers.set(page, subscriber);
      subscriber.subscribe();
    }
  }

  protected override cleanupPageDestroyed(page: Page): void {
    super.cleanupPageDestroyed(page);
    this.#subscribers.get(page)?.unsubscribe();
    this.#subscribers.delete(page);
  }
}

class WebSocketPageSubscriber {
  #page: Page;
  #session: CDPSession;
  #openConnections = new Map<Protocol.Network.RequestId, WebSocketConnection>();

  constructor(page: Page) {
    this.#page = page;
    // @ts-expect-error use existing CDP client (internal Puppeteer API).
    this.#session = this.#page._client() as CDPSession;
  }

  subscribe() {
    this.#session.on('Network.webSocketCreated', this.#onCreated);
    this.#session.on('Network.webSocketFrameSent', this.#onFrameSent);
    this.#session.on('Network.webSocketFrameReceived', this.#onFrameReceived);
    this.#session.on('Network.webSocketClosed', this.#onClosed);
    this.#page.on('framenavigated', this.#onFrameNavigated);
  }

  unsubscribe() {
    this.#session.off('Network.webSocketCreated', this.#onCreated);
    this.#session.off('Network.webSocketFrameSent', this.#onFrameSent);
    this.#session.off('Network.webSocketFrameReceived', this.#onFrameReceived);
    this.#session.off('Network.webSocketClosed', this.#onClosed);
    this.#page.off('framenavigated', this.#onFrameNavigated);
    this.#openConnections.clear();
  }

  #onCreated = (event: Protocol.Network.WebSocketCreatedEvent) => {
    const connection = new WebSocketConnection(event.url);
    this.#openConnections.set(event.requestId, connection);
    this.#page.emit('webSocketCreated', connection);
  };

  #onFrameSent = (event: Protocol.Network.WebSocketFrameSentEvent) => {
    this.#openConnections
      .get(event.requestId)
      ?.addFrame('sent', event.response);
  };

  #onFrameReceived = (event: Protocol.Network.WebSocketFrameReceivedEvent) => {
    this.#openConnections
      .get(event.requestId)
      ?.addFrame('received', event.response);
  };

  #onClosed = (event: Protocol.Network.WebSocketClosedEvent) => {
    const connection = this.#openConnections.get(event.requestId);
    if (connection) {
      connection.status = 'closed';
      this.#openConnections.delete(event.requestId);
    }
  };

  // Connections do not survive a main frame navigation, but the backend
  // does not reliably report them as closed.
  #onFrameNavigated = (frame: Frame) => {
    if (frame !== this.#page.mainFrame()) {
      return;
    }
    for (const connection of this.#openConnections.values()) {
      connection.status = 'closed';
    }
    this.#openConnections.clear();
  };
}
