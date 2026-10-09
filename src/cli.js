// sandbox — lxc-style front end for dev containers on rootless Podman.
import { readFileSync, rmSync } from 'node:fs';
import { constants } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { SandboxError, checkName, cliPath, containerState, dc, folderOf, podman, sandboxDir } from './devcontainer.js';
import { audit, formatCommand, parseStatus } from './inspect.js';
import { applyTemplate, listTemplates, parseOptionArgs } from './templates.js';
import {
    applyWorkspace, defaultName, findGitDirs, readSettings, realConfigDir, resolveWorkspace, uncoveredInSandbox,
    workspaceMounts, workspacePath,
} from './workspace.js';

const USAGE = `\
sandbox — lxc-style front end for dev containers on rootless Podman.

  sandbox new NAME --template TEMPLATE [--option KEY=VALUE ...]
                       create $SANDBOX_DIR/NAME from a template: a bundled
                       one's ID, or a path to a template folder (has a '/')
  sandbox new [NAME] --template TEMPLATE --workspace PATH
              [--hide PATH ...] [--readonly PATH ...] [--option KEY=VALUE ...]
                       a sandbox around an existing folder: PATH is mounted at
                       its own path and is the working folder; the config stays
                       in $SANDBOX_DIR/NAME (NAME defaults to PATH's name).
                       Every git repo in PATH gets .git/hooks and .git/config
                       read-only. --hide (a file or folder, relative to PATH)
                       hides it inside: use it for secrets. --readonly makes
                       it read-only.
  sandbox templates    list the bundled templates and their options
  sandbox build NAME [--no-cache]
                       build NAME's image, showing the full log
  sandbox enter NAME   start NAME if needed and open a shell as $USER; with
                       --workspace, first check every git repo is protected
  sandbox inspect NAME the podman command that created NAME's container, as a
                       command line, and what it runs with: user, capabilities,
                       new privileges, seccomp, network, mounts; with warnings
  sandbox list         list dev containers
  sandbox stop NAME    stop NAME
  sandbox rm NAME      remove NAME's container (its home volume, config folder
                       and any --workspace folder are kept)
  sandbox --version    show the version (and the Dev Containers CLI's)

NAME is resolved to its folder (the config, and the workspace unless it was
made with --workspace) via the container's devcontainer.local_folder label,
or else $SANDBOX_DIR/NAME. SANDBOX_DIR defaults to ~/sandboxes.
`;

const commands = {
    new: cmdNew,
    templates: cmdTemplates,
    build: cmdBuild,
    enter: cmdEnter,
    inspect: cmdInspect,
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
            workspace: { type: 'string', short: 'w' },
            hide: { type: 'string', multiple: true },
            readonly: { type: 'string', multiple: true },
        },
    });
    const usage = 'sandbox new NAME --template TEMPLATE [--option KEY=VALUE ...]\n'
        + '       sandbox new [NAME] --template TEMPLATE --workspace PATH [--hide PATH ...] [--readonly PATH ...]';
    const workspace = values.workspace === undefined ? null : resolveWorkspace(values.workspace);
    if ((values.hide || values.readonly) && !workspace) throw new SandboxError('--hide and --readonly need --workspace');
    if (positionals.length > 1 || !values.template || (positionals.length === 0 && !workspace)) {
        throw new SandboxError(`usage: ${usage}`);
    }
    const name = checkName(positionals[0] ?? defaultName(workspace));
    const dest = join(sandboxDir(), name);
    // Check everything about the workspace before creating anything.
    const plan = workspace && planWorkspace(workspace, values, realConfigDir(dest));
    applyTemplate(values.template, dest, parseOptionArgs(values.option ?? []));
    if (plan) {
        try {
            applyWorkspace(dest, plan);
        } catch (err) {
            rmSync(dest, { recursive: true, force: true });
            throw err;
        }
        console.log(`created ${dest} from template '${values.template}', around ${workspace}`);
        const repos = plan.gitDirs.length;
        console.log(`read-only inside: ${repos} git repo${repos === 1 ? "'s" : "s'"} hooks and config`
            + `${plan.readonly.length ? `, ${plan.readonly.join(', ')}` : ''}; hidden: ${plan.hide.join(', ') || 'nothing'}`);
    } else {
        console.log(`created ${dest} from template '${values.template}'`);
    }
    console.log(`next: sandbox enter ${name}`);
}

