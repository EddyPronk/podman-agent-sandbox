// @ts-check
// A sandbox as the commands see it: its config folder and what podman has of it, a normal container,
// a VM, or both. The middle layer between the commands (cli.js) and the containers (container.js,
// vm.js): the commands call one method of a Sandbox, and the Sandbox decides what that means for its
// container and VM, and runs the checks first (the --inplace trust, the git protection, the config's
// version). The only layer that knows a sandbox may have both.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Container, inspectContainer } from './container.js';
import {
    SANDBOX_LABEL, SandboxError, checkName, childEnv, dc, exitStatus, folderOf, hasConfig, podman, sandboxDir,
} from './devcontainer.js';
import { ask, configChange, short, writeEffective } from './inplace.js';
import { configVolumes, formatBytes, removedRows, table } from './inspect.js';
import { lockSandbox } from './lock.js';
import { readRecord, removeRecord, writeRecord } from './state.js';
import { checkMinVersion } from './templates.js';
import { VM_OF_LABEL, Vm, checkHost, madeAt, vmName, vmPolicy } from './vm.js';
import { configFile, readConfig, readSettings, uncoveredInSandbox } from './workspace.js';

/** @typedef {import('./vm.js').Answer} Answer */
/** @type {Answer} */
const ALLOWED = { allowed: true };

/**
 * Sandbox NAME as it is now. With LOCK, take its lock first (sandbox enter, exec, stop and rm: the
 * commands that change it), then read the state, so the state read is the one the command acts on.
 * @param {string} name
 * @param {{ lock?: boolean }} [options]
 */
export function loadSandbox(name, { lock = false } = {}) {
    checkName(name);
    /** @type {import('./lock.js').Release} */
    const release = lock ? lockSandbox(name) : () => {};
    /** @type {Sandbox | undefined} */
    let sandbox;
    // A command on a sandbox that doesn't exist (a typo) leaves no lock file behind.
    const done = () => release({ remove: !sandbox?.known() });
    try {
        sandbox = new Sandbox(name, done);
        return sandbox;
    } catch (err) {
        done();
        throw err;
    }
}

/**
 * What there is of sandbox NAME: the container named NAME (and, when that's another sandbox's VM,
 * whose), its VM, found by its label, and its record (state.js).
 * @param {string} name
 * @returns {{ container: Container, vmOf: string, vm: Vm | null, record: import('./state.js').Record | null }}
 */
function readState(name) {
    const container = Container.load(name);
    const vmOf = container.labels[VM_OF_LABEL] ?? '';
    return { container, vmOf, vm: vmOf ? null : Vm.find(name), record: vmOf ? null : readRecord(name) };
}

/**
 * What enterPlan decides from.
 * @typedef {object} EnterState
 * @property {string} name
 * @property {{ exists: boolean, active: boolean, created: string }} container  the normal container
 * @property {{ exists: boolean, active: boolean }} vm
 * @property {boolean} nameTaken  a container named NAME-vm exists that isn't NAME's VM
 *
 * What sandbox enter does: open (start if needed, then a shell in) the container or the VM, start the
 * VM, make the VM (CREATE_FIRST: the normal container first), or refuse.
 * @typedef {{ action: 'open', target: 'container' | 'vm' } | { action: 'start' }
 *     | { action: 'makeVm', createFirst: boolean } | { action: 'refuse', why: string }} EnterAction
 */

/**
 * sandbox enter's decision (PLAN.md, Behaviour), from the state alone. VM: --vm; FROM_EXISTING:
 * --from-existing; POLICY: vmPolicy's answer for the config; HOST: checkHost's.
 * @param {EnterState} state
 * @param {{ vm?: boolean, fromExisting?: boolean, policy?: Answer, host?: Answer }} [options]
 * @returns {EnterAction}
 */
