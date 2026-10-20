// sandbox new: make a sandbox's config folder, from a template or around a project.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { SandboxError, checkName, childEnv, hasConfig, sandboxDir } from './devcontainer.js';
import { isStringList } from './json.js';
import {
    ask, checkNotHidden, hasMarker, keepTrusted, riskSummary, short, stageConfig, writeEffective, yes,
} from './inplace.js';
import { table } from './inspect.js';
import { SECCOMP_RUN_ARG } from './seccomp.js';
import { removeRecord, writeRecord } from './state.js';
import {
    applyTemplate, experimentalImage, parseOptionArgs, seccompAllow, TESTED_IMAGES, withImage,
} from './templates.js';
import {
    applyWorkspace, configFile, defaultName, findGitDirs, findSecretFiles, isInside, readConfig, readSettings, realConfigDir,
    resolveWorkspace, workspaceMounts, workspacePath, writeSettings,
} from './workspace.js';
import { checkHost, vmPolicy } from './vm.js';

export function cmdNew(args) {
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
            vm: { type: 'boolean' },
        },
    });
    const usage = 'sandbox new NAME --template TEMPLATE [--image IMAGE] [--option KEY=VALUE ...] [--vm]\n'
        + '       sandbox new [NAME] --template TEMPLATE --workspace PATH [--image IMAGE] [--hide PATH ...] [--readonly PATH ...] [--vm]\n'
        + '       sandbox new [NAME] --workspace PATH --inplace [--template TEMPLATE] [--yes] [--hide PATH ...] [--readonly PATH ...] [--vm]';
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
    // Before alreadyExists: its "rm -r" advice would delete the project.
    if (workspace && isInside(workspace, realConfigDir(dest))) {
        throw projectAsConfigFolder(realConfigDir(dest), name, workspace, positionals[0]);
    }
    if (existsSync(dest)) throw alreadyExists(dest, name);
    if (values.vm) {
        const host = checkHost();
        if (!host.allowed) throw new SandboxError(host.reason);
    }
    // A record left by a sandbox of this name whose folder was deleted would match the new folder.
    removeRecord(name);
    if (values.inplace) return newInplace(name, dest, workspace, values);
    // Check everything about the workspace before creating anything.
    const plan = workspace && planWorkspace(workspace, values, realConfigDir(dest));
    const given = withImage(parseOptionArgs(values.option ?? []), values.image);
    const template = applyTemplate(values.template, dest, given);
    try {
        if (plan) applyWorkspace(dest, plan);
        if (values.vm) checkVm(name, readConfig(configFile(dest)), dest);
    } catch (err) {
        rmSync(dest, { recursive: true, force: true });
        throw err;
    }
    if (values.vm) writeRecord(name, { kind: 'vm', folder: dest });
    if (plan) {
        console.log(`created ${dest} from template '${values.template}', around ${workspace}`);
        const repos = plan.gitDirs.length;
        console.log(`read-only inside: ${repos} git repo${repos === 1 ? "'s" : "s'"} hooks and config`
            + `${plan.readonly.length ? `, ${plan.readonly.join(', ')}` : ''}; hidden: ${plan.hide.join(', ') || 'nothing'}`);
    } else {
        console.log(`created ${dest} from template '${values.template}'`);
    }
    console.log(nextStep(name, values.vm));
    warnImage(name, template, given);
    if (plan) warnSecrets(name, dest, plan);
}

/** What to run after sandbox new: enter, which makes the container or, with --vm, the VM. */
function nextStep(name, vm) {
    return vm ? `a VM sandbox. next: sandbox enter ${name} (makes its VM; see docs/microvm.md)` : `next: sandbox enter ${name}`;
}

/**
 * sandbox new --vm: refuse CONFIG (of NAME, to be made in DEST) when it can't run as a VM (vmPolicy:
 * the no-vm policy, a postStartCommand or postAttachCommand). Features may add such commands too;
 * enter checks again once the image exists.
 */
