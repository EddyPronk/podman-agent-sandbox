// @ts-check
// A sandbox's VM (sandbox enter --vm): its container run with krun (crun built with libkrun), so the
// processes inside run in a small KVM virtual machine with their own kernel. Made from the sandbox's
// normal container: the same podman run command (vmRunArgs), with the image it was made from. There
// is no exec into a krun guest, so the VM's main process is a login shell, reached with podman attach.
// See docs/microvm.md.
import { constants, accessSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { SANDBOX_LABEL, SandboxError, exitStatus, podman } from './devcontainer.js';
import { inspectContainer, isActive } from './container.js';
import { commandText } from './inplace.js';
import { MARKER } from './templates.js';

/** The label that makes a container sandbox NAME's VM. (Its config folder is in its record: state.js.) */
export const VM_OF_LABEL = 'podman-agent-sandbox.vm-of';

/** The policy a config uses to say it can't run as a VM. */
export const NO_VM = 'no-vm';

/** What detaches from the VM's shell: one key, as in telnet, that bash and most programs leave alone. */
export const DETACH_KEYS = 'ctrl-]';

/** The name a VM gets when made; it's found by VM_OF_LABEL, never by this name. @param {string} name */
export function vmName(name) {
    return `${name}-vm`;
}

/**
 * @typedef {{ allowed: true } | { allowed: false, reason: string }} Answer
 */

/**
 * Whether the config CONFIG (devcontainer read-configuration's `configuration`, or its
 * `mergedConfiguration`, which lists lifecycle commands from Features and image metadata too) can run
 * as a VM: not with the no-vm policy, nor with a command the VM wouldn't run (postStartCommand and
 * postAttachCommand run in the container at each start and attach; the VM has neither).
 * @param {Record<string, any>} config
 * @returns {Answer}
 */
export function vmPolicy(config) {
    // The marker is an object in a configuration, and a list of them (one per source) when merged.
    const marker = config.customizations?.[MARKER];
    const markers = Array.isArray(marker) ? marker : [marker];
    const policies = markers.flatMap((m) => (Array.isArray(m?.policies) ? m.policies : []));
    if (policies.includes(NO_VM)) return { allowed: false, reason: `this config's policies include ${NO_VM}` };
    for (const key of ['postStartCommand', 'postAttachCommand']) {
        const commands = [config[key], ...(config[`${key}s`] ?? [])].filter((c) => c && (typeof c !== 'object' || Object.keys(c).length));
        if (commands.length) {
            return { allowed: false, reason: `the VM wouldn't run its ${key} (${commandText(commands[0])}): it runs in a container at each `
                + `${key === 'postStartCommand' ? 'start' : 'attach'}` };
        }
    }
    return { allowed: true };
}

/**
 * Whether this machine can run a VM: krun on PATH, built with libkrun, and /dev/kvm usable.
 * @returns {Answer}
 */
export function checkHost() {
    const krun = spawnSync('krun', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (krun.error) {
        return { allowed: false, reason: 'krun not found on PATH: sandbox enter --vm needs crun built with libkrun, '
            + 'installed as krun (Debian doesn\'t package it; see docs/microvm.md)' };
    }
    if (!/\+LIBKRUN\b/.test(krun.stdout)) {
        return { allowed: false, reason: 'krun --version doesn\'t list +LIBKRUN: this krun can\'t run VMs (see docs/microvm.md)' };
    }
    try {
        accessSync('/dev/kvm', constants.R_OK | constants.W_OK);
    } catch {
        return { allowed: false, reason: '/dev/kvm isn\'t readable and writable for you: KVM is missing, or you\'re not in '
            + 'the group that owns it (often kvm)' };
    }
    return { allowed: true };
}

// podman run's options that take a value (podman 5.4, `podman run --help`): needed to walk the
// recorded command without taking a value for an option. Every other option must be in BOOLEAN.
const VALUE = new Set(['--add-host', '--annotation', '--arch', '-a', '--attach', '--authfile', '--blkio-weight',
    '--blkio-weight-device', '--cap-add', '--cap-drop', '--cgroup-conf', '--cgroup-parent', '--cgroupns', '--cgroups',
    '--chrootdirs', '--cidfile', '--conmon-pidfile', '--cpu-period', '--cpu-quota', '--cpu-rt-period', '--cpu-rt-runtime',
    '-c', '--cpu-shares', '--cpus', '--cpuset-cpus', '--cpuset-mems', '--decryption-key', '--detach-keys', '--device',
    '--device-cgroup-rule', '--device-read-bps', '--device-read-iops', '--device-write-bps', '--device-write-iops', '--dns',
    '--dns-option', '--dns-search', '--entrypoint', '-e', '--env', '--env-file', '--env-merge', '--expose', '--gidmap',
    '--gpus', '--group-add', '--group-entry', '--health-cmd', '--health-interval', '--health-log-destination',
    '--health-max-log-count', '--health-max-log-size', '--health-on-failure', '--health-retries', '--health-start-period',
    '--health-startup-cmd', '--health-startup-interval', '--health-startup-retries', '--health-startup-success',
    '--health-startup-timeout', '--health-timeout', '-h', '--hostname', '--hosts-file', '--hostuser', '--image-volume',
    '--init-path', '--ip', '--ip6', '--ipc', '-l', '--label', '--label-file', '--log-driver', '--log-opt', '--mac-address',
    '-m', '--memory', '--memory-reservation', '--memory-swap', '--memory-swappiness', '--mount', '--name', '--network',
    '--net', '--network-alias', '--oom-score-adj', '--os', '--passwd-entry', '--personality', '--pid', '--pidfile',
    '--pids-limit', '--platform', '--pod', '--pod-id-file', '--preserve-fd', '--preserve-fds', '-p', '--publish', '--pull',
    '--rdt-class', '--requires', '--restart', '--retry', '--retry-delay', '--runtime', '--sdnotify', '--seccomp-policy',
    '--secret', '--security-opt', '--shm-size', '--shm-size-systemd', '--stop-signal', '--stop-timeout', '--subgidname',
    '--subuidname', '--sysctl', '--systemd', '--timeout', '--tmpfs', '--tz', '--uidmap', '--ulimit', '--umask', '--unsetenv',
    '-u', '--user', '--userns', '--uts', '--variant', '-v', '--volume', '--volumes-from', '-w', '--workdir']);
const BOOLEAN = new Set(['-d', '--detach', '--disable-content-trust', '--env-host', '--http-proxy', '--init', '-i',
    '--interactive', '--no-healthcheck', '--no-hostname', '--no-hosts', '--oom-kill-disable', '--passwd', '--privileged',
    '-P', '--publish-all', '-q', '--quiet', '--read-only', '--read-only-tmpfs', '--replace', '--rm', '--rmi', '--rootfs',
    '--sig-proxy', '-t', '--tty', '--tls-verify', '--unsetenv-all']);

/** The Dev Containers CLI's keep-alive script, as it is without a Feature's entrypoint. */
const KEEP_ALIVE = 'echo Container started\ntrap "exit 0" 15\n\nexec "$@"\nwhile sleep 1 & wait $!; do :; done';

/**
 * An option of the recorded command: its flag, its value (null for a boolean), and its tokens as
 * recorded (one, `--flag=value`, `-fvalue`, or two).
 * @typedef {{ flag: string, value: string | null, tokens: string[] }} Option
 */

/**
 * Split TOKENS (the options between `podman run` and the image) into options. Refuses an option it
 * doesn't know: guessing whether it takes a value could shift every option after it.
 * @param {string[]} tokens
 * @returns {Option[]}
 */
export function parseOptions(tokens) {
    /** @type {Option[]} */
    const options = [];
    for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i];
        if (!token.startsWith('-') || token === '-' || token === '--') throw unexpected(`'${token}' where an option was expected`);
        const eq = token.startsWith('--') ? token.indexOf('=') : -1;
        if (eq > 0) {
            const flag = token.slice(0, eq);
            if (!VALUE.has(flag) && !BOOLEAN.has(flag)) throw unexpected(`unknown option ${flag}`);
            options.push({ flag, value: token.slice(eq + 1), tokens: [token] });
        } else if (BOOLEAN.has(token)) {
            options.push({ flag: token, value: null, tokens: [token] });
        } else if (VALUE.has(token)) {
            if (i + 1 >= tokens.length) throw unexpected(`${token} without its value`);
            options.push({ flag: token, value: tokens[i + 1], tokens: [token, tokens[i + 1]] });
            i += 1;
        } else if (/^-[a-zA-Z]./.test(token) && VALUE.has(token.slice(0, 2))) {
            options.push({ flag: token.slice(0, 2), value: token.slice(2), tokens: [token] });   // -aSTDOUT
        } else {
            throw unexpected(`unknown option ${token}`);
        }
    }
    return options;
}

