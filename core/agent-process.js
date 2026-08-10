/**
 * Safe, bounded child-process primitives for subscription CLI runners.
 *
 * This module never invokes a shell. It owns the process limits and returns only stable
 * error codes; callers may log the code but must not persist raw provider diagnostics.
 */

import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';
import { accessSync, chmodSync, constants, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { delimiter, join, resolve } from 'node:path';

const execFile = promisify(nodeExecFile);
const DEFAULT_TERMINATION_GRACE_MS = 1000;
const DEFAULT_TERMINATION_KILL_GRACE_MS = 1000;

const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'TMP',
  'TEMP',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'LANG',
  'LC_ALL',
  'TZ',
];

export class AgentProcessError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'AgentProcessError';
    /** @type {string} */
    this.code = code;
    /** @type {string} */
    this.safeMessage = message;
  }
}

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {Record<string, string>}
 */
export function safeEnvironment(env = process.env) {
  /** @type {Record<string, string>} */
  const allowed = {};
  for (const key of ENV_ALLOWLIST) {
    const value = env[key];
    if (value !== undefined && value !== '') allowed[key] = String(value);
  }
  return allowed;
}

/**
 * @param {string} dataDir
 * @returns {string}
 */
export function createInvocationDirectory(dataDir) {
  const root = resolve(dataDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = join(root, `.hearsay-agent-${Math.random().toString(16).slice(2)}-${Date.now()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {
    // Windows uses user-scoped ACLs.
  }
  return directory;
}

/**
 * Resolve a configured CLI name or path to the executable that will actually be
 * invoked. Bare names are searched through the configured PATH; path aliases and
 * symlinks are canonicalised so capability probes and model requests use one stable
 * executable identity.
 *
 * @param {string} executable
 * @param {Record<string,string|undefined>} [env]
 * @returns {string}
 */
export function resolveExecutable(executable, env = process.env) {
  const requested = String(executable ?? '').trim();
  if (requested === '') throw new AgentProcessError('executable_missing', 'Subscription CLI executable was not configured');
  const hasPath = requested.includes('/') || requested.includes('\\');
  /** @type {string[]} */
  const candidates = hasPath
    ? [resolve(requested)]
    : String(env.PATH ?? env.Path ?? '')
      .split(delimiter)
      .filter((entry) => entry !== '')
      .map((entry) => join(entry, requested));
  if (candidates.length === 0) throw new AgentProcessError('executable_missing', 'Subscription CLI executable was not found');

  const extensions = process.platform === 'win32'
    ? String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const candidate of candidates) {
    const expanded = extensions.some((extension) => extension === '' || candidate.toLowerCase().endsWith(extension.toLowerCase()))
      ? [candidate]
      : extensions.map((extension) => `${candidate}${extension}`);
    for (const path of expanded) {
      try {
        accessSync(path, constants.X_OK);
        return realpathSync(path);
      } catch {
        // Continue searching PATH or PATHEXT candidates.
      }
    }
  }
  throw new AgentProcessError('executable_missing', 'Subscription CLI executable was not found');
}

/**
 * Terminate a process and its descendants. POSIX runners use a detached process group;
 * Windows receives the child kill and can be supplied a taskkill-aware implementation by
 * the caller/runner.
 *
 * @param {{pid?:number, kill?:(signal?:number|NodeJS.Signals)=>boolean}} child
 * @param {NodeJS.Signals|string} [signal]
 * @param {{platform?:string, taskkillImpl?:(executable:string,args:string[],options:Record<string,unknown>)=>unknown}} [options]
 * @returns {void}
 */
export function terminateProcessTree(child, signal = 'SIGTERM', options = {}) {
  const pid = Number(child.pid ?? 0);
  const platform = options.platform ?? process.platform;
  if (platform === 'win32' && pid > 0) {
    const taskkill = options.taskkillImpl ?? ((executable, args, spawnOptions) => nodeSpawn(executable, args, {
      ...spawnOptions,
      stdio: 'ignore',
    }));
    try {
      taskkill('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true });
    } catch {
      // Fall through to the direct child when taskkill is unavailable.
    }
  } else if (platform !== 'win32' && pid > 1) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall through to the direct child when the group is already gone or unavailable.
    }
  }
  try {
    child.kill?.(/** @type {NodeJS.Signals} */ (signal));
  } catch {
    // The process may have exited between the timeout and termination call.
  }
}

/**
 * @param {{exitCode?:number|null, signalCode?:string|null, once?:(event:string, listener:()=>void)=>unknown, on?:(event:string, listener:()=>void)=>unknown, removeListener?:(event:string, listener:()=>void)=>unknown}} child
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function waitForProcessClose(child, timeoutMs) {
  if ((child.exitCode !== undefined && child.exitCode !== null) || (child.signalCode !== undefined && child.signalCode !== null)) {
    return Promise.resolve(true);
  }
  const addListener = child.once ?? child.on;
  if (typeof addListener !== 'function') return Promise.resolve(false);
  return new Promise((resolvePromise) => {
    let settled = false;
    /** @param {boolean} closed */
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener?.('close', onClose);
      resolvePromise(closed);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
    addListener.call(child, 'close', onClose);
  });
}

/**
 * @param {{pid?:number, kill?:(signal?:number|NodeJS.Signals)=>boolean, exitCode?:number|null, signalCode?:string|null, once?:(event:string, listener:()=>void)=>unknown, on?:(event:string, listener:()=>void)=>unknown, removeListener?:(event:string, listener:()=>void)=>unknown}} child
 * @param {{platform?:string, taskkillImpl?:(executable:string,args:string[],options:Record<string,unknown>)=>unknown, terminationGraceMs?:number, terminationKillGraceMs?:number}} options
 * @returns {Promise<void>}
 */
async function terminateAndWait(child, options) {
  const termGrace = waitForProcessClose(child, options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS);
  terminateProcessTree(child, 'SIGTERM', options);
  if (await termGrace) return;
  const killGrace = waitForProcessClose(child, options.terminationKillGraceMs ?? DEFAULT_TERMINATION_KILL_GRACE_MS);
  terminateProcessTree(child, 'SIGKILL', options);
  await killGrace;
}

/**
 * @typedef {Object} SpawnOptions
 * @property {string} executable
 * @property {string[]} args
 * @property {string} input
 * @property {string} cwd
 * @property {Record<string,string>} env
 * @property {number} timeoutMs
 * @property {number} idleTimeoutMs
 * @property {number} maxOutputBytes
 * @property {AbortSignal} [signal]
 * @property {string} [cwd]
 * @property {((executable:string,args:string[],options:Record<string,unknown>)=>unknown)} [taskkillImpl]
 * @property {string} [platform]
 * @property {number} [terminationGraceMs]
 * @property {number} [terminationKillGraceMs]
 * @property {(executable:string,args:string[],options:Record<string,unknown>)=>import('node:child_process').ChildProcess} [spawnImpl]
 */

/**
 * @param {SpawnOptions} options
 * @returns {Promise<{stdout:string, stderr:string, exitCode:number, signal:string|null}>}
 */
export function spawnBounded(options) {
  if (options.signal?.aborted) return Promise.reject(new AgentProcessError('cancelled', 'Subscription CLI run cancelled'));
  const spawnImpl = options.spawnImpl ?? ((executable, args, spawnOptions) => nodeSpawn(
    executable,
    args,
    /** @type {import('node:child_process').SpawnOptions} */ (spawnOptions),
  ));
  /** @type {import('node:child_process').ChildProcess} */
  let child;
  try {
    child = spawnImpl(options.executable, options.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return Promise.reject(new AgentProcessError('process_start_failed', 'Unable to start subscription CLI'));
  }
  return new Promise((resolvePromise, reject) => {
    let stdout = '';
    let stderr = '';
    let totalBytes = 0;
    let settled = false;
    /** @type {Promise<void>|null} */
    let terminationPromise = null;
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let wallTimer;
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let idleTimer;
    const cleanup = () => {
      if (wallTimer) clearTimeout(wallTimer);
      if (idleTimer) clearTimeout(idleTimer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    /** @param {AgentProcessError} error */
    const fail = (error) => {
      if (settled || terminationPromise) return;
      cleanup();
      terminationPromise = terminateAndWait(child, options)
        .catch(() => {})
        .then(() => {
          settled = true;
          reject(error);
        });
    };
    const onAbort = () => fail(new AgentProcessError('cancelled', 'Subscription CLI run cancelled'));
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => fail(new AgentProcessError('timeout', 'Subscription CLI produced no output before idle timeout')), options.idleTimeoutMs);
    };
    /** @param {Buffer|string} chunk @param {'stdout'|'stderr'} target */
    const collect = (chunk, target) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      totalBytes += Buffer.byteLength(text);
      if (totalBytes > options.maxOutputBytes) {
        fail(new AgentProcessError('output_limit', 'Subscription CLI output exceeded the configured limit'));
        return;
      }
      if (target === 'stdout') stdout += text;
      else stderr += text;
      resetIdle();
    };
    child.on('error', () => fail(new AgentProcessError('process_start_failed', 'Unable to start subscription CLI')));
    child.stdout?.on('data', (chunk) => collect(chunk, 'stdout'));
    child.stderr?.on('data', (chunk) => collect(chunk, 'stderr'));
    child.on('close', (code, signal) => {
      if (settled || terminationPromise) return;
      settled = true;
      cleanup();
      if (code !== 0) {
        reject(new AgentProcessError('nonzero_exit', 'Subscription CLI exited unsuccessfully'));
        return;
      }
      resolvePromise({ stdout, stderr, exitCode: Number(code ?? 0), signal: signal ?? null });
    });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    wallTimer = setTimeout(() => fail(new AgentProcessError('timeout', 'Subscription CLI exceeded the wall-clock timeout')), options.timeoutMs);
    resetIdle();
    try {
      child.stdin?.end(options.input);
    } catch {
      fail(new AgentProcessError('process_start_failed', 'Unable to provide subscription CLI input'));
    }
  });
}

/**
 * @param {{executable:string, versionArgs?:string[], helpArgs?:string[], helpArgsList?:string[][], timeoutMs?:number,
 *   maxOutputBytes?:number, env?:Record<string,string|undefined>, cwd?:string, dataDir?:string,
 *   execFileImpl?:(executable:string,args:string[],options:Record<string,unknown>)=>Promise<{stdout:string,stderr:string}>,
 *   resolveExecutableImpl?:(executable:string,env:Record<string,string|undefined>)=>string}}
 *   options
 * @returns {Promise<{executable:string, version:string, help:string}>}
 */
export async function discoverCli(options) {
  const run = options.execFileImpl ?? execFile;
  const env = options.env ?? process.env;
  const resolveImpl = options.resolveExecutableImpl ?? resolveExecutable;
  const resolvedExecutable = resolveImpl(options.executable, env);
  const temporaryCwd = options.cwd === undefined ? createInvocationDirectory(options.dataDir ?? tmpdir()) : null;
  const common = {
    shell: false,
    env: safeEnvironment(env),
    cwd: options.cwd ?? temporaryCwd,
    timeout: options.timeoutMs ?? 10_000,
    maxBuffer: options.maxOutputBytes ?? 256 * 1024,
  };
  try {
    const versionResult = await run(resolvedExecutable, options.versionArgs ?? ['--version'], common);
    const helpArgLists = options.helpArgsList ?? [options.helpArgs ?? ['--help']];
    const helpResults = [];
    for (const helpArgs of helpArgLists) {
      helpResults.push(await run(resolvedExecutable, helpArgs, common));
    }
    return {
      executable: resolvedExecutable,
      version: `${versionResult.stdout ?? ''}`.trim().split(/\r?\n/)[0] ?? '',
      help: helpResults.map((result) => `${result.stdout ?? ''}\n${result.stderr ?? ''}`).join('\n'),
    };
  } catch (error) {
    if (error instanceof AgentProcessError) throw error;
    if (error && typeof error === 'object' && 'code' in error && String(error.code) === 'ENOENT') {
      throw new AgentProcessError('executable_missing', 'Subscription CLI executable was not found');
    }
    throw new AgentProcessError('process_start_failed', 'Subscription CLI capability probe failed');
  } finally {
    if (temporaryCwd !== null) rmSync(temporaryCwd, { recursive: true, force: true });
  }
}

/**
 * Probe subscription authentication without requesting a model turn. Output is inspected
 * only in memory and reduced to a boolean/kind pair; identity and credential paths never
 * leave this function.
 *
 * @param {{executable:string, args:string[], timeoutMs?:number, maxOutputBytes?:number,
 *   env?:Record<string,string|undefined>, cwd?:string, dataDir?:string,
 *   execFileImpl?:(executable:string,args:string[],options:Record<string,unknown>)=>Promise<{stdout:string,stderr:string}>}}
 *   options
 * @returns {Promise<{authenticated:boolean,authKind:string}>}
 */
export async function probeAuthentication(options) {
  const run = options.execFileImpl ?? execFile;
  const temporaryCwd = options.cwd === undefined ? createInvocationDirectory(options.dataDir ?? tmpdir()) : null;
  try {
    const result = await run(options.executable, options.args, {
      shell: false,
      env: safeEnvironment(options.env ?? process.env),
      cwd: options.cwd ?? temporaryCwd,
      timeout: options.timeoutMs ?? 10_000,
      maxBuffer: options.maxOutputBytes ?? 64 * 1024,
    });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (/not\s+(?:logged[ -]?in|authenticated)|logged[ -]?out|login required|authentication required|unauthenticated|expired|invalid (?:oauth|session|credentials?)|no active (?:oauth|subscription|session)|subscription unavailable/i.test(output)) {
      return { authenticated: false, authKind: 'unknown' };
    }
    const authenticated = /logged[ -]?in|authenticated|oauth|subscription|active session/i.test(output);
    return { authenticated, authKind: authenticated ? 'subscription' : 'unknown' };
  } catch {
    return { authenticated: false, authKind: 'unknown' };
  } finally {
    if (temporaryCwd !== null) rmSync(temporaryCwd, { recursive: true, force: true });
  }
}

/**
 * @param {{discovered:{executable:string,version:string,help:string}, requiredFlags:readonly string[],
 *   authProbe?:()=>Promise<{authenticated:boolean,authKind:string}>}} options
 * @returns {Promise<{authenticated:boolean,authKind:string}>}
 */
export async function preflightCli(options) {
  const missing = options.requiredFlags.filter((flag) => !options.discovered.help.includes(flag));
  if (missing.length > 0) throw new AgentProcessError('unsupported_cli_version', 'Subscription CLI does not expose the required restricted profile');
  if (!options.authProbe) throw new AgentProcessError('authentication_missing', 'Subscription CLI authentication is not available');
  const auth = await options.authProbe();
  if (!auth || auth.authenticated !== true) throw new AgentProcessError('authentication_missing', 'Subscription CLI authentication is not available');
  return { authenticated: true, authKind: String(auth.authKind ?? 'unknown') };
}
