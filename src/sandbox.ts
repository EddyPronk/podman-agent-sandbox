// A sandbox as the commands see it: its config folder and what podman has of it, a normal container,
// a VM, or both. The middle layer between the commands (cli.ts) and the containers (container.ts,
// vm.ts): the commands call one method of a Sandbox, and the Sandbox decides what that means for its
// container and VM, and runs the checks first (the --inplace trust, the git protection, the config's
// version). The only layer that knows a sandbox may have both.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { featureArgs } from './features.js';
import { Container, describeInfo, inspectContainer, isActive } from './container.js';
import type { PodmanInfo } from './container.js';
import {
    SANDBOX_LABEL, SandboxError, checkName, childEnv, dc, exitStatus, folderOf, hasConfig, podman, sandboxDir,
} from './devcontainer.js';
import { ask, configChange, short, writeEffective } from './inplace.js';
import { configVolumes, formatBytes, removedRows, table } from './inspect.js';
import { lockSandbox } from './lock.js';
import { isObject } from './json.js';
import type { JsonObject } from './json.js';
import type { Release } from './lock.js';
import { readRecord, recordPath, removeRecord, writeRecord } from './state.js';
import type { Kind, StateRecord } from './state.js';
import {
    ROOT_SHELL, ROOT_SHELL_CAPS, checkMinVersion, configPolicies, policyConfig, policyProblem, withPolicies,
} from './templates.js';
import { VM_OF_LABEL, Vm, checkHost, madeAt, vmName, vmPolicy } from './vm.js';
import type { Answer } from './vm.js';
import { configFile, gitStateInSandbox, isGitReadonly, readConfig, readSettings, uncoveredInSandbox, uncoveredWhy } from './workspace.js';
import type { DevcontainerConfig, MountView, Settings } from './workspace.js';
import type { Row, VolumeSize } from './inspect.js';

const ALLOWED: Answer = { allowed: true };

/** The config a container is made from when a policy changes it: next to devcontainer.json, only while made. */
const POLICY_OVERRIDE = '.sandbox-made-from.json';

/**
 * Sandbox NAME as it is now. With LOCK, take its lock first (sandbox enter, exec, stop and rm: the
 * commands that change it), then read the state, so the state read is the one the command acts on.
 */
export function loadSandbox(name: string, { lock = false }: { lock?: boolean } = {}): Sandbox {
    checkName(name);
    const release: Release = lock ? lockSandbox(name) : () => {};
    let sandbox: Sandbox | undefined;
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
 * whose), its VM, found by its label, and its record (state.ts).
 */
function readState(name: string): { container: Container; vmOf: string; vm: Vm | null; record: StateRecord | null } {
    const container = Container.load(name);
    const vmOf = container.labels[VM_OF_LABEL] ?? '';
    return { container, vmOf, vm: vmOf ? null : Vm.find(name), record: vmOf ? null : readRecord(name) };
}

/** What enterPlan decides from. */
export interface EnterState {
    name: string;
    /** The normal container. */
    container: { exists: boolean; active: boolean; created: string };
    vm: { exists: boolean; active: boolean };
    /** A container named NAME-vm exists that isn't NAME's VM. */
    nameTaken: boolean;
}

/**
 * What sandbox enter does: open (start if needed, then a shell in) the container or the VM, start the
 * VM, make the VM (CREATE_FIRST: the normal container first), or refuse.
 */
export type EnterAction = { action: 'open'; target: 'container' | 'vm' } | { action: 'start' }
    | { action: 'makeVm'; createFirst: boolean } | { action: 'refuse'; why: string };

/** The config as the Dev Containers CLI reads it: see readConfiguration. */
export interface Configuration {
    merged: JsonObject;
    workdir: string;
}

/**
 * sandbox enter's decision (PLAN.md, Behaviour), from the state alone. VM: --vm; FROM_EXISTING:
 * --from-existing; POLICY: vmPolicy's answer for the config; HOST: checkHost's.
 */
