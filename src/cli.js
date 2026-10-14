// sandbox — lxc-style front end for dev containers on rootless Podman.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import {
    SANDBOX_LABEL, SandboxError, checkName, childEnv, cliPath, containerSandbox, containerState, dc, folderOf, hasConfig,
    podman, sandboxDir, sandboxReason,
} from './devcontainer.js';
import {
    TRUSTED, ask, checkNotHidden, configChange, hasMarker, keepTrusted, riskSummary, short, stageConfig,
    writeEffective, yes,
} from './inplace.js';
import { checkExportable, exportedConfig } from './export.js';
import { SECCOMP_RUN_ARG } from './seccomp.js';
import { VSCODE_PROBE, audit, formatCommand, parseStatus, parseVscodeProbe } from './inspect.js';
import {
    applyTemplate, experimentalImage, listTemplates, parseOptionArgs, seccompAllow, TESTED_IMAGES, withImage,
} from './templates.js';
import {
    SETTINGS, applyWorkspace, configFile, defaultName, findGitDirs, findSecretFiles, readConfig, readSettings, realConfigDir, resolveWorkspace,
    uncoveredInSandbox, workspaceMounts, workspacePath, writeSettings,
} from './workspace.js';

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
                       --workspace, first check every git repo is protected
  sandbox exec NAME [--] COMMAND [ARG ...]
                       start NAME if needed and run COMMAND in it, like
                       'ssh host COMMAND': as $USER, in the workspace folder,
                       with a terminal only if you're at one; its exit status
  sandbox help [NAME]  this text; with NAME, what that sandbox offers (from its
                       template), e.g. sandbox help mitm-proxy
  sandbox inspect NAME the podman command that created NAME's container, as a
                       command line, and what it runs with: user, capabilities,
                       new privileges, seccomp, network, mounts; with warnings
  sandbox list         list dev containers
  sandbox stop [--force] NAME
                       stop NAME; --force also stops a container sandbox
                       didn't make
  sandbox rm [--force] NAME
                       remove NAME's container (its home volume, config folder
                       and any --workspace folder are kept); --force as for stop
  sandbox --version    show the version (and the Dev Containers CLI's)

Start with:  sandbox new work --template claude && sandbox enter work
Sandboxes live in $SANDBOX_DIR (default ~/sandboxes).
More: https://github.com/EddyPronk/podman-agent-sandbox#usage
`;

const commands = {
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

export function main(argv) {
    const [cmd, ...args] = argv;
    if (cmd === '-h' || cmd === '--help' || (cmd === 'help' && args.length === 0)) {
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
            image: { type: 'string', short: 'i' },
            workspace: { type: 'string', short: 'w' },
            hide: { type: 'string', multiple: true },
            readonly: { type: 'string', multiple: true },
            inplace: { type: 'boolean' },
            yes: { type: 'boolean', short: 'y' },
        },
    });
    const usage = 'sandbox new NAME --template TEMPLATE [--image IMAGE] [--option KEY=VALUE ...]\n'
        + '       sandbox new [NAME] --template TEMPLATE --workspace PATH [--image IMAGE] [--hide PATH ...] [--readonly PATH ...]\n'
        + '       sandbox new [NAME] --workspace PATH --inplace [--template TEMPLATE] [--yes] [--hide PATH ...] [--readonly PATH ...]';
    const workspace = values.workspace === undefined ? null : resolveWorkspace(values.workspace);
    if ((values.hide || values.readonly) && !workspace) throw new SandboxError('--hide and --readonly need --workspace');
    if (values.inplace && !workspace) throw new SandboxError('--inplace needs --workspace: the project whose .devcontainer to use');
    if (values.yes && !values.inplace) throw new SandboxError('--yes goes with --inplace');
    if (positionals.length > 1 || (positionals.length === 0 && !workspace)) throw new SandboxError(`usage: ${usage}`);
    if (!values.template && !values.inplace) {
        const hint = workspace && hasMarker(workspace)
            ? `\nThis project has its own sandbox config: sandbox new --workspace ${values.workspace} --inplace` : '';
        throw new SandboxError(`usage: ${usage}${hint}`);
    }
    const name = checkName(positionals[0] ?? defaultName(workspace));
    const dest = join(sandboxDir(), name);
    if (existsSync(dest)) throw alreadyExists(dest, name);
    if (values.inplace) return newInplace(name, dest, workspace, values);
    // Check everything about the workspace before creating anything.
    const plan = workspace && planWorkspace(workspace, values, realConfigDir(dest));
    const given = withImage(parseOptionArgs(values.option ?? []), values.image);
    const template = applyTemplate(values.template, dest, given);
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
    warnImage(name, template, given);
    if (plan) warnSecrets(name, dest, plan);
}

/** Warn about an experimental --image (GIVEN.image) for TEMPLATE. */
function warnImage(name, template, given) {
    if (given.image === undefined) return;
    // A template from a path may declare the option without a default.
    const defaultImage = template.options?.image?.default;
    if (experimentalImage(given.image, defaultImage)) {
        const tested = [...TESTED_IMAGES, ...(defaultImage === undefined ? [] : [`the default, ${defaultImage}`])];
        console.error(`sandbox: warning: --image ${given.image} is experimental (tested: ${tested.join(' and ')}).`
            + ` After 'sandbox enter ${name}', run 'sandbox inspect ${name}': it may show warnings about weaknesses.`);
    }
}

/** The error for `sandbox new` when $SANDBOX_DIR/NAME exists: what it is, and the ways out. */
function alreadyExists(dest, name) {
    let settings = null;
    try {
        settings = readSettings(dest);
    } catch {
        // unreadable sandbox.json: describe it as a folder
    }
    const sandbox = Boolean(settings) || hasConfig(dest);
    const what = settings ? `a sandbox around ${settings.workspace}, ${settings.inplace ? 'made with --inplace' : 'made from a template'}`
        : sandbox ? 'a sandbox made from a template' : 'a folder, not a sandbox';
    return new SandboxError([
        `${dest} already exists (${what}).`,
        ...(sandbox ? [`  To use it:            sandbox enter ${name}`] : []),
        `  To make it again:     ${sandbox ? `sandbox rm ${name} (if it has a container), then ` : ''}rm -r ${dest}, then this command`,
        '  To make another one:  give it another NAME: sandbox new OTHER-NAME ...',
    ].join('\n'));
}

/**
 * sandbox new --inplace: the project's own .devcontainer is the config. With --template, write that
 * template there first. Check it (a sandbox config, self-contained), have the user trust it (unless
 * just written from a template, or --yes), keep that copy in DEST/trusted, and make the config that
 * runs from it.
 */
function newInplace(name, dest, workspace, values) {
    const plan = planWorkspace(workspace, values, realConfigDir(dest));
    checkNotHidden(workspace, plan.hide.map((path) => join(workspace, path)));
    const config = join(workspace, '.devcontainer');
    let template = null;
    const given = withImage(parseOptionArgs(values.option ?? []), values.image);
    if (values.template) {
        if (existsSync(config)) {
            throw new SandboxError(`${config} already exists, and --template would write over it; to use it as it is, leave out --template`);
        }
        template = writeTemplateInto(values.template, workspace, given);
    } else if (values.option || values.image) {
        throw new SandboxError('--option and --image fill in a template: with --inplace, they need --template');
    }
    let staged;
    try {
        staged = stageConfig(workspace);
    } catch (err) {
        if (template) rmSync(config, { recursive: true, force: true });
        throw err;
    }
    try {
        if (!template && !firstTrust(name, config, staged, values.yes)) {
            throw new SandboxError(`not trusted: ${dest} wasn't made`);
        }
        mkdirSync(dest, { recursive: true });
        try {
            keepTrusted(dest, staged.root);
            const settings = { workspace, hide: plan.hide, readonly: plan.readonly, inplace: true, configTree: staged.id };
            writeSettings(dest, settings);
            writeEffective(dest, settings);
        } catch (err) {
            rmSync(dest, { recursive: true, force: true });
            throw err;
        }
    } finally {
        rmSync(staged.root, { recursive: true, force: true });
    }
    if (template) {
        console.log(`wrote ${config} from template '${values.template}': review it, and commit it with the project`);
    }
    console.log(`created ${dest} with the project's own config ${short(staged.id)}, around ${workspace}`);
    const repos = plan.gitDirs.length;
    console.log(`read-only inside: .devcontainer, ${repos} git repo${repos === 1 ? "'s" : "s'"} hooks and config`
        + `${plan.readonly.length ? `, ${plan.readonly.join(', ')}` : ''}; hidden: ${plan.hide.join(', ') || 'nothing'}`);
    console.log(`next: sandbox enter ${name}`);
    if (template) warnImage(name, template, given);
    warnSecrets(name, dest, plan);
}