export function enterPlan(state, { vm = false, fromExisting = false, policy = ALLOWED, host = ALLOWED } = {}) {
    const { name } = state;
    /** @param {string} why @returns {EnterAction} */
    const refuse = (why) => ({ action: 'refuse', why });
    if (!vm) {
        if (state.vm.exists) {
            return refuse(`${name} is a VM: to make it a container, 'sandbox rm ${name}' (volumes are kept), then `
                + `'sandbox enter --container ${name}'`);
        }
        return { action: 'open', target: 'container' };
    }
    // The refusals that come first, on every path.
    if (!host.allowed) return refuse(host.reason);
    if (!policy.allowed) return refuse(`${name} can't run as a VM: ${policy.reason}`);
    if (state.vm.active) return { action: 'open', target: 'vm' };
    if (state.container.active) return refuse(`${name} runs as a normal container, not a VM: 'sandbox stop ${name}' first`);
    if (state.vm.exists) return { action: 'start' };
    // From here on, a VM would be made.
    if (state.nameTaken) {
        return refuse(`the name ${vmName(name)} is taken by another container (not ${name}'s VM); rename or remove it `
            + `(podman rename, podman rm) to make ${name}'s VM`);
    }
    if (state.container.exists) {
        if (fromExisting) return { action: 'makeVm', createFirst: false };
        return refuse(`${name} already exists as a container, made ${state.container.created}. A VM would copy its image, `
            + 'mounts and settings as they were then.\n'
            + `  For a fresh sandbox:  sandbox rm ${name} (volumes are kept), then sandbox enter --vm ${name}\n`
            + `  To make the VM from this container anyway:  sandbox enter --vm --from-existing ${name}`);
    }
    if (fromExisting) return refuse(`${name} has no container to make the VM from: leave out --from-existing`);
    return { action: 'makeVm', createFirst: true };
}

export class Sandbox {
    /**
     * @param {string} name
     * @param {() => void} release  releases the lock, if taken
     */
    constructor(name, release) {
        this.name = name;
        this.release = release;
        const now = readState(name);
        /** The container named NAME, unless it's another sandbox's VM (vmOf). */
        this.container = now.container;
        /** The sandbox whose VM the container named NAME is, or ''. */
        this.vmOf = now.vmOf;
        this.vm = now.vm;
        this.record = now.record;
    }

    /** Read the state again, after a step that changed it. */
    reload() {
        const now = readState(this.name);
        this.container = now.container;
        this.vmOf = now.vmOf;
        this.vm = now.vm;
        this.record = now.record;
    }

    /**
     * What the sandbox is: 'vm' or 'container'. Its record says (sandbox new --vm, enter --vm, enter
     * --container), and a VM sandbox stays one after sandbox rm. Without a record: a VM if it has one.
     * @returns {import('./state.js').Kind}
     */
    get kind() {
        return this.record?.kind ?? (this.vm ? 'vm' : 'container');
    }

    /** The sandbox's config folder: the container's label, the record's, or $SANDBOX_DIR/NAME; refuses when there's none. */
    get dir() {
        return folderOf(this.name, { lookup: () => this.container.folder || this.record?.folder || '' });
    }

    /** Whether the sandbox has a container or a VM, running or not: made from an older config or image. */
    made() {
        return this.container.exists || this.vm !== null;
    }

    /** Whether there is such a sandbox: a container, a VM, a record or a config folder. */
    known() {
        if (this.made() || this.record) return true;
        try {
            return Boolean(this.dir);
        } catch {
            return false;   // folderOf: no config folder either
        }
    }

    /**
     * sandbox enter [--vm [--from-existing] | --container]: open the sandbox as what it is (its kind),
     * or as KIND when given, starting or making it as PLAN.md's rules say; the shell's exit status.
     * @param {{ kind?: import('./state.js').Kind | null, fromExisting?: boolean }} [options]
     */
    enter({ kind = null, fromExisting = false } = {}) {
        /** @type {Container | Vm} */
        let target;
        try {
            this.#checkNotAVm();
            if ((kind ?? this.kind) === 'container') {
                this.#refuseIf(enterPlan(this.#state(), {}));
                // A VM sandbox removed with sandbox rm, made a container now (--container): forget it was one.
                if (this.record) removeRecord(this.name);
                this.#start();
                target = this.container;
            } else {
                target = this.#enterVm(fromExisting);
            }
        } finally {
            this.release();
        }
        return target.openShell();
    }

    /**
     * sandbox exec: start the container if needed, and run COMMAND; its exit status. Not for a VM
     * sandbox, also after sandbox rm: a command can't run next to a VM's shell, and starting the
     * container instead would run it elsewhere.
     * @param {string[]} command
     */
    exec(command) {
        try {
            this.#checkNotAVm();
            const target = this.kind === 'vm' ? this.vm : this.container;
            if (!target?.canExec) {
                throw new SandboxError(`${this.name} is a VM sandbox; exec can't run commands in it. Use 'sandbox enter `
                    + `${this.name}', or, to make it a container: 'sandbox rm ${this.name}', then 'sandbox enter --container `
                    + `${this.name}'`);
            }
            this.#start();
        } finally {
            this.release();
        }
        return this.container.exec(command);
    }