export function enterPlan(state: EnterState, { vm = false, fromExisting = false, policy = ALLOWED, host = ALLOWED }: {
    vm?: boolean; fromExisting?: boolean; policy?: Answer; host?: Answer;
} = {}): EnterAction {
    const { name } = state;
    const refuse = (why: string): EnterAction => ({ action: 'refuse', why });
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

/** What sandbox enter --root decides from. */
export interface RootState {
    name: string;
    /**
     * A container exists; whether sandbox made it (the label); whether its root has what apt needs
     * (ROOT_SHELL_CAPS: made with root-shell, or from a template like nested-containers).
     */
    container: { exists: boolean; ours: boolean; rootHasCaps: boolean };
    /** The config lists root-shell (read only when there is no container). */
    configHasPolicy: boolean;
    /** The config is the project's own (--inplace): sandbox doesn't write it. */
    inplace: boolean;
}

/**
 * sandbox enter --root's decision: open the root shell (after making the container, if there's none),
 * first adding the root-shell policy to the config (addPolicy), or refuse.
 */
export type RootAction = { action: 'open'; addPolicy: boolean } | { action: 'refuse'; why: string };

export function rootPlan(state: RootState): RootAction {
    const { name } = state;
    if (state.container.exists) {
        if (!state.container.ours) {
            return {
                action: 'refuse',
                why: `${name} isn't a sandbox: its container has no ${SANDBOX_LABEL} label. It may be VS Code's or your `
                    + `own. Check it with sandbox inspect ${name}`,
            };
        }
        if (state.container.rootHasCaps) return { action: 'open', addPolicy: false };
        return {
            action: 'refuse',
            why: `${name}'s container was made without the ${ROOT_SHELL} policy: root there lacks the capabilities apt `
                + 'needs. The policy applies when the container is made: '
                + `'sandbox rm ${name}' (volumes are kept), then 'sandbox enter --root ${name}'`,
        };
    }
    if (state.configHasPolicy) return { action: 'open', addPolicy: false };
    if (state.inplace) {
        return {
            action: 'refuse',
            why: `${name} uses the project's own config (--inplace), which sandbox doesn't change: add "${ROOT_SHELL}" to `
                + `its "policies" ("customizations": {"podman-agent-sandbox": …}), then 'sandbox trust ${name}' and `
                + `'sandbox enter --root ${name}'`,
        };
    }
    return { action: 'open', addPolicy: true };
}

export class Sandbox {
    name: string;
    /** Releases the lock, if taken. */
    release: () => void;
    /** The container named NAME, unless it's another sandbox's VM (vmOf). */
    container: Container;
    /** The sandbox whose VM the container named NAME is, or ''. */
    vmOf: string;
    vm: Vm | null;
    record: StateRecord | null;

    constructor(name: string, release: () => void) {
        this.name = name;
        this.release = release;
        const now = readState(name);
        this.container = now.container;
        this.vmOf = now.vmOf;
        this.vm = now.vm;
        this.record = now.record;
    }

    /** Read the state again, after a step that changed it. */
    reload(): void {
        const now = readState(this.name);
        this.container = now.container;
        this.vmOf = now.vmOf;
        this.vm = now.vm;
        this.record = now.record;
    }

    /**
     * What the sandbox is: 'vm' or 'container'. Its record says (sandbox new --vm, enter --vm, enter
     * --container), and a VM sandbox stays one after sandbox rm. Without a record: a VM if it has one.
     */
    get kind(): Kind {
        return this.record?.kind ?? (this.vm ? 'vm' : 'container');
    }

    /** The sandbox's config folder: the container's label, the record's, or $SANDBOX_DIR/NAME; refuses when there's none. */
    get dir(): string {
        return folderOf(this.name, { lookup: () => this.container.folder || this.record?.folder || '' });
    }

    /** Whether the sandbox has a container or a VM, running or not: made from an older config or image. */
    made(): boolean {
        return this.container.exists || this.vm !== null;
    }

    /** Whether there is such a sandbox: a container, a VM, a record or a config folder. */
    known(): boolean {
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
     */
    enter({ kind = null, fromExisting = false, root = false }: { kind?: Kind | null; fromExisting?: boolean; root?: boolean } = {}): number {
        if (root) return this.#enterRoot();
        let target: Container | Vm;
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
     */
    exec(command: string[]): number {
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
     * ARGS are passed on to devcontainer build (--no-cache).
     */
    build(args: string[]): number {
        this.#checkNotAVm();
        const dir = this.dir;
        const inplace = checkTrusted(this.name, dir);
        if (inplace) writeEffective(dir, inplace);
        checkConfigVersion(dir);
        const result = dc('build', ['--workspace-folder', dir, ...featureArgs(dir), ...args]);
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
     */
    stop({ force = false }: { force?: boolean } = {}): string {
        try {
            this.#checkNotAVm();
            const { name, container, vm } = this;
            if (!container.exists && !vm) throw new SandboxError(`${name} has no container or VM to stop`);
            const done: string[] = [];
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
     */
    remove({ force = false }: { force?: boolean } = {}): string {
        try {
            this.#checkNotAVm();
            const { name, container, vm } = this;
            if (!container.exists && !vm) throw new SandboxError(`${name} has no container or VM to remove`);
            if (container.exists) this.#checkOurs('rm', force);
            let settings: Settings | null = null;
            try {
                settings = readSettings(this.dir);
            } catch {
                // no config folder left: nothing more to say
            }
            const volumes = [...new Set([...container.volumes(), ...(vm?.volumes() ?? [])])];
            const done: string[] = [];
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
                ...volumes.map((volume) => keptVolume(name, volume)),
                ...(settings ? [`${settings.workspace} is untouched: only ${what} removed`] : []),
                ...(this.kind === 'vm' ? [`${name} stays a VM sandbox: 'sandbox enter ${name}' makes its VM again `
                    + `('sandbox enter --container ${name}' makes it a container)`] : []),
            ].join('\n');
        } finally {
            this.release();
        }
    }

    /**
     * sandbox inspect: how it runs, or, without a container, what's left of it. With a VM: how the VM
     * runs, then the container it was made from. Of a VM's name: its sandbox's.
     */
    describe(): string {
        const { name, container, vm } = this;
        if (this.vmOf && this.vmOf !== name) {
            return `# ${name} is the VM of ${this.vmOf}: this is sandbox inspect ${this.vmOf}.\n\n${loadSandbox(this.vmOf).describe()}`;
        }
        if (vm) return this.#describeVm(vm);
        const parts: string[] = [];
        if (container.exists) {
            const { folder } = container;
            parts.push(container.describe({ untrusted: folder ? untrustedChange(folder) : null }));
        } else {
            const folder = this.record?.folder || join(sandboxDir(), name);
            if (!hasConfig(folder)) throw new SandboxError(`no container '${name}', and no sandbox config in ${folder}`);
            // Removed with sandbox rm, or not created yet: what's left of it.
            const what = this.kind === 'vm' ? 'its VM' : 'it';
            parts.push(`# ${name} has no container (removed, or not created yet); sandbox enter ${name} creates ${what} `
                + `from its config.\n${table(removedSandbox(folder).rows)}`);
        }
        if (this.kind === 'vm') parts.push(`# ${name} is a VM sandbox: 'sandbox enter ${name}' makes its VM`);
        return parts.join('\n\n');
    }

    /**
     * sandbox inspect of a sandbox with VM: how the VM runs (what enter opens), as configured, since
     * podman exec can't reach into a VM; then the normal container it was made from, if it's still there.
     */
    #describeVm(vm: Vm): string {
        const { name, container, record } = this;
        const folder = record?.folder || container.folder;
        const why = [container.sandbox.reason, record ? `record ${recordPath(name)}` : ''].filter(Boolean).join(', ');
        // The VM's container name (NAME-vm) is podman's, not the user's: only its command shows it.
        const header = `# ${name} is a VM sandbox${why ? ` (${why})` : ''}: sandbox enter ${name} opens its VM.`;
        const parts = [describeInfo(vm.containerName, vm.info, {
            header, sandbox: true, folder, untrusted: folder ? untrustedChange(folder) : null,
            unmeasured: 'podman exec can\'t reach into a VM', of: name, title: `${name}'s VM`,
        })];
        const made = (info: PodmanInfo | null) => (info?.Created ? ` ${madeAt(info.Created)}` : '');
        const lines = [`# The VM was made${made(vm.info)} from ${name}'s container as it was then; to make it again: `
            + `sandbox rm ${name}, then sandbox enter ${name}`];
        if (container.exists) {
            lines.push(`# ${name}'s container (it built the image and ran the lifecycle commands; enter opens the VM, `
                + `never the container): ${container.state}${made(container.info) && `, made${made(container.info)}`}`);
            if (container.active) {
                lines.push(`warning: ${name}'s container runs: the VM can't start while it does, and both would use the same `
                    + `volumes; 'sandbox stop ${name}' stops it`);
            }
        } else {
            lines.push(`# ${name} has no container left, only its VM`);
        }
        parts.push(lines.join('\n'));
        return parts.join('\n\n');
    }

    /**
     * sandbox enter --root: a root shell in the container, which must be made with the root-shell
     * policy. Without a container (after sandbox new or rm), add the policy to the config first, and
     * say so; with one made without it, refuse (rootPlan).
     */
    #enterRoot(): number {
        try {
            this.#checkNotAVm();
            const { name, container } = this;
            if (this.vm || (this.kind === 'vm' && container.exists)) {
                // A VM sandbox with nothing made (after new --vm, or rm) becomes a container sandbox below.
                throw new SandboxError(`${name} is a VM sandbox: enter --root opens a root shell in a container. `
                    + `'sandbox rm ${name}' (volumes are kept), then 'sandbox enter --root ${name}' makes it a container sandbox`);
            }
            const dir = this.dir;
            const file = configFile(dir);
            let config: DevcontainerConfig | null = null;
            if (!container.exists) {
                checkConfigVersion(dir);   // before writing to the config
                if (!existsSync(file)) throw new SandboxError(`${name} has no ${file}: enter --root needs that config`);
                config = readConfig(file);
            }
            const plan = rootPlan({
                name,
                container: { exists: container.exists, ours: Boolean(container.sandbox.reason), rootHasCaps: container.rootHasCaps },
                configHasPolicy: config !== null && configPolicies(config).includes(ROOT_SHELL),
                inplace: Boolean(readSettings(dir)?.inplace),
            });
            if (plan.action === 'refuse') throw new SandboxError(plan.why);
            if (plan.addPolicy && config) {
                const updated = withPolicies(config, [ROOT_SHELL]);
                const problem = policyProblem(updated);
                if (problem) throw new SandboxError(`${name}: ${problem}, and ${file} has none`);
                writeFileSync(file, `${JSON.stringify(updated, null, 2)}\n`);
                console.error(`sandbox: ${name}: added the ${ROOT_SHELL} policy to ${file}. When its container is made, root `
                    + `gets what apt needs (${ROOT_SHELL_CAPS.map((cap) => cap.slice(4).toLowerCase()).join(', ')}); `
                    + 'no-new-privileges keeps them from your programs and the agent\'s. sandbox inspect shows it');
            }
            if (!container.exists && this.record?.kind === 'vm') removeRecord(name);   // a container sandbox from now on
            this.#start();
            if (!this.container.rootHasCaps) {
                const caps = this.container.info?.BoundingCaps ?? [];
                throw new SandboxError(`${name}'s container was made, but root lacks what apt needs (it has: `
                    + `${caps.join(', ') || 'none'}). Check the runArgs in ${file}`);
            }
        } finally {
            this.release();
        }
        return this.container.openRootShell();
    }

    /** What enterPlan needs to know. */
    #state(): EnterState {
        const { name, container, vm } = this;
        const taken = vm ? null : inspectContainer(vmName(name));
        return {
            name,
            container: { exists: container.exists, active: container.active, created: madeAt(container.info?.Created ?? '') },
            vm: { exists: vm !== null, active: vm?.active ?? false },
            nameTaken: taken !== null && taken.Config?.Labels?.[VM_OF_LABEL] !== name,
        };
    }

    #refuseIf(plan: EnterAction): void {
        if (plan.action === 'refuse') throw new SandboxError(plan.why);
    }

    /**
     * sandbox enter --vm, up to the shell: the checks of sandbox enter (R2), enterPlan, and what it says.
     * Returns the VM to attach to.
     */
    #enterVm(fromExisting: boolean): Vm {
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
            const { vm } = this;
            if (!vm) throw new Error(`enterPlan said ${plan.action} without a VM`);   // a bug in sandbox
            // A repo added to the workspace after the VM was made would be writable inside it.
            checkWorkspace(name, dir, vm.mountView());
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
                        + `${err instanceof Error ? err.message : err}\nIt's running: 'sandbox stop ${name}', then try again`);
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
                checkWorkspace(name, dir, this.container.mountView());
            }
            this.#checkContainerInactive();
            return Vm.makeFrom(this.container, { workdir: config.workdir, env: vmEnv(merged) });
        }
        default:
            throw new Error(`unknown plan ${JSON.stringify(plan satisfies never)}`);
        }
    }

    /**
     * Just before starting or making the VM: the normal container must not be active. The lock keeps
     * sandbox commands apart; VS Code and plain podman start don't take it.
     */
    #checkContainerInactive(): void {
        const now = Container.load(this.name);
        if (now.active) throw new SandboxError(`${this.name} runs as a normal container now: 'sandbox stop ${this.name}' first`);
    }

    /**
     * Make the container running, after the checks: an --inplace sandbox's project config must be the
     * one trusted (and the config that runs is made again before creating the container: a newer
     * sandbox's settings apply without a new trust), the config's minVersion, and the git protection
     * of a --workspace sandbox, against the mounts of the container when it exists.
     */
    #start(): void {
        const { name, container } = this;
        const dir = this.dir;
        const inplace = checkTrusted(name, dir);
        if (inplace && !container.exists) writeEffective(dir, inplace);
        if (!container.exists) checkConfigVersion(dir);
        checkWorkspace(name, dir, container.exists ? container.mountView() : null, () => container.liveMountView());
        const override = container.exists ? null : writePolicyOverride(name, dir);
        try {
            container.start(override);
        } finally {
            if (override) rmSync(override, { force: true });
        }
        this.reload();
    }

    /** The container named NAME is another sandbox's VM: refuse to treat it as sandbox NAME, also with --force. */
    #checkNotAVm(): void {
        if (this.vmOf) {
            throw new SandboxError(`${this.name} is the VM of ${this.vmOf}, not a sandbox: use sandbox stop, rm or `
                + `enter --vm on ${this.vmOf}`);
        }
    }

    /**
     * Refuse to SUB (stop, rm) a container without the sandbox label, unless FORCE.
     */
    #checkOurs(sub: string, force: boolean): void {
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
 */
