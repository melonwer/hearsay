/**
 * Codex and Claude Code subscription runners.
 *
 * Both runners implement the same discover/preflight/run/cancel boundary. Provider
 * differences stop at argument profiles and event parsers; normalized output is suitable
 * for the common response-target coordinator.
 */

import { rmSync } from 'node:fs';

import {
  CLAUDE_SURFACE,
  CODEX_SURFACE,
  PROMPT_ENVELOPE_VERSION,
  buildMeasurementPrompt,
  claudeArgs,
  codexArgs,
  profileForSurface,
  profileHash,
} from './agent-profiles.js';
import {
  AgentProcessError,
  createInvocationDirectory,
  discoverCli,
  preflightCli,
  probeAuthentication,
  safeEnvironment,
  spawnBounded,
} from './agent-process.js';
import { parseClaudeStreamJsonl, parseCodexJsonl } from './agent-parsers.js';
import { createArtifactStore, writeArtifact } from './artifacts.js';
import { comparisonKey } from './subscription-model.js';

/**
 * @typedef {Object} AgentTarget
 * @property {number} responseId
 * @property {string} promptText
 * @property {'user_authored'|'suggested'|'imported'|'legacy'} promptOrigin
 * @property {string|null} [model]
 * @property {string} [locationControl]
 * @property {string} [languageControl]
 */

export class SubscriptionRunnerError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'SubscriptionRunnerError';
    /** @type {string} */
    this.code = code;
  }
}

/**
 * @typedef {Object} AgentRunnerOptions
 * @property {string} executable
 * @property {string} dataDir
 * @property {number} [timeoutMs]
 * @property {number} [idleTimeoutMs]
 * @property {number} [maxOutputBytes]
 * @property {string[][]} [helpArgsList]
 * @property {(options:Record<string, unknown>)=>Promise<{executable:string,version:string,help:string}>} [discoverImpl]
 * @property {(options:Record<string, unknown>)=>Promise<{authenticated:boolean,authKind:string}>} [preflightImpl]
 * @property {(options:Record<string, unknown>)=>Promise<{stdout:string,stderr:string,exitCode:number,signal:string|null}>} [spawnBoundedImpl]
 * @property {()=>Promise<{authenticated:boolean,authKind:string}>} [authProbe]
 */

export class SubscriptionAgentRunner {
  /** @param {AgentRunnerOptions & {surface:string, provider:string, parser:(input:string, options?:Record<string, unknown>)=>import('./agent-parsers.js').ParsedAgentOutput, args:(cwd:string)=>string[]}} options */
  constructor(options) {
    this.surface = options.surface;
    this.provider = options.provider;
    this.executable = options.executable;
    this.dataDir = options.dataDir;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 2 * 1024 * 1024;
    this.helpArgsList = options.helpArgsList;
    this.parser = options.parser;
    this.args = options.args;
    this.discoverImpl = options.discoverImpl ?? ((input) => discoverCli(/** @type {*} */ (input)));
    this.preflightImpl = options.preflightImpl ?? ((input) => preflightCli(/** @type {*} */ (input)));
    this.spawnBoundedImpl = options.spawnBoundedImpl ?? ((input) => spawnBounded(/** @type {*} */ (input)));
    this.authProbe = options.authProbe ?? (() => probeAuthentication({
      executable: this.executable,
      args: this.surface === CODEX_SURFACE ? ['login', 'status'] : ['auth', 'status'],
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
      dataDir: this.dataDir,
    }));
    this.artifactStore = createArtifactStore(this.dataDir);
    /** @type {{executable:string,version:string,help:string}|null} */
    this.discovered = null;
    /** @type {AbortController|null} */
    this.activeController = null;
  }

  /** @returns {Promise<{executable:string,version:string,help:string}>} */
  async discover() {
    if (this.discovered) return this.discovered;
    const result = await this.discoverImpl({
      executable: this.executable,
      dataDir: this.dataDir,
      timeoutMs: 10_000,
      maxOutputBytes: 256 * 1024,
      ...(this.helpArgsList ? { helpArgsList: this.helpArgsList } : {}),
    });
    this.executable = String(result.executable ?? this.executable);
    this.discovered = { ...result, executable: this.executable };
    return this.discovered;
  }