    /**
     * sandbox build: build the image, after the checks a container creation makes; the exit status.
     * @param {string[]} args  passed on to devcontainer build (--no-cache)
     */
    build(args) {
        this.#checkNotAVm();
        const dir = this.dir;
        const inplace = checkTrusted(this.name, dir);
        if (inplace) writeEffective(dir, inplace);
        checkConfigVersion(dir);
        const result = dc('build', ['--workspace-folder', dir, ...args]);
        if (result.status !== 0) return exitStatus(result);
        if (this.made()) {
            console.error(`sandbox: ${this.name} still runs the old image${this.vm ? ' (its VM too)' : ''}; use `
                + `'sandbox rm ${this.name}' then 'sandbox enter ${this.name}'`);
        }
        return 0;
    }

    /**
     * sandbox stop: stop what is active, the VM at once; what to print. FORCE: also a container
     * sandbox didn't make.
     * @param {{ force?: boolean }} [options]
     */
    stop({ force = false } = {}) {
        try {
            this.#checkNotAVm();
            const { name, container, vm } = this;
            if (!container.exists && !vm) throw new SandboxError(`${name} has no container or VM to stop`);
            const done = [];
            if (vm?.active) {
                vm.stop();
                done.push(`stopped ${name}'s VM`);
            }
            if (container.active) {
                this.#checkOurs('stop', force);
                container.stop();
                done.push(`stopped ${name}`);
            }
            return done.length ? done.join('\n') : `${name} isn't running: nothing to stop`;
        } finally {
            this.release();
        }
    }

    /**
     * sandbox rm: remove the container and the VM, keep their volumes and folders; what to print. FORCE
     * as for stop.
     * @param {{ force?: boolean }} [options]
     */
    remove({ force = false } = {}) {
        try {
            this.#checkNotAVm();
            const { name, container, vm } = this;
            if (!container.exists && !vm) throw new SandboxError(`${name} has no container or VM to remove`);
            if (container.exists) this.#checkOurs('rm', force);
            let settings = null;
            try {
                settings = readSettings(this.dir);
            } catch {
                // no config folder left: nothing more to say
            }
            const volumes = [...new Set([...container.volumes(), ...(vm?.volumes() ?? [])])];
            const done = [];
            if (vm) {
                vm.remove();
                done.push(`removed ${name}'s VM`);
            }
            if (container.exists) {
                container.remove();
                done.push(`removed ${name}`);
            }
            const what = container.exists && vm ? 'the container and its VM were' : container.exists ? 'the container was' : 'the VM was';
            return [
                ...done,
                ...volumes.map((volume) => `kept volume ${volume}, with what's in it (e.g. the home, podman's images `
                    + `inside): podman volume rm ${volume} removes it`),
                ...(settings ? [`${settings.workspace} is untouched: only ${what} removed`] : []),
                ...(this.kind === 'vm' ? [`${name} stays a VM sandbox: 'sandbox enter ${name}' makes its VM again `
                    + `('sandbox enter --container ${name}' makes it a container)`] : []),
            ].join('\n');
        } finally {
            this.release();
        }
    }

    /** sandbox inspect: how it runs, or, without a container, what's left of it; and its VM. */
    describe() {
        const { name, container, vm } = this;
        if (this.vmOf) {
            return `# ${name} is the VM of ${this.vmOf} (podman exec, and so the measurements inside, can't reach a VM): `
                + `see sandbox inspect ${this.vmOf}\n\n${container.describe()}`;
        }
        const parts = [];
        if (container.exists) {
            const { folder } = container;
            parts.push(container.describe({ untrusted: folder ? untrustedChange(folder) : null }));
        } else {
            const folder = this.record?.folder || join(sandboxDir(), name);
            if (hasConfig(folder)) {
                // Removed with sandbox rm, or not created yet: what's left of it.
                const what = this.kind === 'vm' ? 'its VM' : 'it';
                parts.push(`# ${name} has no container (removed, or not created yet)${vm ? ', only its VM'
                    : `; sandbox enter ${name} creates ${what} from its config`}.\n${table(removedSandbox(folder).rows)}`);
            } else if (!vm) {
                throw new SandboxError(`no container '${name}', and no sandbox config in ${folder}`);
            }
        }
        if (vm) parts.push(`# ${name}'s VM: ${vm.describe()}`);
        else if (this.kind === 'vm') parts.push(`# ${name} is a VM sandbox: 'sandbox enter ${name}' makes its VM`);
        return parts.join('\n\n');
    }

