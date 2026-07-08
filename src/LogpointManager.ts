/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from './logger.js';
import type {
  CDPSession,
  DevTools,
  Page,
  Protocol,
} from './third_party/index.js';

export interface LogpointOptions {
  url?: string;
  urlRegex?: string;
  lineNumber: number;
  columnNumber?: number;
  expression: string;
}

/**
 * A location in a script as served to the browser. 1-based, like the
 * locations reported by the tools.
 */
export interface GeneratedLocation {
  url: string;
  lineNumber: number;
  columnNumber: number;
}

export interface Logpoint extends LogpointOptions {
  id: number;
  /**
   * Number of script locations the logpoint resolved to. 0 means the
   * logpoint is pending until a matching script is parsed.
   */
  resolvedLocations: number;
  /**
   * Set when url/urlRegex matched an original source file from a source
   * map instead of a script URL. The logpoint is then bound to this
   * generated location and re-bound whenever a source map containing the
   * original source is attached (for example after a reload with a
   * regenerated bundle).
   */
  generatedLocation?: GeneratedLocation;
}

export interface ScriptInfo {
  url: string;
  /** Whether the script references a source map. */
  hasSourceMap: boolean;
  /** Number of original sources in the source map, if it loaded. */
  sourceCount?: number;
  /** Original source URLs matching the list filter. */
  matchedSources: string[];
}

export type DebuggerModelProvider = () => DevTools.DebuggerModel | null;

type SdkScript = ReturnType<DevTools.DebuggerModel['scripts']>[number];
type SdkSourceMap = NonNullable<
  Awaited<
    ReturnType<
      ReturnType<
        DevTools.DebuggerModel['sourceMapManager']
      >['sourceMapForClientPromise']
    >
  >
>;

/**
 * The debugger model can retain scripts from before a navigation. Iterating
 * the newest script per URL first prevents resolving locations against a
 * stale script or source map.
 */
