// sandbox — lxc-style front end for dev containers on rootless Podman.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import {
    PACKAGE_VERSION, SandboxError, checkName, childEnv, cliPath, errnoCode, folderOf, packageVersion,
} from './devcontainer.js';
import {
    TRUSTED, ask, keepTrusted, riskSummary, short, stageConfig, writeEffective, yes,
} from './inplace.js';
import { checkExportable, exportedConfig } from './export.js';
import { table } from './inspect.js';
import { cmdNew } from './new.js';
import { listRemoved, listSandboxes, loadSandbox } from './sandbox.js';
import type { StagedConfig } from './inplace.js';
import type { Kind } from './state.js';
import { listTemplates } from './templates.js';
import { SETTINGS, readSettings, writeSettings } from './workspace.js';
import type { Settings } from './workspace.js';

const USAGE = `\
sandbox — lxc-style front end for dev containers on rootless Podman.

  sandbox new NAME --template TEMPLATE [--image IMAGE] [--option KEY=VALUE ...]
                       create $SANDBOX_DIR/NAME from a template: a bundled
                       one's ID, or a path to a template folder (has a '/').
                       --image: its base image, any Debian or Ubuntu based
                       image (claude, offline, proxy-client; default
                       debian:trixie-slim)
  sandbox new [NAME] --template TEMPLATE --workspace PATH [--image IMAGE]
              [--hide PATH ...] [--readonly PATH ...] [--option KEY=VALUE ...]
                       a sandbox around an existing folder: PATH is mounted at
                       its own path and is the working folder; the config stays
                       in $SANDBOX_DIR/NAME (NAME defaults to PATH's name).
                       Every git repo in PATH gets .git/hooks and .git/config
                       read-only. --hide (a file or folder, relative to PATH)
                       hides it inside: use it for secrets. --readonly makes
                       it read-only.
  sandbox new [NAME] --workspace PATH --inplace [--template TEMPLATE] [--yes]
              [--hide PATH ...] [--readonly PATH ...]
                       the config is PATH/.devcontainer (yours to commit), not
                       a copy of a template; with --template, that template is
                       written there first. It must be a sandbox config, and
                       you confirm it (--yes: without asking). sandbox keeps
                       the copy you trusted in $SANDBOX_DIR/NAME and runs only
                       that; PATH/.devcontainer is read-only inside
  sandbox new ... --vm any of the above, as a VM sandbox: sandbox enter makes
                       a VM (krun) instead of a container; refused when the
                       machine or the config can't (see docs/microvm.md)
  sandbox trust NAME [--yes]
                       show how an --inplace sandbox's project config changed,
                       and use it; until then, enter, exec and build refuse
  sandbox export NAME  write the config of NAME (made with --workspace PATH),
                       with your edits, into PATH/.devcontainer for you to
                       commit, without this machine's settings; NAME then
                       uses it, as with --inplace
  sandbox templates    list the bundled templates and their options
  sandbox build NAME [--no-cache]
                       build NAME's image, showing the full log
  sandbox enter NAME   start NAME if needed and open a shell as $USER; with
                       --workspace, first check every git repo is protected.
                       A VM sandbox: start its VM if needed, attach to its shell
  sandbox enter --vm [--from-existing] NAME
                       make NAME a VM sandbox: run it in a small KVM virtual
                       machine (krun) with its own kernel, and attach to its
                       shell (Ctrl-] detaches); made from NAME's container
                       (--from-existing: from the one that exists already).
                       NAME stays a VM sandbox, also after sandbox rm; see
                       docs/microvm.md
  sandbox enter --container NAME
                       make a VM sandbox, after sandbox rm, a container again
  sandbox exec NAME [--] COMMAND [ARG ...]
                       start NAME if needed and run COMMAND in it, like
                       'ssh host COMMAND': as $USER, in the workspace folder,
                       with a terminal only if you're at one; its exit status
                       (not for a VM sandbox)
  sandbox help [NAME]  this text; with NAME, what that sandbox offers (from its
                       template), e.g. sandbox help mitm-proxy
  sandbox inspect NAME the podman command that created NAME's container, as a
                       command line, and what it runs with: user, capabilities,
                       new privileges, seccomp, network, mounts; with warnings.
                       Without a container (after sandbox rm): what's left, its
                       config and the volumes it keeps, with their size. Of a
                       VM sandbox: its VM, then the container it was made from
  sandbox list [--removed]
                       list sandboxes, one row each (a VM sandbox's is its VM's;
                       COMMENT says vm); --removed: sandboxes in $SANDBOX_DIR
                       without a container, and their kept volumes
  sandbox stop [--force] NAME
                       stop NAME (a VM at once); --force also stops a container
                       sandbox didn't make
  sandbox rm [--force] NAME
                       remove NAME's container and VM (its home volume, config
                       folder and any --workspace folder are kept); --force as
                       for stop
  sandbox --version    show the version (and the Dev Containers CLI's)

Start with:  sandbox new work --template claude && sandbox enter work
Sandboxes live in $SANDBOX_DIR (default ~/sandboxes).
More: https://github.com/EddyPronk/podman-agent-sandbox#usage
`;