    /** What enterPlan needs to know. @returns {EnterState} */
    #state() {
        const { name, container, vm } = this;
        const taken = vm ? null : inspectContainer(vmName(name));
        return {
            name,
            container: { exists: container.exists, active: container.active, created: madeAt(container.info?.Created ?? '') },
            vm: { exists: vm !== null, active: vm?.active ?? false },
            nameTaken: taken !== null && taken.Config?.Labels?.[VM_OF_LABEL] !== name,
        };
    }

    /** @param {EnterAction} plan */
    #refuseIf(plan) {
        if (plan.action === 'refuse') throw new SandboxError(plan.why);
    }

    /**
     * sandbox enter --vm, up to the shell: the checks of sandbox enter (R2), enterPlan, and what it says.
     * Returns the VM to attach to.
     * @param {boolean} fromExisting
     */
    #enterVm(fromExisting) {
        const { name } = this;
        const dir = this.dir;
        checkTrusted(name, dir);
        // Before reading the config: no krun or KVM is the cheapest refusal.
        const host = checkHost();
        if (!host.allowed) throw new SandboxError(host.reason);
        const config = readConfiguration(dir);
        const plan = enterPlan(this.#state(), { vm: true, fromExisting, policy: vmPolicy(config.merged), host });
        // A VM sandbox from here on, also if what follows fails: the next enter tries again as a VM.
        if (plan.action !== 'refuse' && this.record?.kind !== 'vm') writeRecord(name, { kind: 'vm', folder: dir });
        switch (plan.action) {
        case 'refuse':
            throw new SandboxError(plan.why);
        case 'open':
        case 'start': {
            const vm = /** @type {Vm} */ (this.vm);
            // A repo added to the workspace after the VM was made would be writable inside it.
            checkWorkspace(name, dir, vm.readonlyMounts());
            if (plan.action === 'start') {
                this.#checkContainerInactive();
                vm.start();
            }
            return vm;
        }
        case 'makeVm': {
            let { merged } = config;
            if (plan.createFirst) {
                this.#start();
                try {
                    this.container.stop();
                } catch (err) {
                    throw new SandboxError(`${name}'s container was made, but stopping it (to make the VM) failed: `
                        + `${/** @type {Error} */ (err).message}\nIt's running: 'sandbox stop ${name}', then try again`);
                }
                this.reload();
                // Now with the image: Features and image metadata can add lifecycle commands.
                merged = readConfiguration(dir).merged;
                const policy = vmPolicy(merged);
                if (!policy.allowed) {
                    throw new SandboxError(`${name} can't run as a VM: ${policy.reason}. Its container stays (stopped): `
                        + `'sandbox enter ${name}' uses it as a container`);
                }
            } else {
                checkWorkspace(name, dir, this.container.readonlyMounts());
            }
            this.#checkContainerInactive();
            return Vm.makeFrom(this.container, { workdir: config.workdir, env: vmEnv(merged) });
        }
        default:
            throw new Error(`unknown plan ${JSON.stringify(/** @type {never} */ (plan))}`);
        }
    }

    /**
     * Just before starting or making the VM: the normal container must not be active. The lock keeps
     * sandbox commands apart; VS Code and plain podman start don't take it.
     */
    #checkContainerInactive() {
        const now = Container.load(this.name);
        if (now.active) throw new SandboxError(`${this.name} runs as a normal container now: 'sandbox stop ${this.name}' first`);
    }

    /**
     * Make the container running, after the checks: an --inplace sandbox's project config must be the
     * one trusted (and the config that runs is made again before creating the container: a newer
     * sandbox's settings apply without a new trust), the config's minVersion, and the git protection
     * of a --workspace sandbox, against the mounts of the container when it exists.
     */
    #start() {
        const { name, container } = this;
        const dir = this.dir;
        const inplace = checkTrusted(name, dir);
        if (inplace && !container.exists) writeEffective(dir, inplace);
        if (!container.exists) checkConfigVersion(dir);
        checkWorkspace(name, dir, container.exists ? container.readonlyMounts() : null);
        container.start();
        this.reload();
    }

    /** The container named NAME is another sandbox's VM: refuse to treat it as sandbox NAME, also with --force. */
    #checkNotAVm() {
        if (this.vmOf) {
            throw new SandboxError(`${this.name} is the VM of ${this.vmOf}, not a sandbox: use sandbox stop, rm or `
                + `enter --vm on ${this.vmOf}`);
        }
    }

    /**
     * Refuse to SUB (stop, rm) a container without the sandbox label, unless FORCE.
     * @param {string} sub
     * @param {boolean} force
     */
    #checkOurs(sub, force) {
        const { name, container } = this;
        if (force || !container.exists) return;
        const found = container.sandbox;
        if (found.reason) return;
        const why = found.hint
            ? `${found.hint[0].toUpperCase()}${found.hint.slice(1)}, so it may be a sandbox made before 0.6.0, `
                + 'or a container another tool (VS Code) made there.'
            : 'It may be VS Code\'s or your own.';
        throw new SandboxError(`${name} isn't a sandbox: it has no ${SANDBOX_LABEL} label. ${why}\n`
            + `Check it with sandbox inspect ${name}. To ${sub} it anyway: sandbox ${sub} --force ${name} `
            + `(or podman ${sub} ${name}).`
            + (found.hint ? ' A sandbox made before 0.6.0 gets the label when made again with sandbox new.' : ''));
    }
}

