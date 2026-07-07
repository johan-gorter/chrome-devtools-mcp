/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from './logger.js';
import type {CDPSession, Page, Protocol} from './third_party/index.js';

export interface LogpointOptions {
  url?: string;
  urlRegex?: string;
  lineNumber: number;
  columnNumber?: number;
  expression: string;
}

export interface Logpoint extends LogpointOptions {
  id: number;
  /**
   * Number of script locations the logpoint resolved to. 0 means the
   * logpoint is pending until a matching script is parsed.
   */
  resolvedLocations: number;
}

/**
 * Builds a breakpoint condition that logs the given expression and always
 * evaluates to a falsy value, so the debugger never pauses on it. This
 * mirrors how the Chrome DevTools front-end implements logpoints. Errors
 * thrown by the expression are reported to the console instead of being
 * silently swallowed.
 */
export function buildLogpointCondition(expression: string): string {
  return `(() => {
  try {
    console.log(${expression});
  } catch (logpointError) {
    console.error('Logpoint threw:', logpointError);
  }
  return false;
})()
//# sourceURL=debugger://logpoint`;
}

interface LogpointRecord {
  logpoint: Logpoint;
  breakpointId: Protocol.Debugger.BreakpointId;
}

/**
 * Manages logpoints for a single page using a dedicated CDP session.
 *
 * The session enables the Debugger domain lazily when the first logpoint is
 * set and instructs it to skip all pauses. Breakpoint conditions are still
 * evaluated while pauses are skipped, so logpoints keep logging, but this
 * session can never pause execution. In particular, "debugger;" statements
 * that become active once a Debugger domain is enabled do not hang the page,
 * and pauses triggered by other clients (such as an open DevTools window)
 * are not interfered with.
 *
 * The backend resets the skip flag when the page navigates, so it is
 * reapplied when the execution contexts are cleared. If a pause still slips
 * in before the flag is reapplied, the pause is resumed: this session
 * receives no pause events while the skip flag is active, so a pause event
 * always means the flag was lost.
 */
export class LogpointManager {
  #page: Page;
  #session?: CDPSession;
  #records = new Map<number, LogpointRecord>();
  #nextId = 1;

  constructor(page: Page) {
    this.#page = page;
  }

  async #ensureSession(): Promise<CDPSession> {
    if (this.#session) {
      return this.#session;
    }
    const session = await this.#page.createCDPSession();
    // Runtime is required for compileScript-based expression validation.
    await session.send('Runtime.enable');
    await session.send('Debugger.enable');
    await session.send('Debugger.setSkipAllPauses', {skip: true});
    this.#session = session;
    session.on('Debugger.breakpointResolved', this.#onBreakpointResolved);
    session.on('Runtime.executionContextsCleared', this.#applySkipAllPauses);
    session.on('Debugger.paused', this.#onPaused);
    return session;
  }

  #applySkipAllPauses = (): void => {
    void this.#session
      ?.send('Debugger.setSkipAllPauses', {skip: true})
      .catch(error => {
        logger?.('Failed to reapply setSkipAllPauses', error);
      });
  };

  #onPaused = (): void => {
    this.#applySkipAllPauses();
    void this.#session?.send('Debugger.resume').catch(error => {
      logger?.('Failed to resume after an unexpected pause', error);
    });
  };

  #onBreakpointResolved = (
    event: Protocol.Debugger.BreakpointResolvedEvent,
  ): void => {
    for (const record of this.#records.values()) {
      if (record.breakpointId === event.breakpointId) {
        record.logpoint.resolvedLocations++;
      }
    }
  };

  async setLogpoint(options: LogpointOptions): Promise<Logpoint> {
    for (const record of this.#records.values()) {
      const existing = record.logpoint;
      if (
        existing.url === options.url &&
        existing.urlRegex === options.urlRegex &&
        existing.lineNumber === options.lineNumber &&
        existing.columnNumber === options.columnNumber
      ) {
        throw new Error(
          `Logpoint ${existing.id} already exists at this location. Remove it first to change the logged expression.`,
        );
      }
    }

    const session = await this.#ensureSession();
    const condition = buildLogpointCondition(options.expression);

    // Validate the expression at set time so that mistakes surface
    // immediately instead of resulting in a logpoint that never logs.
    const compiled = await session.send('Runtime.compileScript', {
      expression: condition,
      sourceURL: 'logpoint-condition',
      persistScript: false,
    });
    if (compiled.exceptionDetails) {
      throw new Error(
        `The logpoint expression does not compile: ${compiled.exceptionDetails.text} Provide the expression like arguments to console.log(...).`,
      );
    }

    const result = await session.send('Debugger.setBreakpointByUrl', {
      url: options.url,
      urlRegex: options.urlRegex,
      // The tool API is 1-based like the DevTools UI; CDP is 0-based.
      lineNumber: options.lineNumber - 1,
      columnNumber:
        options.columnNumber === undefined
          ? undefined
          : options.columnNumber - 1,
      condition,
    });

    const logpoint: Logpoint = {
      ...options,
      id: this.#nextId++,
      resolvedLocations: result.locations.length,
    };
    this.#records.set(logpoint.id, {
      logpoint,
      breakpointId: result.breakpointId,
    });
    return logpoint;
  }

  async removeLogpoint(id?: number): Promise<Logpoint[]> {
    if (id === undefined) {
      const removed: Logpoint[] = [];
      for (const existingId of [...this.#records.keys()]) {
        removed.push(...(await this.removeLogpoint(existingId)));
      }
      return removed;
    }
    const record = this.#records.get(id);
    if (!record) {
      throw new Error(`No logpoint found with id ${id}.`);
    }
    const session = await this.#ensureSession();
    await session.send('Debugger.removeBreakpoint', {
      breakpointId: record.breakpointId,
    });
    this.#records.delete(id);
    return [record.logpoint];
  }

  getLogpoints(): Logpoint[] {
    return [...this.#records.values()].map(record => {
      return record.logpoint;
    });
  }

  dispose(): void {
    const session = this.#session;
    this.#session = undefined;
    this.#records.clear();
    if (session) {
      session.off('Debugger.breakpointResolved', this.#onBreakpointResolved);
      session.off('Runtime.executionContextsCleared', this.#applySkipAllPauses);
      session.off('Debugger.paused', this.#onPaused);
      // Detaching the session removes its breakpoints from the target.
      void session.detach().catch(error => {
        logger?.('Failed to detach logpoint CDP session', error);
      });
    }
  }
}
