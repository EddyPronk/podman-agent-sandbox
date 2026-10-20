// Sandboxes whose config is the project's own .devcontainer (sandbox new --inplace). The project's
// files are only the source: $SANDBOX_DIR/NAME/trusted is the copy the user trusted, and
// $SANDBOX_DIR/NAME/.devcontainer the config that runs, made from it with this machine's settings. A
// change in the project has no effect until `sandbox trust NAME`; until then enter, exec and build
// refuse. The version of a config is git's tree id of its .devcontainer folder.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { SandboxError } from './devcontainer.js';
import { isObject, isString, isStringList, nullable } from './json.js';
import type { JsonObject } from './json.js';
import { SECCOMP_RUN_ARG, writeSeccompProfile } from './seccomp.js';
import type { SeccompOptions } from './seccomp.js';
import { MARKER, checkMinVersion, markerOf, seccompAllow } from './templates.js';
import {
    aroundWorkspace, configFile, findGitDirs, hiddenPaths, isInside, readConfig, workspaceMounts,
} from './workspace.js';
import type { DevcontainerConfig, Settings } from './workspace.js';

/**
 * The marker format this sandbox understands, and the policies it can check. no-vm: the config can't
 * run as a VM (sandbox enter --vm refuses it; vm.js).
 */
export const MARKER_VERSION = 1;
export const KNOWN_POLICIES = ['no-vm'];

/** In $SANDBOX_DIR/NAME: the trusted copy of the project's .devcontainer. */
export const TRUSTED = 'trusted';

/**
 * A project's devcontainer.json, with the fields riskSummary and writeEffective read checked
 * (checkFields). Null is unset, as the Dev Containers CLI reads it.
 */
export interface ProjectConfig extends DevcontainerConfig {
    capAdd?: string[] | null;
    securityOpt?: string[] | null;
    runArgs?: string[] | null;
    image?: string | null;
    mounts?: (string | JsonObject)[] | null;
    features?: JsonObject | null;
}

/** A line of riskSummary: what the config asks for, and the value it gives. */
export type RiskLine = [what: string, value: string];

/** stageConfig's result: ROOT/.devcontainer is the checked copy, ID its tree id. */
export interface StagedConfig {
    root: string;
    id: string;
    config: ProjectConfig;
}

/** What the tree id check found for an --inplace sandbox: see configChange. */
export interface ConfigChange {
    trusted: string | undefined;
    now: string;
    diff: string[];
}

/** git, with nothing from the environment that points it at another repository or config. */
function git(args: string[], env: NodeJS.ProcessEnv = {}, cwd?: string): string {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const result = spawnSync('git', args, {
        cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...clean, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...env },
    });
    if (result.error && 'code' in result.error && result.error.code === 'ENOENT') {
        throw new SandboxError('git not found on PATH: --inplace sandboxes need it to check the project\'s '
            + 'config (a prerequisite since 0.7.0)');
    }
    if (result.error) throw result.error;
    if (result.status !== 0) throw new SandboxError(`git ${args[0]} failed: ${result.stderr.trim()}`);
    return result.stdout.trim();
}

/**
 * Git's tree id of DIR/.devcontainer as it is on disk: committed or not, ignored files included. It
 * equals `git ls-tree HEAD .devcontainer` when that is clean. DIR needn't be a git repository: a
 * throwaway one does the work, so DIR's own git config and objects aren't read, nor the user's.
 * '' when DIR has no .devcontainer folder.
 */