function readConfiguration(dir: string): Configuration {
    const result = dc('read-configuration', ['--workspace-folder', dir, '--include-merged-configuration', ...featureArgs(dir)],
        { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) {
        throw new SandboxError(`can't read the config in ${dir}: ${String(result.stderr).trim().split('\n').pop()}`);
    }
    return parseConfiguration(String(result.stdout), dir);
}

/**
 * devcontainer read-configuration's output (TEXT) for the config in DIR: { merged, workdir } as
 * readConfiguration gives them. Refuses output without a configuration: vmPolicy and vmEnv read it.
 */
export function parseConfiguration(text: string, dir: string): Configuration {
    const out: unknown = JSON.parse(text);
    const merged = isObject(out) ? out.mergedConfiguration ?? out.configuration : undefined;
    if (!isObject(out) || !isObject(merged)) {
        throw new SandboxError(`devcontainer read-configuration gave output sandbox doesn't expect for ${dir}: no configuration`);
    }
    const folder = isObject(out.workspace) ? out.workspace.workspaceFolder : undefined;
    return { merged, workdir: typeof folder === 'string' && folder ? folder : '/workspace' };
}

/**
 * The VM's environment: the config's remoteEnv, which the Dev Containers CLI sets for every exec (the
 * VM has no exec, so it's set when the VM is made). A value that names the container's environment
 * (${containerEnv:…}) can't be known before it runs, and is left out. Without a remoteEnv: TERM, USER
 * and LOGNAME (from the user database when unset).
 */
export function vmEnv(config: JsonObject, env: NodeJS.ProcessEnv = childEnv()): { [key: string]: string } {
    const remote = config.remoteEnv;
    if (isObject(remote)) {
        return Object.fromEntries(Object.entries(remote)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !entry[1].includes('${')));
    }
    const user = env.USER ?? '';
    return { TERM: env.TERM || 'xterm-256color', ...(user ? { USER: user, LOGNAME: user } : {}) };
}