/** A command: its exit status, or nothing for 0. */
type Command = (args: string[]) => number | void;

const commands: { [name: string]: Command } = {
    new: cmdNew,
    trust: cmdTrust,
    export: cmdExport,
    templates: cmdTemplates,
    build: cmdBuild,
    enter: cmdEnter,
    exec: cmdExec,
    help: cmdHelp,
    inspect: cmdInspect,
    list: cmdList,
    stop: cmdStop,
    rm: cmdRm,
};

export function main(argv: string[]): number {
    const [cmd, ...args] = argv;
    if (cmd === '-h' || cmd === '--help' || (cmd === 'help' && args.length === 0)) {
        process.stdout.write(USAGE);
        return 0;
    }
    if (cmd === '-V' || cmd === '--version' || cmd === 'version') {
        console.log(versionLine());
        return 0;
    }
    const command = cmd !== undefined && Object.hasOwn(commands, cmd) ? commands[cmd] : undefined;
    if (!command) {
        process.stderr.write(USAGE);
        return 2;
    }
    try {
        return command(args) ?? 0;
    } catch (err) {
        if (err instanceof SandboxError || isParseArgsError(err)) {
            console.error(`sandbox: ${err.message}`);
            return 1;
        }
        throw err;
    }
}

/** An error parseArgs throws for a bad command line (an unknown option, say). */
function isParseArgsError(err: unknown): err is Error {
    return err instanceof Error && Boolean(errnoCode(err)?.startsWith('ERR_PARSE_ARGS'));
}

/** "sandbox X.Y.Z (@devcontainers/cli A.B.C)", from the installed package.json files. */
export function versionLine(): string {
    return `sandbox ${PACKAGE_VERSION} (@devcontainers/cli ${packageVersion(join(dirname(cliPath()), 'package.json'))})`;
}

/** Exactly one NAME and nothing else. */
function oneName(args: string[], usage: string): string {
    if (args.length !== 1) throw new SandboxError(`usage: ${usage}`);
    return checkName(args[0]);
}

function cmdTemplates(args: string[]): void {
    if (args.length) throw new SandboxError('usage: sandbox templates');
    for (const t of listTemplates()) {
        console.log(`${t.id}\t${t.description ?? ''}`);
        for (const [key, opt] of Object.entries(t.options ?? {})) {
            const flag = key === 'image' ? '--image ' : `--option ${key}=`;
            const choices = opt.enum ? ` (${opt.enum.join('|')})`
                : opt.proposals ? ` (e.g. ${opt.proposals.filter((p) => p !== opt.default).join(', ')})` : '';
            console.log(`    ${flag}${opt.default ?? ''}${choices}  ${opt.description ?? ''}`);
        }
    }
}

function cmdBuild(args: string[]): number {
    const [name, ...rest] = args;
    if (!name) throw new SandboxError('usage: sandbox build NAME [--no-cache]');
    return loadSandbox(name).build(rest);
}

function cmdEnter(args: string[]): number {
    const { values, positionals } = parseArgs({
        args, allowPositionals: true,
        options: { vm: { type: 'boolean' }, container: { type: 'boolean' }, 'from-existing': { type: 'boolean' } },
    });
    const usage = 'sandbox enter [--vm [--from-existing] | --container] NAME';
    const name = oneName(positionals, usage);
    if (values.vm && values.container) throw new SandboxError(`--vm or --container, not both; usage: ${usage}`);
    if (values['from-existing'] && !values.vm) throw new SandboxError(`--from-existing goes with --vm; usage: ${usage}`);
    const kind: Kind | null = values.vm ? 'vm' : values.container ? 'container' : null;
    return loadSandbox(name, { lock: true }).enter({ kind, fromExisting: Boolean(values['from-existing']) });
}