export function configTree(dir: string): string {
    const folder = join(dir, '.devcontainer');
    if (!isFolder(folder)) return '';
    const tmp = mkdtempSync(join(tmpdir(), 'sandbox-tree-'));
    try {
        git(['init', '-q', '--bare', join(tmp, 'git')]);
        const env = { GIT_DIR: join(tmp, 'git'), GIT_WORK_TREE: dir };
        git(['add', '--force', '--all', '--', '.devcontainer'], env, dir);
        return git(['write-tree', '--prefix=.devcontainer/'], env, dir);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

function isFolder(path: string): boolean {
    try {
        return lstatSync(path).isDirectory();
    } catch {
        return false;
    }
}

/** Does PROJECT's devcontainer.json carry our marker? For hints only: false when it can't be read. */
export function hasMarker(project: string): boolean {
    try {
        return Boolean(markerOf(JSON.parse(readFileSync(configFile(project), 'utf8'))));
    } catch {
        return false;
    }
}

/** Refuse CONFIG (from FILE) unless it carries a marker this sandbox understands. */
export function checkMarker(config: DevcontainerConfig, file: string): void {
    const marker = markerOf(config);
    if (!marker) {
        throw new SandboxError(`${file} isn't a sandbox config (no "customizations": {"${MARKER}": …}); `
            + 'sandbox ignores it.\nMake a sandbox from a template around the project:  '
            + 'sandbox new --workspace PATH --template claude');
    }
    const { version } = marker;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
        throw new SandboxError(`${file}: "${MARKER}" needs a "version" (1)`);
    }
    if (version > MARKER_VERSION) {
        throw new SandboxError(`${file} is for a newer sandbox (its "${MARKER}" version is ${version}; `
            + `this sandbox knows ${MARKER_VERSION}): update sandbox`);
    }
    checkMinVersion(config, file);
    const policies = marker.policies ?? [];
    if (!Array.isArray(policies)) throw new SandboxError(`${file}: "${MARKER}".policies must be a list`);
    const unknown = policies.filter((p: unknown) => typeof p !== 'string' || !KNOWN_POLICIES.includes(p));
    if (unknown.length) {
        throw new SandboxError(`${file} requires ${unknown.length === 1 ? 'a policy' : 'policies'} this sandbox `
            + `can't check: ${unknown.join(', ')} (known: ${KNOWN_POLICIES.join(', ') || 'none yet'}). Update sandbox`);
    }
}

/**
 * Refuse CONFIG (from FILE) when a field riskSummary or writeEffective reads has the wrong type. The
 * project's config is untrusted: a field the Dev Containers CLI would refuse must not crash sandbox
 * before it shows what the config asks for.
 */
export function checkFields(config: DevcontainerConfig, file: string): asserts config is ProjectConfig {
    const wrong = (key: string, what: string) => new SandboxError(`${file}: "${key}" must be ${what}`);
    for (const key of ['capAdd', 'securityOpt', 'runArgs']) {
        if (!nullable(config[key], isStringList)) throw wrong(key, 'a list of strings');
    }
    if (!nullable(config.image, isString)) throw wrong('image', 'a string');
    if (!nullable(config.features, isObject)) throw wrong('features', 'an object (id: options)');
    if (!(config.mounts ?? []).every((m) => typeof m === 'string' || isObject(m))) {
        throw wrong('mounts', 'a list of strings and objects');
    }
    if (!nullable(markerOf(config)?.seccompAllow, isStringList)) throw wrong('seccompAllow', 'a list of system call names');
}

/**
 * Refuse a config in CONFIG_DIR (a .devcontainer folder) that isn't self-contained: the copy that
 * runs can only hold what's in the folder, and the tree id only covers that. PROJECT is the project's
 * folder. Symlinks are refused: the id covers a link, not what it points to.
 */
export function checkSelfContained(config: DevcontainerConfig, configDir: string, project: string): void {
    const where = (what: string) => `${join(project, '.devcontainer')}: ${what}`;
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isSymbolicLink()) throw new SandboxError(where(`${relative(configDir, path)} is a symlink`));
            if (entry.isDirectory()) walk(path);
        }
    };
    walk(configDir);
    const inside = (path: string) => isInside(resolve(configDir, path), configDir);
    const build = isObject(config.build) ? config.build : {};
    const paths: [string, unknown][] = [['build.context', build.context], ['build.dockerfile', build.dockerfile],
        ['dockerFile', config.dockerFile], ['context', config.context]];
    for (const [key, value] of paths) {
        if (typeof value === 'string' && !inside(value)) {
            throw new SandboxError(where(`${key} ${value} is outside .devcontainer`));
        }
    }
    if (config.dockerComposeFile) throw new SandboxError(where('dockerComposeFile isn\'t supported'));
    for (const id of Object.keys(isObject(config.features) ? config.features : {})) {
        if ((id.startsWith('./') || id.startsWith('../')) && !inside(id)) {
            throw new SandboxError(where(`the local Feature ${id} is outside .devcontainer`));
        }
    }
    for (const token of commandWords(config.initializeCommand)) {
        if ((isAbsolute(token) && isInside(token, project)) || token.split('/').includes('..')) {
            throw new SandboxError(where(`initializeCommand names ${token}, outside .devcontainer: it runs on `
                + 'your machine, and a change to that file wouldn\'t show in the config\'s diff'));
        }
    }
}