/**
 * The config in DIR as the Dev Containers CLI reads it, merged with what Features and the image add:
 * { merged, workdir }. WORKDIR: the folder the shell starts in, the config's workspaceFolder.
 * @param {string} dir
 */
function readConfiguration(dir) {
    const result = dc('read-configuration', ['--workspace-folder', dir, '--include-merged-configuration'],
        { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) {
        throw new SandboxError(`can't read the config in ${dir}: ${String(result.stderr).trim().split('\n').pop()}`);
    }
    const out = JSON.parse(String(result.stdout));
    return { merged: out.mergedConfiguration ?? out.configuration, workdir: out.workspace?.workspaceFolder || '/workspace' };
}

/**
 * The VM's environment: the config's remoteEnv, which the Dev Containers CLI sets for every exec (the
 * VM has no exec, so it's set when the VM is made). A value that names the container's environment
 * (${containerEnv:…}) can't be known before it runs, and is left out. Without a remoteEnv: TERM, USER
 * and LOGNAME (from the user database when unset).
 * @param {Record<string, any>} config
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Record<string, string>}
 */
export function vmEnv(config, env = childEnv()) {
    const remote = config.remoteEnv;
    if (remote && typeof remote === 'object') {
        return Object.fromEntries(Object.entries(remote).filter(([, value]) => typeof value === 'string' && !value.includes('${')));
    }
    const user = env.USER ?? '';
    return { TERM: env.TERM || 'xterm-256color', ...(user ? { USER: user, LOGNAME: user } : {}) };
}

/** sandbox list: the dev containers and the sandboxes' VMs, by sandbox name, as a table. */
export function listSandboxes() {
    const ps = (/** @type {string} */ filter, /** @type {string} */ last) => {
        const result = podman(['ps', '-a', '--filter', `label=${filter}`, '--format',
            `{{.Names}}\t{{.State}}\t{{.Networks}}\t{{.Label "${last}"}}`]);
        if (result.status !== 0) throw new SandboxError(result.stderr.trim());
        return result.stdout.split('\n').filter(Boolean).map((line) => line.split('\t'));
    };
    const containers = ps('devcontainer.local_folder', 'devcontainer.local_folder').map((row) => ({ sandbox: row[0], vm: 0, row }));
    const vms = ps(VM_OF_LABEL, VM_OF_LABEL)
        .map(([name, state, networks, of]) => ({ sandbox: of, vm: 1, row: [name, state, networks, `VM of ${of}`] }));
    const rows = [...containers, ...vms]
        .sort((a, b) => a.sandbox.localeCompare(b.sandbox) || a.vm - b.vm)
        .map(({ row }) => row);
    return table([['NAME', 'STATE', 'NETWORK', 'FOLDER'], ...rows]);
}

/**
 * sandbox list --removed: config folders in $SANDBOX_DIR that no container or VM uses (removed with
 * sandbox rm, or never entered), with the volumes they keep. Sandboxes whose config folder is
 * elsewhere can't be found once their container is gone.
 */
export function listRemoved() {
    const result = podman(['ps', '-a', '--format', `{{.Label "devcontainer.local_folder"}}\t{{.Label "${VM_OF_LABEL}"}}`]);
    if (result.status !== 0) throw new SandboxError(result.stderr.trim());
    const used = new Set();
    for (const line of result.stdout.split('\n').filter(Boolean)) {
        const [folder, vmOf] = line.split('\t').map((s) => (s === '<no value>' ? '' : s));
        if (folder) used.add(folder);
        // A VM has no devcontainer.* labels: its sandbox's record says where its folder is.
        const recorded = vmOf ? readRecord(vmOf)?.folder : '';
        if (recorded) used.add(recorded);
    }
    const dir = sandboxDir();
    const folders = existsSync(dir) ? readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && hasConfig(join(dir, e.name)) && !used.has(join(dir, e.name)))
        .map((e) => join(dir, e.name)).sort() : [];
    const rows = [['NAME', 'KIND', 'WORKSPACE', 'KEPT VOLUMES']];
    for (const folder of folders) {
        const { settings, volumes } = removedSandbox(folder);
        const kept = volumes.filter((v) => v.bytes !== null).map((v) => `${v.name} (${formatBytes(v.bytes)})`);
        const kind = readRecord(basename(folder))?.kind === 'vm' ? 'VM' : 'container';
        rows.push([basename(folder), kind, settings?.workspace ?? folder, kept.join(', ') || 'none']);
    }
    return rows.length > 1 ? table(rows) : `no removed sandboxes in ${dir}`;
}