function newestScriptsFirst(model: DevTools.DebuggerModel): SdkScript[] {
  const byUrl = new Map<string, SdkScript>();
  for (const script of model.scripts()) {
    if (!script.sourceURL) {
      continue;
    }
    // Scripts are in parse order; the last one per URL is the newest.
    byUrl.set(script.sourceURL, script);
  }
  return [...byUrl.values()].reverse();
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

/**
 * Matches a source-map source URL (e.g. "webpack:///./src/app.ts") against
 * the url or urlRegex given by the user. A plain url matches when it equals
 * the source URL or a path suffix of it, so users can pass "app.ts" or
 * "src/app.ts" without knowing the bundler's URL scheme.
 */
function matchesAuthoredSource(
  sourceUrl: string,
  options: {url?: string; urlRegex?: string},
): boolean {
  if (options.urlRegex !== undefined) {
    try {
      return new RegExp(options.urlRegex).test(sourceUrl);
    } catch {
      return false;
    }
  }
  if (options.url === undefined) {
    return false;
  }
  return sourceUrl === options.url || sourceUrl.endsWith('/' + options.url);
}

/**
 * Lists the scripts currently parsed on a page based on the DevTools
 * debugger model, including the original sources from their source maps.
 * The filter is matched case-insensitively against both script URLs and
 * source-map source URLs.
 */
export async function listParsedScripts(
  model: DevTools.DebuggerModel,
  filter?: string,
): Promise<ScriptInfo[]> {
  const needle = filter?.toLowerCase();
  const byUrl = new Map<string, SdkScript>();
  for (const script of model.scripts()) {
    if (!script.sourceURL) {
      continue;
    }
    // Keep the last parsed script per URL.
    byUrl.set(script.sourceURL, script);
  }

  const result: ScriptInfo[] = [];
  for (const [url, script] of byUrl) {
    const hasSourceMap = Boolean(script.sourceMapURL);
    let sourceCount: number | undefined;
    const matchedSources: string[] = [];

    if (hasSourceMap) {
      const sourceMap = await model
        .sourceMapManager()
        .sourceMapForClientPromise(script);
      if (sourceMap) {
        const sources = sourceMap.sourceURLs();
        sourceCount = sources.length;
        if (needle) {
          for (const sourceUrl of sources) {
            if (sourceUrl.toLowerCase().includes(needle)) {
              matchedSources.push(sourceUrl);
            }
          }
        }
      }
    }

    if (
      !needle ||
      url.toLowerCase().includes(needle) ||
      matchedSources.length > 0
    ) {
      result.push({url, hasSourceMap, sourceCount, matchedSources});
    }
  }

  result.sort((a, b) => {
    return a.url.localeCompare(b.url);
  });
  return result;
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
 *
 * Logpoint locations that do not match any script URL are resolved through
 * the source maps of parsed scripts (via the page's DevTools debugger
 * model), so users can target original source files the same way the
 * DevTools Sources panel does. Such logpoints are re-bound whenever a
 * source map containing the original source attaches, which keeps them on
 * the intended source line across reloads with regenerated bundles.
 */
export class LogpointManager {
  #page: Page;
  #getDebuggerModel: DebuggerModelProvider;
  #session?: CDPSession;
  #records = new Map<number, LogpointRecord>();
  #nextId = 1;
  #sourceMapListener?: () => void;
  // Serializes re-binding work so that concurrent SourceMapAttached events
  // cannot interleave remove/set breakpoint calls for the same logpoint.
  #rebindChain = Promise.resolve();

  constructor(
    page: Page,
    getDebuggerModel: DebuggerModelProvider = () => null,
  ) {
    this.#page = page;
    this.#getDebuggerModel = getDebuggerModel;
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

    const directResult = await session.send('Debugger.setBreakpointByUrl', {
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
      resolvedLocations: directResult.locations.length,
    };
    let breakpointId = directResult.breakpointId;

    if (directResult.locations.length === 0) {
      // The location does not match any parsed script. Try to interpret it
      // as an original source location and resolve it via source maps.
      let mapped;
      try {
        mapped = await this.#resolveViaSourceMaps(options, condition);
      } catch (error) {
        await session
          .send('Debugger.removeBreakpoint', {breakpointId})
          .catch(removeError => {
            logger?.('Failed to remove placeholder breakpoint', removeError);
          });
        throw error;
      }
      if (mapped) {
        await session
          .send('Debugger.removeBreakpoint', {breakpointId})
          .catch(error => {
            logger?.('Failed to remove placeholder breakpoint', error);
          });
        breakpointId = mapped.breakpointId;
        logpoint.generatedLocation = mapped.generatedLocation;
        logpoint.resolvedLocations = mapped.resolvedLocations;
        this.#subscribeToSourceMaps();
      }
    }

    this.#records.set(logpoint.id, {logpoint, breakpointId});
    return logpoint;
  }

  /**
   * Searches the source maps of all parsed scripts for an original source
   * matching the requested location and sets a breakpoint at the mapped
   * generated location. Throws when the original source is found but the
   * line has no mapped code. Returns null when no source matches.
   */
  async #resolveViaSourceMaps(
    options: LogpointOptions,
    condition: string,
  ): Promise<{
    breakpointId: Protocol.Debugger.BreakpointId;
    generatedLocation: GeneratedLocation;
    resolvedLocations: number;
  } | null> {
    const target = await this.#findGeneratedLocation(options);
    if (!target) {
      return null;
    }
    const session = await this.#ensureSession();
    const result = await session.send('Debugger.setBreakpointByUrl', {
      url: target.url,
      lineNumber: target.lineNumber - 1,
      columnNumber: target.columnNumber - 1,
      condition,
    });
    return {
      breakpointId: result.breakpointId,
      generatedLocation: target,
      resolvedLocations: result.locations.length,
    };
  }

  /**
   * Maps an original source location to a generated location using the
   * source maps of the currently parsed scripts.
   */
  async #findGeneratedLocation(
    options: LogpointOptions,
  ): Promise<GeneratedLocation | null> {
    const model = this.#getDebuggerModel();
    if (!model) {
      return null;
    }
    let foundSourceIn: string | undefined;
    for (const script of newestScriptsFirst(model)) {
      if (!script.sourceMapURL) {
        continue;
      }
      const sourceMap = await model
        .sourceMapManager()
        .sourceMapForClientPromise(script);
      if (!sourceMap) {
        continue;
      }
      const location = this.#mapAuthoredLocation(script, sourceMap, options);
      if (location) {
        return location;
      }
      if (
        sourceMap
          .sourceURLs()
          .some(candidate => matchesAuthoredSource(candidate, options))
      ) {
        foundSourceIn = script.sourceURL;
      }
    }
    if (foundSourceIn) {
      throw new Error(
        `Found the source file in the source map of ${foundSourceIn}, but line ${options.lineNumber} has no mapped code (it may be a comment, type annotation or empty line). Pick a line containing executable code.`,
      );
    }
    return null;
  }

  /**
   * Maps an authored location to a generated location within one script
   * using its source map. Returns null when the map does not contain the
   * authored source or the line has no mapping.
   */
  #mapAuthoredLocation(
    script: SdkScript,
    sourceMap: SdkSourceMap,
    options: {
      url?: string;
      urlRegex?: string;
      lineNumber: number;
      columnNumber?: number;
    },
  ): GeneratedLocation | null {
    if (!script.sourceURL) {
      return null;
    }
    const sourceUrl = sourceMap
      .sourceURLs()
      .find(candidate => matchesAuthoredSource(candidate, options));
    if (!sourceUrl) {
      return null;
    }
    const entry = sourceMap.sourceLineMapping(
      sourceUrl,
      options.lineNumber - 1,
      (options.columnNumber ?? 1) - 1,
    );
    if (!entry) {
      return null;
    }
    return {
      url: script.sourceURL,
      lineNumber: entry.lineNumber + 1,
      columnNumber: entry.columnNumber + 1,
    };
  }

  /**
   * Re-binds source-mapped logpoints when a source map attaches, for
   * example after a reload served a regenerated bundle in which the
   * generated location of the original source line moved.
   */
  #subscribeToSourceMaps(): void {
    if (this.#sourceMapListener) {
      return;
    }
    const model = this.#getDebuggerModel();
    if (!model) {
      return;
    }
    const manager = model.sourceMapManager();
    const listener = (event: {
      data: {client: SdkScript; sourceMap?: SdkSourceMap};
    }) => {
      const {client, sourceMap} = event.data;
      if (!sourceMap) {
        return;
      }
      this.#rebindChain = this.#rebindChain.then(() => {
        return this.#rebindSourceMappedLogpoints(client, sourceMap).catch(
          error => {
            logger?.('Failed to rebind source-mapped logpoints', error);
          },
        );
      });
    };
    manager.addEventListener(
      'SourceMapAttached' as Parameters<typeof manager.addEventListener>[0],
      listener,
    );
    this.#sourceMapListener = () => {
      manager.removeEventListener(
        'SourceMapAttached' as Parameters<typeof manager.addEventListener>[0],
        listener,
      );
    };
  }

  async #rebindSourceMappedLogpoints(
    client: SdkScript,
    sourceMap: SdkSourceMap,
  ): Promise<void> {
    const session = this.#session;
    if (!session) {
      return;
    }
    for (const record of this.#records.values()) {
      const logpoint = record.logpoint;
      if (!logpoint.generatedLocation) {
        continue;
      }
      // Resolve against the newly attached source map only: the debugger
      // model may retain stale scripts from before a navigation.
      const target = this.#mapAuthoredLocation(client, sourceMap, logpoint);
      if (
        !target ||
        (target.url === logpoint.generatedLocation.url &&
          target.lineNumber === logpoint.generatedLocation.lineNumber &&
          target.columnNumber === logpoint.generatedLocation.columnNumber)
      ) {
        // Not in this source map or unchanged. An unchanged location is
        // still bound: breakpoints by URL re-attach to re-parsed scripts.
        continue;
      }
      await session
        .send('Debugger.removeBreakpoint', {breakpointId: record.breakpointId})
        .catch(error => {
          logger?.('Failed to remove stale logpoint breakpoint', error);
        });
      const result = await session.send('Debugger.setBreakpointByUrl', {
        url: target.url,
        lineNumber: target.lineNumber - 1,
        columnNumber: target.columnNumber - 1,
        condition: buildLogpointCondition(logpoint.expression),
      });
      record.breakpointId = result.breakpointId;
      logpoint.generatedLocation = target;
      logpoint.resolvedLocations = result.locations.length;
    }
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
    this.#sourceMapListener?.();
    this.#sourceMapListener = undefined;
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