  /** @returns {Promise<{authenticated:boolean,authKind:string,cliVersion:string,cliExecutable:string}>} */
  async preflight() {
    const discovered = await this.discover();
    const profile = profileForSurface(this.surface);
    const result = await this.preflightImpl({
      discovered,
      requiredFlags: profile.requiredFlags,
      authProbe: this.authProbe,
    });
    return { ...result, cliVersion: discovered.version, cliExecutable: discovered.executable };
  }

  /**
   * @param {AgentTarget} target
   * @param {AbortSignal} [signal]
   * @returns {Promise<Record<string, unknown>>}
   */
  async run(target, signal) {
    const preflight = await this.preflight();
    const profile = profileForSurface(this.surface);
    const cwd = createInvocationDirectory(this.dataDir);
    const args = this.args(cwd);
    const normalizedArgs = args.map((value) => (value === cwd ? '<isolated-working-directory>' : value));
    const executionProfileHash = profileHash({
      surface: this.surface,
      version: profile.profileVersion,
      args: normalizedArgs,
    });
    const controller = new AbortController();
    this.activeController = controller;
    const forwardAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    try {
      const processResult = await this.spawnBoundedImpl({
        executable: this.executable,
        args,
        input: buildMeasurementPrompt(target.promptText),
        cwd,
        env: safeEnvironment(),
        timeoutMs: this.timeoutMs,
        idleTimeoutMs: this.idleTimeoutMs,
        maxOutputBytes: this.maxOutputBytes,
        signal: controller.signal,
      });
      let parsed;
      try {
        parsed = this.parser(processResult.stdout, {
          maxLineBytes: Math.min(this.maxOutputBytes, 256 * 1024),
          maxOutputBytes: this.maxOutputBytes,
          maxEvents: 10_000,
        });
      } catch {
        throw new SubscriptionRunnerError('event_parse_failed', 'Subscription CLI event stream could not be parsed');
      }
      const artifactRef = writeArtifact(this.artifactStore, target.responseId, parsed.rawEvents);
      const model = target.model === undefined ? null : target.model;
      return {
        surface: this.surface,
        provider: this.provider,
        label: profile.label,
        model,
        text: parsed.text,
        searchEvents: parsed.searchEvents,
        citations: parsed.citations,
        usage: parsed.usage,
        webStatus: parsed.webStatus,
        errorCode: parsed.errorCode,
        artifactRef,
        cliVersion: preflight.cliVersion,
        cliExecutable: preflight.cliExecutable,
        executionProfileHash,
        promptEnvelopeVersion: PROMPT_ENVELOPE_VERSION,
        promptTextSnapshot: target.promptText,
        promptOrigin: target.promptOrigin,
        locationControl: target.locationControl ?? 'uncontrolled',
        languageControl: target.languageControl ?? 'uncontrolled',
        comparisonKey: comparisonKey({
          surface: this.surface,
          model,
          promptEnvelopeVersion: PROMPT_ENVELOPE_VERSION,
          executionProfileHash,
          locationControl: target.locationControl ?? 'uncontrolled',
          languageControl: target.languageControl ?? 'uncontrolled',
        }),
        processStatus: 'completed',
      };
    } catch (error) {
      if (error instanceof AgentProcessError || error instanceof SubscriptionRunnerError) throw error;
      throw new SubscriptionRunnerError('process_start_failed', 'Subscription CLI run failed');
    } finally {
      signal?.removeEventListener('abort', forwardAbort);
      this.activeController = null;
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  /** @returns {void} */
  cancel() {
    this.activeController?.abort();
  }
}

export class CodexCliRunner extends SubscriptionAgentRunner {
  /** @param {Omit<AgentRunnerOptions, 'surface'|'provider'>} options */
  constructor(options) {
    super({
      ...options,
      surface: CODEX_SURFACE,
      provider: 'openai',
      parser: parseCodexJsonl,
      args: codexArgs,
      helpArgsList: [['--help'], ['exec', '--help']],
    });
  }
}

export class ClaudeCliRunner extends SubscriptionAgentRunner {
  /** @param {Omit<AgentRunnerOptions, 'surface'|'provider'>} options */
  constructor(options) {
    super({ ...options, surface: CLAUDE_SURFACE, provider: 'anthropic', parser: parseClaudeStreamJsonl, args: () => claudeArgs() });
  }
}