/** The words of a lifecycle command: a string, an array, or an object of either. */
function commandWords(command: unknown): string[] {
    if (!command) return [];
    if (typeof command === 'string') return command.split(/[\s;&|()<>"'`=]+/).filter(Boolean);
    if (Array.isArray(command)) return command.flatMap(commandWords);
    if (typeof command === 'object') return Object.values(command).flatMap(commandWords);
    return [];
}

/** A lifecycle command as one line. */
export function commandText(command: unknown): string {
    if (typeof command === 'string') return command;
    if (Array.isArray(command)) return command.join(' ');
    if (!isObject(command)) return '';
    return Object.entries(command).map(([key, value]) => `${key}: ${commandText(value)}`).join('; ');
}

const LIFECYCLE = ['onCreateCommand', 'updateContentCommand', 'postCreateCommand', 'postStartCommand',
    'postAttachCommand'];
const RISKY_ARGS = /^--(privileged|cap-add|device|security-opt|network|net|pid|ipc|userns|volume|mount|uts)\b|^-v$/;
// Of those, the ones that only take rights away, as the bundled templates use them: not risks.
const PROTECTIVE_ARGS = new Set(['--userns=keep-id', '--security-opt=no-new-privileges']);

/** A read-only bind mount of a path in the project (e.g. its own .devcontainer): protects, grants nothing. */
function readonlyProjectMount(text: string): boolean {
    const parts = text.split(',');
    return parts.includes('readonly') && parts.some((part) => part.startsWith('source=${localWorkspaceFolder}'));
}

/** TEXT with ${localEnv:NAME} and ${localEnv:NAME:DEFAULT} filled in from ENV, as the Dev Containers CLI does. */
export function resolveLocalEnv(text: string, env: NodeJS.ProcessEnv): string {
    return text.replace(/\$\{localEnv:([^}:]+)(?::([^}]*))?\}/g,
        (_, name: string, fallback: string | undefined) => env[name] ?? fallback ?? '');
}

/**
 * What a config asks for that matters when trusting it, most important first: what runs on the
 * host, then the container's rights, mounts, network, Features and commands inside. With ENV (the
 * environment sandbox runs the Dev Containers CLI with), ${localEnv:…} is shown as it will be.
 */
export function riskSummary(config: ProjectConfig, env: NodeJS.ProcessEnv | null = null): RiskLine[] {
    const lines = riskLines(config);
    return env ? lines.map(([what, value]) => [what, resolveLocalEnv(value, env)]) : lines;
}

function riskLines(config: ProjectConfig): RiskLine[] {
    const lines: RiskLine[] = [];
    if (config.initializeCommand) lines.push(['runs on your machine', commandText(config.initializeCommand)]);
    if (config.privileged) lines.push(['privileged', 'every capability and device']);
    for (const cap of config.capAdd ?? []) lines.push(['capability', cap]);
    for (const opt of config.securityOpt ?? []) lines.push(['security option', opt]);
    const allow = markerOf(config)?.seccompAllow;
    if (isStringList(allow) && allow.length) lines.push(['seccomp allows', allow.join(', ')]);
    const args = config.runArgs ?? [];
    args.forEach((arg, i) => {
        if (!RISKY_ARGS.test(arg) || PROTECTIVE_ARGS.has(arg)) return;
        const value = !arg.includes('=') && args[i + 1] && !args[i + 1].startsWith('-') ? ` ${args[i + 1]}` : '';
        lines.push(['runArgs', `${arg}${value}`]);
    });
    for (const mount of config.mounts ?? []) {
        const text = typeof mount === 'string' ? mount : JSON.stringify(mount);
        if (typeof mount === 'string' && readonlyProjectMount(mount)) continue;
        if (/(^|,)type=bind\b/.test(text) || (typeof mount === 'object' && mount.type === 'bind')) {
            lines.push(['host mount', text]);
        }
    }
    for (const id of Object.keys(config.features ?? {})) lines.push(['Feature', id]);
    if (config.image) lines.push(['image', config.image]);
    for (const key of LIFECYCLE) {
        if (config[key]) lines.push([`${key} (inside)`, commandText(config[key])]);
    }
    return lines;
}

/**
 * Copy PROJECT/.devcontainer to a new temporary folder, check it (plain JSON, the marker,
 * self-contained) and return { root, id, config }: ROOT/.devcontainer is the copy, ID its tree id.
 * The caller removes ROOT. Checking the copy means what was checked is what gets trusted.
 */