/**
 * sandbox list: one row per sandbox, from the dev containers and the sandboxes' VMs, as a table. A VM
 * sandbox's row is its VM's (what enter opens); COMMENT says what else there is to know, as a list.
 */
export function listSandboxes(): string {
    const ps = (filter: string, last: string) => {
        const result = podman(['ps', '-a', '--filter', `label=${filter}`, '--format',
            `{{.Names}}\t{{.State}}\t{{.Networks}}\t{{.Label "${last}"}}`]);
        if (result.status !== 0) throw new SandboxError(result.stderr.trim());
        return result.stdout.split('\n').filter(Boolean).map((line) => line.split('\t'));
    };
    const sandboxes = new Map<string, { state: string; networks: string; folder: string; comment: string[] }>();
    for (const [name, state, networks, folder] of ps('devcontainer.local_folder', 'devcontainer.local_folder')) {
        const vm = readRecord(name)?.kind === 'vm';
        sandboxes.set(name, { state, networks, folder, comment: vm ? ['vm', 'no VM yet'] : [] });
    }
    for (const [, state, networks, of] of ps(VM_OF_LABEL, VM_OF_LABEL)) {
        const container = sandboxes.get(of);
        const comment = ['vm', ...(container && isActive(container.state) ? ['container running'] : [])];
        sandboxes.set(of, { state, networks, folder: container?.folder || readRecord(of)?.folder || '', comment });
    }
    const rows = [...sandboxes].sort(([a], [b]) => a.localeCompare(b))
        .map(([name, s]) => [name, s.state, s.networks, s.folder, s.comment.join(', ')]);
    return table([['NAME', 'STATE', 'NETWORK', 'FOLDER', 'COMMENT'], ...rows]);
}