/** Everything --workspace adds, checked: the mounts, and the choices for sandbox.json. */
function planWorkspace(workspace, values, configDir) {
    const hidden = (values.hide ?? []).map((p) => workspacePath(workspace, p, 'hide'));
    const readonly = (values.readonly ?? []).map((p) => workspacePath(workspace, p, 'readonly'));
    const gitDirs = findGitDirs(workspace, hidden);
    const mounts = workspaceMounts({ workspace, hide: hidden, readonly, configDir, gitDirs });
    const rel = (path) => relative(workspace, path);
    return { workspace, hide: hidden.map(rel), readonly: readonly.map(rel), mounts, gitDirs };
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
    checkWorkspace(name, dir, state);
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

/**
 * For a sandbox made with --workspace: refuse to start if a git repo in the workspace would have
 * writable hooks or config inside. Repos get added or moved after the sandbox was made. The
 * container keeps the mounts it was created with, so check those when it exists, else the config.
 */
function checkWorkspace(name, dir, state) {
    const settings = readSettings(dir);
    if (!settings) return;
    const missing = uncoveredInSandbox(dir, state ? containerReadonlyMounts(name) : null);
    if (missing.length === 0) return;
    const redo = state ? `sandbox rm ${name}; ` : '';
    throw new SandboxError(`these would be writable inside ${name}, and git on the host runs what they name:\n`
        + missing.map((path) => `  ${path}\n`).join('')
        + `Make the sandbox again (the options are in ${join(dir, 'sandbox.json')}):\n`
        + `  ${redo}rm -r ${dir}; sandbox new ${name} --template ... --workspace ${settings.workspace} ...`);
}

/** Destinations of container NAME's read-only mounts. */
function containerReadonlyMounts(name) {
    const result = podman(['container', 'inspect', '--format',
        '{{range .Mounts}}{{if not .RW}}{{.Destination}}{{"\\n"}}{{end}}{{end}}', name]);
    if (result.status !== 0) throw new SandboxError(result.stderr.trim());
    return result.stdout.split('\n').filter(Boolean);
}

function cmdInspect(args) {
    const name = oneName(args, 'sandbox inspect NAME');
    const result = podman(['container', 'inspect', name]);
    if (result.status !== 0) {
        throw new SandboxError(`no container '${name}' (sandbox enter ${name} creates it from its config)`);
    }
    const [info] = JSON.parse(result.stdout);
    const command = info.Config?.CreateCommand ?? [];
    console.log(`# The command that created ${name} (podman recorded it):`);
    console.log(command.length ? formatCommand(command, info.ImageName ?? '') : '# (none recorded)');

    // Measured inside while it runs: what the processes in it actually have.
    let status = null;
    if (info.State?.Status === 'running') {
        const proc = podman(['exec', name, 'cat', '/proc/1/status']);
        if (proc.status === 0) status = parseStatus(proc.stdout);
    }
    const internal = {};
    const networks = Object.keys(info.NetworkSettings?.Networks ?? {});
    if (networks.length) {
        const nets = podman(['network', 'inspect', '--format', '{{.Name}} {{.Internal}}', ...networks]);
        for (const line of nets.stdout.split('\n').filter(Boolean)) {
            const [net, isInternal] = line.split(' ');
            internal[net] = isInternal === 'true';
        }
    }
    let uncovered = [];
    const folder = info.Config?.Labels?.['devcontainer.local_folder'];
    if (folder) {
        const readonly = (info.Mounts ?? []).filter((m) => !m.RW).map((m) => m.Destination);
        try {
            uncovered = uncoveredInSandbox(folder, readonly);
        } catch {
            // the config folder is gone: nothing to compare with
        }
    }
    const report = audit(info, { status, internal, uncovered });

    console.log(`\n# What it runs with${status ? ' (capabilities, new privileges, seccomp: measured inside)' : ''}:`);
    const rows = [...report.rows, ...report.mounts.map((text, i) => [i ? '' : 'mounts', text])];
    console.log(table(rows));
    if (report.warnings.length || report.notes.length) console.log('');
    for (const text of report.warnings) console.log(`warning: ${text}`);
    for (const text of report.notes) console.log(`note: ${text}`);
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
    let settings = null;
    try {
        settings = readSettings(folderOf(name));
    } catch {
        // no config folder left: nothing more to say
    }
    if (settings) console.log(`${settings.workspace} is untouched: only the container was removed`);
}

/** Left-aligned columns, two spaces apart. */
export function table(rows) {
    const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => (row[i] ?? '').length)));
    return rows.map((row) => row.map((cell, i) => (i < row.length - 1 ? cell.padEnd(widths[i]) : cell)).join('  '))
        .join('\n');
}