function checkVm(name, config, dest) {
    const policy = vmPolicy(config);
    if (!policy.allowed) throw new SandboxError(`${name} can't run as a VM: ${policy.reason}; ${dest} wasn't made`);
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

/**
 * The error for `sandbox new --workspace` when the config folder DEST ($SANDBOX_DIR/NAME) would be
 * the project (WORKSPACE) or a folder around it: NAME defaults to the project folder's name, so a
 * project kept in $SANDBOX_DIR gets this. GIVEN: the NAME given, if any.
 */
function projectAsConfigFolder(dest, name, workspace, given) {
    const what = dest === workspace ? 'which is your project itself' : `which contains your project (${workspace})`;
    const why = given ? '' : ` (NAME defaults to the project folder's name, ${name})`;
    return new SandboxError([
        `the sandbox's config folder would be ${dest}, ${what}${why}.`,
        `  Give the sandbox another NAME:  sandbox new ${name}-sandbox --workspace ${workspace} ...`,
        `  Or keep the project outside ${sandboxDir()}: that folder holds the sandboxes' config folders.`,
    ].join('\n'));
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
        : sandbox ? 'a sandbox made from a template, and its workspace' : 'a folder, not a sandbox';
    const rm = `sandbox rm ${name} (if it has a container), then`;
    // Suggest rm -r only for a folder that holds nothing but config. A sandbox made without
    // --workspace keeps its work in this folder, and a folder that isn't a sandbox is someone's.
    const again = settings ? `${rm} rm -r ${dest} (only its config: ${settings.workspace} stays), then this command`
        : sandbox ? `${rm} move the folder aside, with the work in it (mv ${dest} ${dest}.old), then this command`
            : `move the folder out of ${sandboxDir()} (sandbox leaves folders it didn't make alone), then this command`;
    return new SandboxError([
        `${dest} already exists (${what}).`,
        ...(sandbox ? [`  To use it:            sandbox enter ${name}`] : []),
        `  ${sandbox ? 'To make it again:   ' : 'To use this NAME:   '}  ${again}`,
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
        if (values.vm) checkVm(name, staged.config, dest);
    } catch (err) {
        if (staged) rmSync(staged.root, { recursive: true, force: true });
        if (template) rmSync(config, { recursive: true, force: true });
        throw err;
    }
    try {
        if (!template && !firstTrust(name, config, staged, values.yes)) {
            throw new SandboxError(`not trusted: ${dest} wasn't made`);
        }
        try {
            mkdirSync(dest, { recursive: true });
            keepTrusted(dest, staged.root);
            const settings = { workspace, hide: plan.hide, readonly: plan.readonly, inplace: true, configTree: staged.id };
            writeSettings(dest, settings);
            writeEffective(dest, settings);
        } catch (err) {
            rmSync(dest, { recursive: true, force: true });
            // The template's .devcontainer too: written by this command (there was none before).
            if (template) rmSync(config, { recursive: true, force: true });
            throw err;
        }
    } finally {
        rmSync(staged.root, { recursive: true, force: true });
    }
    if (values.vm) writeRecord(name, { kind: 'vm', folder: dest });
    if (template) {
        console.log(`wrote ${config} from template '${values.template}': review it, and commit it with the project`);
    }
    console.log(`created ${dest} with the project's own config ${short(staged.id)}, around ${workspace}`);
    const repos = plan.gitDirs.length;
    console.log(`read-only inside: .devcontainer, ${repos} git repo${repos === 1 ? "'s" : "s'"} hooks and config`
        + `${plan.readonly.length ? `, ${plan.readonly.join(', ')}` : ''}; hidden: ${plan.hide.join(', ') || 'nothing'}`);
    console.log(nextStep(name, values.vm));
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
            // runArgs that aren't a list stay as they are, for stageConfig to refuse (checkFields).
            const runArgs = config.runArgs ?? [];
            if (isStringList(runArgs)) config.runArgs = runArgs.filter((arg) => arg !== SECCOMP_RUN_ARG);
            writeFileSync(configFile(copy), `${JSON.stringify(config, null, 2)}\n`);
        }
        try {
            cpSync(join(copy, '.devcontainer'), join(workspace, '.devcontainer'),
                { recursive: true, filter: (path) => path !== generated });
        } catch (err) {
            // A partial copy (disk full, permissions): not left in the project, which had none.
            rmSync(join(workspace, '.devcontainer'), { recursive: true, force: true });
            throw err;
        }
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