/**
 * sandbox list --all: listSandboxes, then the sandboxes without a container (listWithoutContainer).
 */
export function listAll(): string {
    return `${listSandboxes()}\n\n${listWithoutContainer()}`;
}

/**
 * The second part of sandbox list --all: config folders in $SANDBOX_DIR that no container or VM uses
 * (made with sandbox new and not entered yet, or removed with sandbox rm), with the volumes they keep.
 * Sandboxes whose config folder is elsewhere can't be found once their container is gone.
 */
export function listWithoutContainer(): string {
    const result = podman(['ps', '-a', '--format', `{{.Label "devcontainer.local_folder"}}\t{{.Label "${VM_OF_LABEL}"}}`]);
    if (result.status !== 0) throw new SandboxError(result.stderr.trim());
    const used = new Set<string>();
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
        const kept = volumes.flatMap((v) => (v.bytes === null ? [] : [`${v.name} (${formatBytes(v.bytes)})`]));
        const kind = readRecord(basename(folder))?.kind === 'vm' ? 'VM' : 'container';
        rows.push([basename(folder), kind, settings?.workspace ?? folder, kept.join(', ') || 'none']);
    }
    const what = `without a container in ${dir} (not entered yet, or removed with sandbox rm)`;
    return rows.length > 1
        ? `Sandboxes ${what}; sandbox enter NAME creates its container:\n${table(rows)}`
        : `No sandboxes ${what}.`;
}