/** @param {string} what */
function unexpected(what) {
    return new SandboxError(`the container wasn't made the way sandbox expects (${what}); can't make a VM from it`);
}

/** An image reference as the Dev Containers CLI passes it: without localhost/ and :latest. @param {string} image */
const bare = (image) => image.replace(/^localhost\//, '').replace(/:latest$/, '');

/** Options a VM doesn't take from the container (R4): what made it a container the Dev Containers CLI runs. */
function dropped(/** @type {Option} */ option) {
    const { flag, value } = option;
    if (['--sig-proxy', '-a', '--attach', '--name', '--entrypoint'].includes(flag)) return true;
    if (flag === '-l' || flag === '--label') {
        // The Dev Containers CLI finds a sandbox's container by its devcontainer.* labels, and the
        // sandbox label would make the VM pass as a sandbox of its own.
        const key = (value ?? '').split('=')[0];
        return key.startsWith('devcontainer.') || key === SANDBOX_LABEL || key === VM_OF_LABEL;
    }
    return false;
}

// Options that confine the container: R4.2 checks each of these tokens (and its value) is in the
// VM's command, apart from the parsing, so a parsing bug becomes a refusal, not a weaker VM.
const CONFINING = /^(--mount|-v|--volume|--cap-drop|--security-opt|--network|--net|--userns|-u|--user|--read-only|--tmpfs|--device|--pids-limit|-m|--memory|--ulimit|--uidmap|--gidmap)(=|$)/;

/**
 * The `podman run` arguments (without "podman") of sandbox NAME's VM, made from its container's
 * recorded command (R4). Refuses what it can't copy faithfully.
 * @param {object} from
 * @param {string[]} from.command   the container's .Config.CreateCommand
 * @param {string} from.imageName   its .ImageName: where the options end
 * @param {string} from.image       its .Image (ID): what the VM runs, not what the name points at now
 * @param {string} from.name        the sandbox's name
 * @param {string} from.workdir     the shell's folder: the config's workspaceFolder
 * @param {Record<string, string>} from.env  set for the shell (R8)
 * @returns {string[]}
 */
export function vmRunArgs({ command, imageName, image, name, workdir, env }) {
    if (command.length < 3 || basename(command[0]) !== 'podman' || command[1] !== 'run') {
        throw unexpected(`not made with podman run: ${command.slice(0, 2).join(' ') || 'no command recorded'}`);
    }
    // The image, from the end: after it only the keep-alive tail (overrideCommand), or nothing. An
    // option's value may equal the image's name; the tail can't.
    const n = command.length;
    let at = -1;
    if (n >= 6 && command[n - 3] === '-c' && command[n - 1] === '-' && bare(command[n - 4]) === bare(imageName)) {
        if (command[n - 2] !== KEEP_ALIVE) throw unexpected('its keep-alive script has more in it, e.g. a Feature\'s entrypoint');
        at = n - 4;
    } else if (bare(command[n - 1]) === bare(imageName)) {
        at = n - 1;
    } else {
        throw unexpected('its command after the image isn\'t the Dev Containers CLI\'s keep-alive, e.g. overrideCommand: false');
    }
    const original = command.slice(2, at);
    const options = parseOptions(original);
    const kept = options.filter((option) => !dropped(option));
    const hasWorkdir = kept.some((o) => o.flag === '-w' || o.flag === '--workdir');
    const added = [
        '-dit', '--runtime', 'krun', '--name', vmName(name),
        '--label', `${VM_OF_LABEL}=${name}`,
        '--entrypoint', '/bin/bash',
        ...(hasWorkdir ? [] : ['--workdir', workdir]),
    ];
    // After the container's own -e: the later one wins, as remoteEnv wins over containerEnv.
    const environment = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
    const keptTokens = kept.flatMap((o) => o.tokens);
    checkNotWeaker(original, options, keptTokens);
    return ['run', ...added, ...keptTokens, ...environment, image, '-l'];
}

/**
 * R4.2, the post-condition: the VM's options (RESULT, without what vmRunArgs adds) are the container's
 * (ORIGINAL tokens, parsed as OPTIONS) minus exactly the dropped ones, in order; and, apart from the
 * parsing, every confining token of the original, with its value, is in the result.
 * @param {string[]} original
 * @param {Option[]} options
 * @param {string[]} result
 */
export function checkNotWeaker(original, options, result) {
    const expected = options.filter((o) => !dropped(o)).flatMap((o) => o.tokens);
    const same = expected.length === result.length && expected.every((token, i) => token === result[i]);
    const missing = [];
    for (let i = 0; i < original.length; i += 1) {
        if (!CONFINING.test(original[i])) continue;
        const pair = original[i].includes('=') || BOOLEAN.has(original[i]) ? [original[i]] : original.slice(i, i + 2);
        const found = result.some((_, j) => pair.every((token, k) => result[j + k] === token));
        if (!found) missing.push(pair.join(' '));
    }
    if (!same || missing.length) {
        throw new SandboxError(`refusing to make a VM that would be weaker than the container${missing.length
            ? `: it would lose ${missing.join(', ')}` : ''} (a bug in sandbox: please report it)`);
    }
}

export class Vm {
    /** No exec into a krun guest: commands can't run next to its shell. */
    canExec = false;

    /**
     * @param {string} name  the sandbox's name
     * @param {import('./container.js').PodmanInfo} info
     */
    constructor(name, info) {
        this.name = name;
        this.info = info;
    }

    /**
     * Sandbox NAME's VM, found by its label, or null when it has none.
     * @param {string} name
     */
    static find(name) {
        const result = podman(['ps', '-a', '--filter', `label=${VM_OF_LABEL}=${name}`, '--format', '{{.ID}}']);
        if (result.status !== 0) throw new SandboxError(result.stderr.trim());
        const ids = result.stdout.split('\n').filter(Boolean);
        if (ids.length > 1) {
            throw new SandboxError(`${ids.length} containers carry ${VM_OF_LABEL}=${name}; remove all but one with podman rm`);
        }
        const info = ids.length ? inspectContainer(ids[0]) : null;
        return info ? new Vm(name, info) : null;
    }

    /** The VM's container name (NAME-vm when made). */
    get containerName() {
        return (this.info.Name ?? vmName(this.name)).replace(/^\//, '');
    }

    get state() {
        return this.info.State?.Status ?? '';
    }

    get exists() {
        return true;
    }

    get active() {
        return isActive(this.state);
    }

    readonlyMounts() {
        return (this.info.Mounts ?? []).filter((m) => !m.RW).map((m) => m.Destination);
    }

    volumes() {
        return (this.info.Mounts ?? []).flatMap((m) => (m.Type === 'volume' && m.Name ? [m.Name] : []));
    }

    start() {
        const result = podman(['start', this.info.Id]);
        if (result.status !== 0) {
            throw new SandboxError(`failed to start ${this.name}'s VM: ${result.stderr.trim()}\n`
                + `To make it again: sandbox rm ${this.name}, then sandbox enter ${this.name}`);
        }
    }

    /** Stop it at once: the VMM ignores SIGTERM, and what the guest wrote is already on the host. */
    stop() {
        const result = podman(['stop', '--time', '0', this.info.Id]);
        if (result.status !== 0) throw new SandboxError(result.stderr.trim());
    }

    remove() {
        const result = podman(['rm', '-f', this.info.Id]);
        if (result.status !== 0) throw new SandboxError(result.stderr.trim());
    }

    /**
     * Attach to the VM's shell (its main process); the exit status. Detached with DETACH_KEYS, not
     * Podman's default Ctrl-P Ctrl-Q, which takes bash's previous-command key while attached.
     */
    openShell() {
        console.error(`sandbox: attached to ${this.name}'s VM (press Enter for a prompt). Ctrl-] detaches; `
            + 'exit stops the VM. Another terminal attached shares this shell.');
        process.on('SIGINT', () => {});
        return exitStatus(podman(['attach', '--detach-keys', DETACH_KEYS, this.info.Id], { stdio: 'inherit' }));
    }

    /** One line for sandbox inspect. */
    describe() {
        const made = this.info.Created ? `, made ${madeAt(this.info.Created)}` : '';
        return `${this.containerName}, ${this.state}${made} from the container as it was then; to make it again: `
            + `sandbox rm ${this.name}, then sandbox enter ${this.name}`;
    }

    /**
     * Make sandbox NAME's VM from CONTAINER (stopped) and start it. A VM whose run fails is removed: it
     * never ran a session, and every later enter --vm would fail the same way on start.
     * @param {import('./container.js').Container} container
     * @param {{ workdir: string, env: Record<string, string> }} options
     */
    static makeFrom(container, { workdir, env }) {
        const info = /** @type {import('./container.js').PodmanInfo} */ (container.info);
        const { name } = container;
        const args = vmRunArgs({
            command: info.Config?.CreateCommand ?? [], imageName: info.ImageName ?? '', image: info.Image, name, workdir, env,
        });
        console.error(`sandbox: making ${name}'s VM ...`);
        const run = podman(args);
        const vm = Vm.find(name);
        if (run.status !== 0 || !vm?.active) {
            if (vm) vm.remove();
            const why = run.status !== 0 ? run.stderr.trim() : `it stopped at once (${vm?.state ?? 'gone'})`;
            throw new SandboxError(`couldn't run ${name}'s VM: ${why}\nOnce that's fixed, try again: `
                + `sandbox enter --vm --from-existing ${name}`);
        }
        return vm;
    }
}

/** A podman Created time as "2026-10-17 15:07", in local time. @param {string} created */
export function madeAt(created) {
    const date = new Date(created);
    if (Number.isNaN(date.getTime())) return created;
    const pad = (/** @type {number} */ x) => String(x).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