export function stageConfig(project: string): StagedConfig {
    const source = join(project, '.devcontainer');
    if (!isFolder(source)) throw new SandboxError(`${source} doesn't exist (or isn't a folder)`);
    const root = mkdtempSync(join(tmpdir(), 'sandbox-stage-'));
    try {
        cpSync(source, join(root, '.devcontainer'), { recursive: true, verbatimSymlinks: true });
        const file = configFile(root);
        if (!existsSync(file)) throw new SandboxError(`${configFile(project)} doesn't exist`);
        const config = readConfig(file);
        checkMarker(config, configFile(project));
        checkFields(config, configFile(project));
        checkSelfContained(config, join(root, '.devcontainer'), project);
        return { root, id: configTree(root), config };
    } catch (err) {
        rmSync(root, { recursive: true, force: true });
        throw err;
    }
}

/** Make DEST/trusted the copy in STAGED/.devcontainer. */
export function keepTrusted(dest: string, staged: string): void {
    rmSync(join(dest, TRUSTED), { recursive: true, force: true });
    cpSync(join(staged, '.devcontainer'), join(dest, TRUSTED), { recursive: true, verbatimSymlinks: true });
}

/**
 * The config that runs: DEST/.devcontainer, made again from DEST/trusted with this machine's
 * settings (SETTINGS from sandbox.json): the workspace at its own path, its git repos' hooks and
 * config, --hide/--readonly and the project's .devcontainer read-only, and the seccomp profile.
 * Made at every container creation, so a newer sandbox or host profile applies without a new trust.
 */
export function writeEffective(dest: string, settings: Settings, hooks: SeccompOptions = {}): void {
    const out = join(dest, '.devcontainer');
    rmSync(out, { recursive: true, force: true });
    cpSync(join(dest, TRUSTED), out, { recursive: true, verbatimSymlinks: true });
    const file = configFile(dest);
    const config = readConfig(file);
    checkFields(config, file);
    const allow = seccompAllow(dest);
    if (allow?.length) {
        writeSeccompProfile(dest, allow, hooks);
        const runArgs = config.runArgs ?? [];
        // Projects don't commit it (seccomp.js); a config that has it anyway keeps the one it names.
        if (!runArgs.some((arg) => arg.startsWith('--security-opt=seccomp='))) config.runArgs = [...runArgs, SECCOMP_RUN_ARG];
    }
    const { workspace } = settings;
    const hide = hiddenPaths(settings);
    const readonly = [...new Set([join(workspace, '.devcontainer'),
        ...(settings.readonly ?? []).map((path) => join(workspace, path))])];
    const mounts = workspaceMounts({ workspace, hide, readonly, configDir: dest, gitDirs: findGitDirs(workspace, hide) });
    writeFileSync(file, `${JSON.stringify(aroundWorkspace(config, workspace, mounts), null, 2)}\n`);
}

/** Refuse --hide of the project's .devcontainer (or a folder holding it): it must stay readable. */
export function checkNotHidden(workspace: string, hidden: string[]): void {
    const config = join(workspace, '.devcontainer');
    const bad = hidden.find((path) => isInside(config, path));
    if (bad) throw new SandboxError(`--inplace uses ${config}, so --hide ${relative(workspace, bad) || bad} can't hide it`);
}

/** What the tree id check found for an --inplace sandbox: null when the project's config is unchanged. */
export function configChange(dest: string, settings: Settings): ConfigChange | null {
    const now = configTree(settings.workspace);
    if (now === settings.configTree) return null;
    // -N: a new file (a Feature's install.sh, say) is shown in full, not as "Only in ...".
    return { trusted: settings.configTree, now, diff: ['diff', '-ruN', join(dest, TRUSTED), join(settings.workspace, '.devcontainer')] };
}

/** A short id for messages. */
export function short(id: string | undefined): string {
    return id ? id.slice(0, 7) : 'none';
}

/** Ask QUESTION at a terminal; null when not at one (stdin or stderr isn't a terminal). */
export function ask(question: string, { tty = process.stdin.isTTY && process.stderr.isTTY }: { tty?: boolean } = {}): string | null {
    if (!tty) return null;
    process.stderr.write(question);
    const buf = Buffer.alloc(1);
    let line = '';
    for (;;) {
        let n: number;
        try {
            n = readSync(0, buf, 0, 1, null);
        } catch (err) {
            if (err instanceof Error && 'code' in err && err.code === 'EAGAIN') continue;
            throw err;
        }
        if (n === 0 || buf[0] === 10) break;
        line += String.fromCharCode(buf[0]);
    }
    return line.trim().toLowerCase();
}

/** Yes, from an answer to a [y/N] question. */
export function yes(answer: string | null): boolean {
    return answer === 'y' || answer === 'yes';
}