/**
 * What's left of the sandbox in config folder FOLDER without its container: { settings, volumes, rows }.
 * @param {string} folder
 */
function removedSandbox(folder) {
    let settings = null;
    /** @type {{ name: string, bytes: number | null }[]} */
    let volumes = [];
    try {
        settings = readSettings(folder);
        volumes = configVolumes(readConfig(configFile(folder)), folder, childEnv())
            .map((/** @type {string} */ name) => ({ name, bytes: volumeBytes(name) }));
    } catch {
        // an unreadable sandbox.json or config: show what there is
    }
    const untrusted = settings?.inplace ? untrustedChange(folder) : null;
    return { settings, volumes, rows: removedRows(folder, settings, untrusted, volumes) };
}

/**
 * Bytes on disk in volume NAME, or null when it doesn't exist. `podman unshare du`: in a sandbox's
 * home volume, files of containers inside are owned by subordinate IDs that a plain du can't read.
 * @param {string} name
 */
function volumeBytes(name) {
    const mountpoint = podman(['volume', 'inspect', '--format', '{{.Mountpoint}}', name]);
    if (mountpoint.status !== 0) return null;
    const du = podman(['unshare', 'du', '-sk', mountpoint.stdout.trim()]);
    const kb = Number(du.stdout.split('\t')[0]);
    return Number.isFinite(kb) && du.stdout ? kb * 1024 : 0;
}

/**
 * Before creating NAME's container or image from the config in DIR: refuse when its marker asks for
 * a newer sandbox (minVersion), e.g. after installing an older release. A container that exists was
 * made already, and keeps running.
 * @param {string} dir
 */
function checkConfigVersion(dir) {
    const file = configFile(dir);
    if (!existsSync(file)) return;
    let config = null;
    try {
        config = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return;   // not plain JSON: the Dev Containers CLI reads it (JSONC) and has the last word
    }
    checkMinVersion(config, file);
}

/**
 * For a sandbox made with --workspace: refuse to start if a git repo in the workspace would have
 * writable hooks or config inside. Repos get added or moved after the sandbox was made. A container
 * (or VM) keeps the mounts it was created with, so check those (READONLY, its read-only mounts) when
 * it exists, else (null) the config.
 * @param {string} name
 * @param {string} dir
 * @param {string[] | null} readonly
 */
function checkWorkspace(name, dir, readonly) {
    const settings = readSettings(dir);
    if (!settings) return;
    const missing = uncoveredInSandbox(dir, readonly);
    if (missing.length === 0) return;
    const redo = readonly ? `sandbox rm ${name}; ` : '';
    throw new SandboxError(`these would be writable inside ${name}, and git on the host runs what they name:\n`
        + missing.map((/** @type {string} */ path) => `  ${path}\n`).join('')
        + `Make the sandbox again (the options are in ${join(dir, 'sandbox.json')}):\n`
        + `  ${redo}rm -r ${dir}; sandbox new ${name} --template ... --workspace ${settings.workspace} ...`);
}

/**
 * For an --inplace sandbox (in DIR): refuse when the project's config isn't the one the user trusted,
 * offering the diff. Returns its settings, or null for other sandboxes.
 * @param {string} name
 * @param {string} dir
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
 * For an --inplace sandbox in FOLDER: how its project's config differs from the trusted one, or null.
 * @param {string} folder
 */
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
