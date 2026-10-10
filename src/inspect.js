// sandbox inspect: the podman command that created a sandbox, and what it runs with.
// Pure functions over `podman container inspect` output; cli.js does the podman calls.

const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** ARG quoted for the shell: bare when safe, else '…'; $'…' (bash, zsh) when it has control characters. */
export function shellQuote(arg) {
    if (SAFE.test(arg)) return arg;
    if (/[\x00-\x1f\x7f]/.test(arg)) {
        const escaped = arg.replace(/[\\']/g, '\\$&').replace(/\n/g, '\\n').replace(/\t/g, '\\t')
            .replace(/[\x00-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
        return `$'${escaped}'`;
    }
    return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** An image reference as the Dev Containers CLI passes it: without localhost/ and :latest. */
const bare = (image) => image.replace(/^localhost\//, '').replace(/:latest$/, '');

/**
 * Split a `podman run` command line into [program, subcommand], the options as [flag] or
 * [flag, value], the image, and the command after it. IMAGE (from inspect) is where the options
 * end: a flag followed by a word that isn't the image takes it as its value. Null when the image
 * isn't found.
 */
export function splitCommand(argv, image) {
    const want = bare(image);
    const options = [];
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('-')) {
            return bare(arg) === want ? { head: argv.slice(0, 2), options, image: arg, args: argv.slice(i + 1) } : null;
        }
        const next = argv[i + 1];
        if (!arg.includes('=') && next !== undefined && !next.startsWith('-') && bare(next) !== want) {
            options.push([arg, next]);
            i++;
        } else {
            options.push([arg]);
        }
    }
    return null;
}

/** The command as a shell command line: one option per line, the image and its command last. */
export function formatCommand(argv, image) {
    const split = splitCommand(argv, image);
    const lines = split
        ? [split.head, ...split.options, [split.image, ...split.args]]
        : [argv.slice(0, 2), ...argv.slice(2).map((arg) => [arg])];
    return lines.map((words) => words.map(shellQuote).join(' ')).join(' \\\n    ');
}

/** Every value given to FLAG, as --flag=value or --flag value. */
export function optionValues(options, flag) {
    const values = [];
    for (const [name, value] of options) {
        if (name === flag && value !== undefined) values.push(value);
        else if (name.startsWith(`${flag}=`)) values.push(name.slice(flag.length + 1));
    }
    return values;
}

/** CapBnd, NoNewPrivs and Seccomp from a /proc/PID/status text. */
export function parseStatus(text) {
    const status = {};
    for (const line of text.split('\n')) {
        const m = /^(CapBnd|NoNewPrivs|Seccomp):\s*(\S+)/.exec(line);
        if (m) status[m[1]] = m[2];
    }
    return status;
}

/** KEY=VALUE pairs of a --mount value. */
function mountFields(spec) {
    return Object.fromEntries(spec.split(',').map((kv) => [kv.split('=')[0], kv.split('=').slice(1).join('=')]));
}

const capName = (cap) => cap.replace(/^CAP_/, '').toLowerCase();

/**
 * What container INFO (one `podman container inspect` object) runs with, and what to warn about.
 * status: parseStatus() of /proc/1/status inside, when it runs (measured beats configured).
 * internal: network name -> true when internal (no route out).
 * uncovered: git paths a --workspace sandbox should have read-only and doesn't.
 * sandbox: false for a container `sandbox` didn't make: the advice is podman's, not the templates'.
 * Returns { rows: [[label, text]], mounts: [text], warnings: [text], notes: [text] }.
 */
export function audit(info, { status = null, internal = {}, uncovered = [], sandbox = true } = {}) {
    const host = info.HostConfig ?? {};
    const split = splitCommand(info.Config?.CreateCommand ?? [], info.ImageName ?? '');
    const options = split?.options ?? [];
    // Inspect's own fields where it has them; the command line for what it leaves out (unmask, devices).
    const securityOpts = host.SecurityOpt ?? [];
    const unmasked = [...new Set([...securityOpts, ...optionValues(options, '--security-opt')]
        .filter((o) => o.startsWith('unmask=')).map((o) => o.slice(7)))];
    const devices = [...new Set([...(host.Devices ?? []).map((d) => d.PathOnHost),
        ...optionValues(options, '--device').map((d) => d.split(':')[0])])];
    const nested = devices.includes('/dev/net/tun');
    const rows = [];
    const warnings = [];
    const notes = [];
    const unhardened = [];

    rows.push(['state', info.State?.Status ?? '?']);
    const userns = optionValues(options, '--userns').at(-1);
    const user = info.Config?.User || 'root (the image\'s default)';
    rows.push(['user', `${user}${userns ? `, user namespace ${userns}${userns === 'keep-id' ? ' (you, not root)' : ''}` : ''}`]);
    if (host.Privileged) warnings.push('privileged: the container has every capability and device');

    const caps = info.BoundingCaps ?? [];
    const capsNone = status ? BigInt(`0x${status.CapBnd ?? '0'}`) === 0n : caps.length === 0;
    rows.push(['capabilities', capsNone ? 'none (empty bounding set)'
        : `${caps.length} in the bounding set: ${caps.map(capName).join(', ')}`]);
    if (!capsNone) unhardened.push(`${caps.length} capabilities in the bounding set`);

    const noNewPrivs = status ? status.NoNewPrivs === '1' : securityOpts.includes('no-new-privileges');
    rows.push(['new privileges', noNewPrivs ? 'blocked (no-new-privileges)'
        : 'allowed: setuid and file-capability programs gain rights']);
    if (!noNewPrivs) unhardened.push('no-new-privileges off');
    if (unhardened.length && nested) {
        notes.push(`${unhardened.join(', ')}: expected for a sandbox that runs podman inside, like claude-containers`);
    } else if (unhardened.length && sandbox) {
        warnings.push(`${unhardened.join(', ')}: setuid and file-capability programs can gain rights. The templates `
            + 'since 0.5.2 add --cap-drop=all and --security-opt=no-new-privileges to runArgs (then sandbox rm, sandbox enter)');
    } else if (unhardened.length) {
        warnings.push(`${unhardened.join(', ')}: setuid and file-capability programs (sudo) can gain rights; `
            + 'podman run --cap-drop=all --security-opt=no-new-privileges prevents it');
    }

    const seccomp = securityOpts.filter((o) => o.startsWith('seccomp=')).map((o) => o.slice(8)).at(-1);
    if (seccomp === 'unconfined' || status?.Seccomp === '0') {
        rows.push(['seccomp', 'off (unconfined)']);
        warnings.push('seccomp is off: every system call is allowed');
    } else {
        rows.push(['seccomp', seccomp ? `profile ${seccomp}` : 'Podman\'s default profile']);
    }

    rows.push(['devices', devices.join(', ') || 'none']);
    rows.push(['/proc', unmasked.length ? `unmasked: ${unmasked.join(', ')}` : 'masked (Podman\'s default)']);

    const mode = host.NetworkMode ?? '';
    const networks = Object.keys(info.NetworkSettings?.Networks ?? {});
    if (mode === 'none') {
        rows.push(['network', 'none']);
    } else if (mode === 'host') {
        rows.push(['network', 'host: the host\'s own network']);
        warnings.push('host network: services on the host\'s localhost are reachable');
    } else if (mode === 'pasta' || mode === 'slirp4netns') {
        rows.push(['network', `${mode}: Internet, LAN and services on the host`]);
    } else {
        rows.push(['network', networks.map((n) => `${n} (${internal[n] ? 'internal: no route out' : 'routed: Internet and LAN'})`)
            .join(', ') || mode]);
    }

    const pids = host.PidsLimit ? String(host.PidsLimit) : 'no limit';
    const memory = host.Memory ? `${Math.round(host.Memory / 2 ** 20)} MiB` : 'no limit';
    rows.push(['limits', `processes ${pids}, memory ${memory}`]);

    const mounts = [];
    for (const m of info.Mounts ?? []) {
        if (m.Type === 'bind' && m.Source === '/dev/null') {
            mounts.push([m.Destination, `hidden  ${m.Destination} (empty file)`]);
        } else if (m.Type === 'volume') {
            mounts.push([m.Destination, `${m.RW ? 'rw' : 'ro'}      ${m.Destination} (volume ${m.Name})`]);
        } else {
            const from = m.Source === m.Destination ? '' : ` (from ${m.Source})`;
            mounts.push([m.Destination, `${m.RW ? 'rw' : 'ro'}      ${m.Destination}${from}`]);
        }
    }
    for (const spec of optionValues(options, '--mount')) {
        const f = mountFields(spec);
        const target = f.target ?? f.destination ?? f.dst;
        if (f.type === 'tmpfs' && target) mounts.push([target, `hidden  ${target} (empty folder)`]);
    }
    mounts.sort((a, b) => a[0].localeCompare(b[0]));

    for (const path of uncovered) warnings.push(`writable inside, and git on the host runs what it names: ${path}`);
    return { rows, mounts: mounts.map(([, text]) => text), warnings, notes };
}