/**
 * sandbox exec NAME [--] CMD [ARG...]: like `ssh host CMD`, everything after NAME is the command,
 * run as the user in the workspace folder with the environment of `enter`.
 */
function cmdExec(args: string[]): number {
    const [name, ...rest] = args;
    const cmd = rest[0] === '--' ? rest.slice(1) : rest;
    if (!name || name.startsWith('-') || cmd.length === 0) {
        throw new SandboxError('usage: sandbox exec NAME [--] COMMAND [ARG ...]');
    }
    return loadSandbox(name, { lock: true }).exec(cmd);
}

/** sandbox help NAME: what helpText says for it. Works while the sandbox is stopped. */
function cmdHelp(args: string[]): void {
    const name = oneName(args, 'sandbox help [NAME]');
    process.stdout.write(helpText(name, folderOf(name)));
}

/**
 * The sandbox's .devcontainer/HELP: plain text from its template, read on the host and never run,
 * with ${localWorkspaceFolderBasename} and ${localWorkspaceFolder} replaced as in devcontainer.json.
 * Without one, what every sandbox offers.
 */
export function helpText(name: string, dir: string): string {
    let text: string;
    try {
        text = readFileSync(join(dir, '.devcontainer', 'HELP'), 'utf8');
    } catch (err) {
        if (errnoCode(err) !== 'ENOENT') throw err;
        return `${name}: its template has no help of its own. Every sandbox has:\n`
            + table([
                [`  sandbox enter ${name}`, 'a shell, as you, in the workspace'],
                [`  sandbox exec ${name} COMMAND`, 'run a command there'],
                [`  sandbox inspect ${name}`, 'how it runs: user, capabilities, network, mounts'],
            ])
            + `\nIts config is in ${join(dir, '.devcontainer')}.\n`;
    }
    return text.replaceAll('${localWorkspaceFolderBasename}', basename(dir))
        .replaceAll('${localWorkspaceFolder}', dir);
}

/**
 * sandbox trust NAME [--yes]: for an --inplace sandbox, show how the project's config changed since
 * it was trusted, and on yes, make that the trusted copy and the config that runs.
 */
function cmdTrust(args: string[]): number {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { yes: { type: 'boolean', short: 'y' } } });
    const name = oneName(positionals, 'sandbox trust NAME [--yes]');
    const sandbox = loadSandbox(name);
    const dir = sandbox.dir;
    const settings = readSettings(dir);
    if (!settings?.inplace) {
        throw new SandboxError(`${name} wasn't made with --inplace: its config is ${join(dir, '.devcontainer')}, `
            + 'not a project\'s, and there is nothing to trust');
    }
    const config = join(settings.workspace, '.devcontainer');
    const staged = stageConfig(settings.workspace);
    try {
        if (staged.id === settings.configTree) {
            console.log(`${name}: the project's config is unchanged (${short(staged.id)}); nothing to trust`);
            return 0;
        }
        console.error(`sandbox: ${name}: the project's config changed since you trusted it `
            + `(${short(settings.configTree)} -> ${short(staged.id)}):`);
        // -N: a new file is shown in full, not as "Only in ...": it may be code that runs at build.
        spawnSync('diff', ['-ruN', join(dir, TRUSTED), config], { stdio: ['ignore', 2, 2] });
        const host = riskSummary(staged.config, childEnv()).filter(([what]) => what === 'runs on your machine');
        if (host.length) console.error(`\nNote: ${host[0][0]}: ${host[0][1]}`);
        if (!values.yes) {
            const answer = ask(`Use the new config for ${name}? [y/N] `);
            if (answer === null) {
                throw new SandboxError('not at a terminal, so not asking: review the diff above, then run this again with --yes');
            }
            if (!yes(answer)) {
                console.error(`sandbox: not trusted; ${name} keeps refusing until you trust it or restore ${config}`);
                return 1;
            }
        }
        keepTrusted(dir, staged.root);
        const updated: Settings = { ...settings, configTree: staged.id };
        writeSettings(dir, updated);
        writeEffective(dir, updated);
    } finally {
        rmSync(staged.root, { recursive: true, force: true });
    }
    console.log(`${name}: now uses the project's config ${short(staged.id)}`);
    if (sandbox.made()) {
        console.error(`sandbox: ${name}'s container still runs with the old config; use 'sandbox rm ${name}' then 'sandbox enter ${name}'`);
    }
    return 0;
}

/**
 * sandbox export NAME: write NAME's config (made with --workspace) into its project as .devcontainer,
 * without this machine's settings (export.ts), check it as --inplace would, and make NAME use it.
 */
