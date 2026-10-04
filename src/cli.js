// sandbox — lxc-style front end for dev containers on rootless Podman.
import { readFileSync } from 'node:fs';
import { constants } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { SandboxError, checkName, cliPath, containerState, dc, folderOf, podman, sandboxDir } from './devcontainer.js';
import { applyTemplate, listTemplates, parseOptionArgs } from './templates.js';

const USAGE = `\
sandbox — lxc-style front end for dev containers on rootless Podman.

  sandbox new NAME --template TEMPLATE [--option KEY=VALUE ...]
                       create $SANDBOX_DIR/NAME from a template: a bundled
                       one's ID, or a path to a template folder (has a '/')
  sandbox templates    list the bundled templates and their options
  sandbox build NAME [--no-cache]
                       build NAME's image, showing the full log
  sandbox enter NAME   start NAME if needed and open a shell as $USER
  sandbox list         list dev containers
  sandbox stop NAME    stop NAME
  sandbox rm NAME      remove NAME (its home volume is kept)
  sandbox --version    show the version (and the Dev Containers CLI's)

NAME is resolved to a workspace folder via the container's
devcontainer.local_folder label, or else $SANDBOX_DIR/NAME.
SANDBOX_DIR defaults to ~/sandboxes.
`;

const commands = {
    new: cmdNew,
    templates: cmdTemplates,
    build: cmdBuild,
    enter: cmdEnter,
    list: cmdList,
    stop: cmdStop,
    rm: cmdRm,
};

export function main(argv) {
    const [cmd, ...args] = argv;
    if (cmd === '-h' || cmd === '--help' || cmd === 'help') {
        process.stdout.write(USAGE);
        return 0;
    }
    if (cmd === '-V' || cmd === '--version' || cmd === 'version') {
        console.log(versionLine());
        return 0;
    }
    if (!Object.hasOwn(commands, cmd ?? '')) {
        process.stderr.write(USAGE);
        return 2;
    }
    try {
        return commands[cmd](args) ?? 0;
    } catch (err) {
        if (err instanceof SandboxError || err.code?.startsWith('ERR_PARSE_ARGS')) {
            console.error(`sandbox: ${err.message}`);
            return 1;
        }
        throw err;
    }
}

/** "sandbox X.Y.Z (@devcontainers/cli A.B.C)", from the installed package.json files. */
export function versionLine() {
    const version = (path) => JSON.parse(readFileSync(path, 'utf8')).version;
    return `sandbox ${version(new URL('../package.json', import.meta.url))}`
        + ` (@devcontainers/cli ${version(join(dirname(cliPath()), 'package.json'))})`;
}

/** Exactly one NAME and nothing else. */
function oneName(args, usage) {
    if (args.length !== 1) throw new SandboxError(`usage: ${usage}`);
    return checkName(args[0]);
}

/** A child's exit status the way a shell reports it. */
function exitStatus(result) {
    return result.status ?? 128 + (constants.signals[result.signal] ?? 0);
}

function cmdNew(args) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            template: { type: 'string', short: 't' },
            option: { type: 'string', short: 'o', multiple: true },
        },
    });
    const usage = 'sandbox new NAME --template TEMPLATE [--option KEY=VALUE ...]';
    if (positionals.length !== 1 || !values.template) throw new SandboxError(`usage: ${usage}`);
    const name = checkName(positionals[0]);
    const dest = join(sandboxDir(), name);
    applyTemplate(values.template, dest, parseOptionArgs(values.option ?? []));
    console.log(`created ${dest} from template '${values.template}'`);
    console.log(`next: sandbox enter ${name}`);
}

function cmdTemplates(args) {
    if (args.length) throw new SandboxError('usage: sandbox templates');
    for (const t of listTemplates()) {
        console.log(`${t.id}\t${t.description ?? ''}`);
        for (const [key, opt] of Object.entries(t.options ?? {})) {
            const choices = opt.enum ? ` (${opt.enum.join('|')})` : '';
            console.log(`    --option ${key}=${opt.default ?? ''}${choices}  ${opt.description ?? ''}`);
        }
    }
}

function cmdBuild(args) {
    const [name, ...rest] = args;
    if (!name) throw new SandboxError('usage: sandbox build NAME [--no-cache]');
    const dir = folderOf(name);
    const result = dc('build', ['--workspace-folder', dir, ...rest]);
    if (result.status !== 0) return exitStatus(result);
    if (containerState(name)) {
        console.error(`sandbox: ${name} still runs the old image; use 'sandbox rm ${name}' then 'sandbox enter ${name}'`);
    }
}

function cmdEnter(args) {
    const name = oneName(args, 'sandbox enter NAME');
    const dir = folderOf(name);
    const state = containerState(name);
    if (state !== 'running') {
        // up creates the container, or starts it if it exists but is stopped.
        // Creating it may build the image first, which takes minutes: show that log
        // (on stderr). Restarting is quick, and its log only matters when it fails.
        const create = !state;
        console.error(`sandbox: ${create ? 'creating' : 'starting'} ${name} ...`);
        const up = dc('up', ['--workspace-folder', dir], create
            ? { stdio: ['ignore', 2, 2] }
            : { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        if (up.status !== 0) {
            if (!create) process.stderr.write(up.stdout + up.stderr);
            throw new SandboxError(`failed to start '${name}'`);
        }
    }
    // Node can't exec() in place: run the shell as a child and pass on its status.
    // Ignore Ctrl-C here so it only reaches the shell in the container.
    process.on('SIGINT', () => {});
    // "--" stops the CLI from parsing -l as its own option.
    return exitStatus(dc('exec', ['--workspace-folder', dir, '--', 'bash', '-l']));
}

function cmdList(args) {
    if (args.length) throw new SandboxError('usage: sandbox list');
    const result = podman(['ps', '-a', '--filter', 'label=devcontainer.local_folder', '--format',
        '{{.Names}}\t{{.State}}\t{{.Networks}}\t{{.Label "devcontainer.local_folder"}}']);
    if (result.status !== 0) throw new SandboxError(result.stderr.trim());
    const rows = [['NAME', 'STATE', 'NETWORK', 'FOLDER'],
        ...result.stdout.split('\n').filter(Boolean).map((line) => line.split('\t'))];
    console.log(table(rows));
}

function cmdStop(args) {
    const name = oneName(args, 'sandbox stop NAME');
    const result = podman(['stop', name]);
    if (result.status !== 0) throw new SandboxError(result.stderr.trim());
    console.log(`stopped ${name}`);
}

function cmdRm(args) {
    const name = oneName(args, 'sandbox rm NAME');
    const result = podman(['rm', '-f', name]);
    if (result.status !== 0) throw new SandboxError(result.stderr.trim());
    console.log(`removed ${name}`);
}

/** Left-aligned columns, two spaces apart. */
export function table(rows) {
    const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => (row[i] ?? '').length)));
    return rows.map((row) => row.map((cell, i) => (i < row.length - 1 ? cell.padEnd(widths[i]) : cell)).join('  '))
        .join('\n');
}