/**
 * Write template SPEC (with GIVEN options) into WORKSPACE/.devcontainer, as `sandbox new` would copy
 * it, but only its .devcontainer, and without what sandbox makes from seccompAllow: the profile
 * (seccomp.json) and the runArg naming it (SECCOMP_RUN_ARG). Returns the template's metadata.
 */
function writeTemplateInto(spec, workspace, given) {
    const tmp = mkdtempSync(join(tmpdir(), 'sandbox-template-'));
    try {
        const copy = join(tmp, 'template');
        const template = applyTemplate(spec, copy, given, undefined, { seccomp: false });
        const generated = seccompAllow(copy, template)?.length ? join(copy, '.devcontainer', 'seccomp.json') : null;
        if (generated) {
            const config = readConfig(configFile(copy));
            config.runArgs = (config.runArgs ?? []).filter((arg) => arg !== SECCOMP_RUN_ARG);
            writeFileSync(configFile(copy), `${JSON.stringify(config, null, 2)}\n`);
        }
        cpSync(join(copy, '.devcontainer'), join(workspace, '.devcontainer'),
            { recursive: true, filter: (path) => path !== generated });
        const left = readdirSync(copy).filter((entry) => entry !== '.devcontainer');
        if (left.length) console.log(`not written into the project (the template has them outside .devcontainer): ${left.join(', ')}`);
        return template;
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

/**
 * The first trust of a project's config: what it asks for, and a yes. YES (--yes) skips the
 * question; not at a terminal without it, refuse.
 */
function firstTrust(name, config, staged, yesFlag) {
    const risks = riskSummary(staged.config, childEnv());
    console.error(`sandbox: ${config} (${short(staged.id)}) asks for:`);
    console.error(risks.length ? table(risks.map(([what, value]) => [`  ${what}`, value])) : '  nothing beyond a plain container');
    if (yesFlag) return true;
    const answer = ask(`Use this config for ${name}? [y/N] `);
    if (answer === null) {
        throw new SandboxError(`not at a terminal, so not asking: review ${config}, then run this again with --yes`);
    }
    return yes(answer);
}

/** Everything --workspace adds, checked: the mounts, and the choices for sandbox.json. */
function planWorkspace(workspace, values, configDir) {
    const hidden = (values.hide ?? []).map((p) => workspacePath(workspace, p, 'hide'));
    const readonly = (values.readonly ?? []).map((p) => workspacePath(workspace, p, 'readonly'));
    const gitDirs = findGitDirs(workspace, hidden);
    const mounts = workspaceMounts({ workspace, hide: hidden, readonly, configDir, gitDirs });
    const rel = (path) => relative(workspace, path);
    const secrets = findSecretFiles(workspace, hidden);
    return { workspace, hide: hidden.map(rel), readonly: readonly.map(rel), mounts, gitDirs, secrets };
}

/** After making NAME (in DEST): warn about files in the workspace that may hold secrets (PLAN). */
function warnSecrets(name, dest, plan) {
    if (!plan.secrets.length) return;
    const shown = plan.secrets.slice(0, 10);
    const more = plan.secrets.length - shown.length;
    console.error([
        `sandbox: warning: ${name} can read files whose names suggest secrets:`,
        ...shown.map((path) => `  ${path}`),
        ...(more ? [`  ... and ${more} more`] : []),
        `To hide them inside: rm -r ${dest}, then this command again with --hide PATH for each`
            + ' (a folder hides what is in it). Hidden, they read as empty inside.',
    ].join('\n'));
}

function cmdTemplates(args) {
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

function cmdBuild(args) {
    const [name, ...rest] = args;
    if (!name) throw new SandboxError('usage: sandbox build NAME [--no-cache]');
    const dir = folderOf(name);
    const inplace = checkTrusted(name, dir);
    if (inplace) writeEffective(dir, inplace);
    const result = dc('build', ['--workspace-folder', dir, ...rest]);
    if (result.status !== 0) return exitStatus(result);
    if (containerState(name)) {
        console.error(`sandbox: ${name} still runs the old image; use 'sandbox rm ${name}' then 'sandbox enter ${name}'`);
    }
}

function cmdEnter(args) {
    const name = oneName(args, 'sandbox enter NAME');
    const dir = folderOf(name);
    ensureRunning(name, dir);
    // Node can't exec() in place: run the shell as a child and pass on its status.
    // Ignore Ctrl-C here so it only reaches the shell in the container.
    process.on('SIGINT', () => {});
    // "--" stops the CLI from parsing -l as its own option.
    return exitStatus(dc('exec', ['--workspace-folder', dir, '--', 'bash', '-l']));
}

/**
 * sandbox exec NAME [--] CMD [ARG...]: like `ssh host CMD`, everything after NAME is the command,
 * run as the user in the workspace folder with the environment of `enter`.
 */
function cmdExec(args) {
    const [name, ...rest] = args;
    const cmd = rest[0] === '--' ? rest.slice(1) : rest;
    if (!name || name.startsWith('-') || cmd.length === 0) {
        throw new SandboxError('usage: sandbox exec NAME [--] COMMAND [ARG ...]');
    }
    const dir = folderOf(checkName(name));
    ensureRunning(name, dir);
    process.on('SIGINT', () => {});
    return exitStatus(dc('exec', ['--workspace-folder', dir, '--', ...cmd]));
}

/** sandbox help NAME: what helpText says for it. Works while the sandbox is stopped. */
function cmdHelp(args) {
    const name = oneName(args, 'sandbox help [NAME]');
    process.stdout.write(helpText(name, folderOf(name)));
}

/**
 * The sandbox's .devcontainer/HELP: plain text from its template, read on the host and never run,
 * with ${localWorkspaceFolderBasename} and ${localWorkspaceFolder} replaced as in devcontainer.json.
 * Without one, what every sandbox offers.
 */
export function helpText(name, dir) {
    let text;
    try {
        text = readFileSync(join(dir, '.devcontainer', 'HELP'), 'utf8');
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
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

/** Start NAME if it isn't running: create its container (building the image) or restart it. */
function ensureRunning(name, dir) {
    const state = containerState(name);
    // An --inplace sandbox: refuse an untrusted project config, and make the config that runs again
    // before creating the container (a newer sandbox's settings apply without a new trust).
    const inplace = checkTrusted(name, dir);
    if (inplace && !state) writeEffective(dir, inplace);
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

/**
 * For an --inplace sandbox (in DIR): refuse when the project's config isn't the one the user trusted,
 * offering the diff. Returns its settings, or null for other sandboxes.
 */
function checkTrusted(name, dir) {
    const settings = readSettings(dir);
    if (!settings?.inplace) return null;
    const change = configChange(dir, settings);
    if (!change) return settings;
    const config = join(settings.workspace, '.devcontainer');
    if (!change.now) {
        throw new SandboxError(`${name}: ${config} is gone (trusted: ${short(change.trusted)}); restore it, `
            + `or remove the sandbox (sandbox rm ${name}, then rm -r ${dir})`);
    }
    console.error(`sandbox: ${name}: the project's config changed since you trusted it (${short(change.trusted)} -> ${short(change.now)}).`);
    const command = change.diff.join(' ');
    const show = ask(`Show what changed (${command})? [Y/n] `);
    if (show === null) {
        console.error(`See what changed:  ${command}`);
    } else if (!['n', 'no'].includes(show)) {
        spawnSync(change.diff[0], change.diff.slice(1), { stdio: 'inherit' });
    }
    throw new SandboxError(`not using ${name} until you decide: 'sandbox trust ${name}' to review and use the new `
        + `config, or restore ${config}`);
}

/**
 * sandbox trust NAME [--yes]: for an --inplace sandbox, show how the project's config changed since
 * it was trusted, and on yes, make that the trusted copy and the config that runs.
 */
function cmdTrust(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { yes: { type: 'boolean', short: 'y' } } });
    const name = oneName(positionals, 'sandbox trust NAME [--yes]');
    const dir = folderOf(name);
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
        const updated = { ...settings, configTree: staged.id };
        writeSettings(dir, updated);
        writeEffective(dir, updated);
    } finally {
        rmSync(staged.root, { recursive: true, force: true });
    }
    console.log(`${name}: now uses the project's config ${short(staged.id)}`);
    if (containerState(name)) {
        console.error(`sandbox: ${name}'s container still runs with the old config; use 'sandbox rm ${name}' then 'sandbox enter ${name}'`);
    }
    return 0;
}

/**
 * sandbox export NAME: write NAME's config (made with --workspace) into its project as .devcontainer,
 * without this machine's settings (export.js), check it as --inplace would, and make NAME use it.
 */
function cmdExport(args) {
    const name = oneName(args, 'sandbox export NAME');
    const dir = folderOf(name);
    const settings = readSettings(dir);
    checkExportable(name, dir, settings);
    const { config, skip, removed, leftovers } = exportedConfig(dir, settings);
    const source = join(dir, '.devcontainer');
    const target = join(settings.workspace, '.devcontainer');
    const skipped = skip.map((file) => join(source, file));
    cpSync(source, target, { recursive: true, verbatimSymlinks: true, filter: (path) => !skipped.includes(path) });
    writeFileSync(join(target, 'devcontainer.json'), `${JSON.stringify(config, null, 2)}\n`);
    let staged;
    try {
        staged = stageConfig(settings.workspace);
    } catch (err) {
        rmSync(target, { recursive: true, force: true });
        throw new SandboxError(`${name}'s config can't be used as a project config, so nothing was written: ${err.message}`);
    }
    try {
        keepTrusted(dir, staged.root);
        const updated = { ...settings, inplace: true, configTree: staged.id };
        writeSettings(dir, updated);
        writeEffective(dir, updated);
    } finally {
        rmSync(staged.root, { recursive: true, force: true });
    }
    console.log(`wrote ${target} (${short(staged.id)}): ${name}'s config, with your edits, without this machine's settings`);
    for (const what of removed) console.log(`  left out: ${what}`);
    if (leftovers.length) {
        console.error(`sandbox: warning: it still names paths of this machine; edit them out before you commit:\n`
            + leftovers.map((line) => `  ${line}\n`).join(''));
    }
    console.log(`${name} now uses the project's config, as if made with --inplace: a change there needs 'sandbox trust ${name}'.`);
    if (containerState(name)) {
        console.error(`sandbox: warning: ${name}'s container predates ${target}, which is writable inside it until `
            + `you make it again: sandbox rm ${name}, then sandbox enter ${name}`);
    }
    console.log(`Review and commit ${target}. For the project's README:\n`
        + '  To work in a sandbox (https://github.com/EddyPronk/podman-agent-sandbox):\n'
        + '      sandbox new --workspace . --inplace');
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
    const labels = info.Config?.Labels ?? {};
    const reason = sandboxReason({ label: labels[SANDBOX_LABEL], folder: labels['devcontainer.local_folder'] });
    console.log(reason ? `# ${name} is a sandbox (${reason}).`
        : `# ${name} is not a sandbox: no ${SANDBOX_LABEL} label or sandbox config folder (VS Code's, or your own?).`);
    const command = info.Config?.CreateCommand ?? [];
    console.log(`\n# The command that created ${name} (podman recorded it):`);
    console.log(command.length ? formatCommand(command, info.ImageName ?? '')
        : '# (none: podman records it only for the podman command, not for containers made through its API\n'
        + '# socket, as VS Code and other Docker clients do)');

    // Measured inside while it runs: what the processes in it actually have.
    let status = null;
    let vscode = null;
    if (info.State?.Status === 'running') {
        const proc = podman(['exec', name, 'cat', '/proc/1/status']);
        if (proc.status === 0) status = parseStatus(proc.stdout);
        // What VS Code forwards when attached: not mounts, so only visible inside (inspect.js).
        const probe = podman(['exec', name, 'sh', '-c', VSCODE_PROBE]);
        if (probe.status === 0) vscode = parseVscodeProbe(probe.stdout);
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
    const configWritable = reason ? writableConfig(info, folder) : null;
    if (folder) {
        const readonly = (info.Mounts ?? []).filter((m) => !m.RW).map((m) => m.Destination);
        try {
            uncovered = uncoveredInSandbox(folder, readonly);
        } catch {
            // the config folder is gone: nothing to compare with
        }
    }
    const report = audit(info, { status, internal, uncovered, sandbox: Boolean(reason), vscode, configWritable });
    const untrusted = folder ? untrustedChange(folder) : null;
    if (untrusted) report.warnings.unshift(`${untrusted}: enter, exec and build refuse until 'sandbox trust ${name}'`);

    console.log(`\n# What it runs with${status ? ' (capabilities, new privileges, seccomp: measured inside)' : ''}:`);
    const rows = [...report.rows, ...report.mounts.map((text, i) => [i ? '' : 'mounts', text])];
    console.log(table(rows));
    if (report.warnings.length || report.notes.length) console.log('');
    for (const text of report.warnings) console.log(`warning: ${text}`);
    for (const text of report.notes) console.log(`note: ${text}`);
}

/** For an --inplace sandbox in FOLDER: how its project's config differs from the trusted one, or null. */
function untrustedChange(folder) {
    let settings;
    try {
        settings = readSettings(folder);
    } catch {
        return null;
    }
    if (!settings?.inplace) return null;
    const change = configChange(folder, settings);
    if (!change) return null;
    const config = join(settings.workspace, '.devcontainer');
    return change.now
        ? `the project's config changed since it was trusted (${short(change.trusted)} -> ${short(change.now)}; ${change.diff.join(' ')})`
        : `the project's config ${config} is gone`;
}

/**
 * Where a sandbox made without --workspace has its own .devcontainer writable inside: its folder is
 * bind-mounted read-write (the workspace) and nothing read-only covers FOLDER/.devcontainer. Null when
 * protected, for --workspace sandboxes (their config stays outside), or when there's no such config.
 */
export function writableConfig(info, folder, exists = existsSync) {
    if (!folder || exists(join(folder, SETTINGS)) || !exists(join(folder, '.devcontainer'))) return null;
    const mounts = (info.Mounts ?? []).filter((m) => m.Type === 'bind');
    const workspace = mounts.find((m) => m.Source === folder && m.RW);
    if (!workspace) return null;
    const config = join(folder, '.devcontainer');
    return mounts.some((m) => m.Source === config && !m.RW) ? null : join(workspace.Destination, '.devcontainer');
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

/** NAME from `[--force] NAME`; refuses a container that isn't a sandbox unless --force. */
function sandboxName(args, sub) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { force: { type: 'boolean' } } });
    const name = oneName(positionals, `sandbox ${sub} [--force] NAME`);
    if (!values.force && containerSandbox(name) === '') {
        throw new SandboxError(`${name} isn't a sandbox: no ${SANDBOX_LABEL} label, and its config folder (if any) `
            + `is neither in ${sandboxDir()} nor has a sandbox.json. It may be VS Code's or your own.\n`
            + `To ${sub} it anyway: sandbox ${sub} --force ${name} (or podman ${sub} ${name}). For a sandbox made `
            + 'with another SANDBOX_DIR, set that SANDBOX_DIR.');
    }
    return name;
}

function cmdStop(args) {
    const name = sandboxName(args, 'stop');
    const result = podman(['stop', name]);
    if (result.status !== 0) throw new SandboxError(result.stderr.trim());
    console.log(`stopped ${name}`);
}

function cmdRm(args) {
    const name = sandboxName(args, 'rm');
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