function cmdExport(args: string[]): void {
    const name = oneName(args, 'sandbox export NAME');
    const sandbox = loadSandbox(name);
    const dir = sandbox.dir;
    const settings = readSettings(dir);
    checkExportable(name, dir, settings);
    const { config, skip, removed, leftovers } = exportedConfig(dir, settings);
    const source = join(dir, '.devcontainer');
    const target = join(settings.workspace, '.devcontainer');
    const skipped = skip.map((file) => join(source, file));
    // All or nothing: writeEffective removes the config folder's .devcontainer (the config with the
    // user's edits) before it rebuilds it, and can fail after that (a .git file added to the project).
    // So keep a copy, and on any failure put it back and remove what was written: the project had no
    // .devcontainer before (checkExportable), nor the config folder a trusted copy (not --inplace).
    const backup = mkdtempSync(join(tmpdir(), 'sandbox-export-'));
    cpSync(source, join(backup, '.devcontainer'), { recursive: true, verbatimSymlinks: true });
    cpSync(join(dir, SETTINGS), join(backup, SETTINGS));
    let staged: StagedConfig | null = null;
    try {
        cpSync(source, target, { recursive: true, verbatimSymlinks: true, filter: (path) => !skipped.includes(path) });
        writeFileSync(join(target, 'devcontainer.json'), `${JSON.stringify(config, null, 2)}\n`);
        staged = stageConfig(settings.workspace);
        keepTrusted(dir, staged.root);
        const updated: Settings = { ...settings, inplace: true, configTree: staged.id };
        writeSettings(dir, updated);
        writeEffective(dir, updated);
    } catch (err) {
        const why = (e: unknown) => (e instanceof Error ? e.message : String(e));
        try {
            for (const path of [target, join(dir, TRUSTED), source]) rmSync(path, { recursive: true, force: true });
            cpSync(join(backup, '.devcontainer'), source, { recursive: true, verbatimSymlinks: true });
            cpSync(join(backup, SETTINGS), join(dir, SETTINGS));
        } catch (restoreErr) {
            throw new SandboxError(`export failed (${why(err)}), and so did putting things back (${why(restoreErr)}): `
                + `${name}'s config and sandbox.json as they were are in ${backup}`);
        }
        rmSync(backup, { recursive: true, force: true });
        throw new SandboxError(`export failed, so nothing changed (${name} and ${target} are as they were): ${why(err)}`);
    } finally {
        if (staged) rmSync(staged.root, { recursive: true, force: true });
    }
    rmSync(backup, { recursive: true, force: true });
    console.log(`wrote ${target} (${short(staged.id)}): ${name}'s config, with your edits, without this machine's settings`);
    for (const what of removed) console.log(`  left out: ${what}`);
    if (leftovers.length) {
        console.error(`sandbox: warning: it still names paths of this machine; edit them out before you commit:\n`
            + leftovers.map((line) => `  ${line}\n`).join(''));
    }
    console.log(`${name} now uses the project's config, as if made with --inplace: a change there needs 'sandbox trust ${name}'.`);
    if (sandbox.made()) {
        console.error(`sandbox: warning: ${name}'s container predates ${target}, which is writable inside it until `
            + `you make it again: sandbox rm ${name}, then sandbox enter ${name}`);
    }
    console.log(`Review and commit ${target}. For the project's README:\n`
        + '  To work in a sandbox (https://github.com/EddyPronk/podman-agent-sandbox):\n'
        + '      sandbox new --workspace . --inplace');
}

function cmdInspect(args: string[]): void {
    const name = oneName(args, 'sandbox inspect NAME');
    console.log(loadSandbox(name).describe());
}

function cmdList(args: string[]): void {
    const { values } = parseArgs({ args, options: { removed: { type: 'boolean' } } });
    console.log(values.removed ? listRemoved() : listSandboxes());
}

/** NAME and the options of `sandbox SUB [--force] NAME`. */
function forceAndName(args: string[], sub: string): { name: string; force: boolean } {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { force: { type: 'boolean' } } });
    return { name: oneName(positionals, `sandbox ${sub} [--force] NAME`), force: Boolean(values.force) };
}

function cmdStop(args: string[]): void {
    const { name, force } = forceAndName(args, 'stop');
    console.log(loadSandbox(name, { lock: true }).stop({ force }));
}

function cmdRm(args: string[]): void {
    const { name, force } = forceAndName(args, 'rm');
    console.log(loadSandbox(name, { lock: true }).remove({ force }));
}