/**
 * What's left of the sandbox in config folder FOLDER without its container: { settings, volumes, rows }.
 */
function removedSandbox(folder: string): { settings: Settings | null; volumes: VolumeSize[]; rows: Row[] } {
    let settings: Settings | null = null;
    let volumes: VolumeSize[] = [];
    let policies: string[] | null = null;
    try {
        settings = readSettings(folder);
        const config = readConfig(configFile(folder));
        policies = configPolicies(config);
        volumes = configVolumes(config, folder, childEnv())
            .map((name) => ({ name, bytes: volumeBytes(name) }));
    } catch {
        // an unreadable sandbox.json or config: show what there is
    }
    const untrusted = settings?.inplace ? untrustedChange(folder) : null;
    return { settings, volumes, rows: removedRows(folder, settings, untrusted, volumes, policies) };
}

/**
 * What sandbox rm says about VOLUME, which NAME mounted and rm kept. NAME-home is its home, its own to
 * remove. Any other volume is shared (agent-proxy-ca: the proxy's CA, mounted by the proxy and every
 * proxy-client sandbox), so no podman volume rm for it; the containers still mounting it are named.
 */
function keptVolume(name: string, volume: string): string {
    if (volume === `${name}-home`) {
        return `kept volume ${volume}, ${name}'s home, with what's in it (e.g. podman's images inside): `
            + `podman volume rm ${volume} removes it`;
    }
    const result = podman(['ps', '-a', '--filter', `volume=${volume}`, '--format', '{{.Names}}']);
    const users = result.status === 0 ? result.stdout.split('\n').filter(Boolean) : [];
    return `kept volume ${volume}, shared: not ${name}'s own; `
        + (users.length ? `still mounted by ${users.join(', ')}` : 'other sandboxes from the same template mount it too');
}

/**
 * Bytes on disk in volume NAME, or null when it doesn't exist. `podman unshare du`: in a sandbox's
 * home volume, files of containers inside are owned by subordinate IDs that a plain du can't read.
 */
function volumeBytes(name: string): number | null {
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
 */
function checkConfigVersion(dir: string): void {
    const file = configFile(dir);
    if (!existsSync(file)) return;
    let config: unknown = null;
    try {
        config = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return;   // not plain JSON: the Dev Containers CLI reads it (JSONC) and has the last word
    }
    checkMinVersion(config, file);
}

/**
 * Before creating NAME's container from the config in DIR: when its policies change how the container
 * is made (root-shell's runArgs), write the config to make it from (policyConfig) next to it, so its
 * relative paths still resolve, and return that file's path (for --override-config; removed after).
 * Else null. The config itself stays as written. Refuse a policy the config can't have (policyProblem).
 */
function writePolicyOverride(name: string, dir: string): string | null {
    const file = configFile(dir);
    if (!existsSync(file)) return null;
    const text = readFileSync(file, 'utf8');
    let config: unknown;
    try {
        config = JSON.parse(text);
    } catch {
        if (!text.includes(`"${ROOT_SHELL}"`)) return null;   // JSONC: the CLI reads it as it is
        throw new SandboxError(`${file} lists the ${ROOT_SHELL} policy, but isn't plain JSON (comments or trailing `
            + 'commas?): sandbox reads it to apply the policy, so remove them first');
    }
    if (!isObject(config)) return null;
    const problem = policyProblem(config);
    if (problem) throw new SandboxError(`${name}: ${problem}. Add it to the runArgs in ${file}, or remove the policy`);
    const made = policyConfig(config);
    if (!made) return null;
    const out = join(dirname(file), POLICY_OVERRIDE);
    writeFileSync(out, `${JSON.stringify(made, null, 2)}\n`);
    return out;
}

/**
 * For a sandbox made with --workspace: refuse to start if a git repo in the workspace would have
 * writable hooks or config inside (or, with git-readonly, a folder above a .git that could be moved).
 * Repos get added or moved after the sandbox was made. A container (or VM) keeps the mounts it was
 * created with, so check those (CONTAINER) when it exists, else (null) the config. LIVE_MOUNTS gives
 * the mounts really there while it runs (Container.liveMountView); they count over CONTAINER, and what CONTAINER
 * covers but LIVE doesn't was lost while it ran (the host replaced or moved a protected path, or a
 * folder above one was moved inside).
 */
function checkWorkspace(name: string, dir: string, container: MountView | null,
    liveMounts: () => MountView | null = () => null): void {
    const settings = readSettings(dir);
    if (!settings) return;
    const live = liveMounts();
    const missing = uncoveredInSandbox(dir, live ?? container);
    if (missing.length === 0) {
        for (const text of gitStateInSandbox(dir)) console.error(`sandbox: warning: ${name}: ${text}`);
        return;
    }
    const neverCovered = live ? uncoveredInSandbox(dir, container) : missing;
    const lost = missing.filter((path) => !neverCovered.includes(path));
    let how = '';
    if (lost.length) {
        how += `Lost while ${name} ran: ${lost.join(', ')}. Podman still lists them, but they aren't mounted inside.\n`
            + `'sandbox stop ${name}' and enter again mounts them on what is there then, so first look at those .git\n`
            + 'folders as files (hooks, config, commondir), not with git, which runs what they name.\n';
    }
    if (missing.some((path) => !lost.includes(path))) {
        const redo = container ? `sandbox rm ${name}; ` : '';
        how += `Make the sandbox again (the options are in ${join(dir, 'sandbox.json')}):\n`
            + `  ${redo}rm -r ${dir}; sandbox new ${name} --template ... --workspace ${settings.workspace} ...\n`;
    }
    throw new SandboxError(`these aren't protected inside ${name}, and git on the host runs what a .git names:\n`
        + missing.map((path) => `  ${path}${uncoveredWhy(path, isGitReadonly(dir))}\n`).join('') + how.trimEnd());
}

/**
 * For an --inplace sandbox (in DIR): refuse when the project's config isn't the one the user trusted,
 * offering the diff. Returns its settings, or null for other sandboxes.
 */
function checkTrusted(name: string, dir: string): Settings | null {
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
 */
function untrustedChange(folder: string): string | null {
    let settings: Settings | null;
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
