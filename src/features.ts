// Features a sandbox gets next to its config rather than in it (lab 47): the agent, a local Feature in
// .devcontainer/agent/NAME/, and published Features given to sandbox new with --feature, recorded in
// .devcontainer/sandbox-features.json. Every devcontainer command that builds or reads the config gets
// them with --additional-features, so devcontainer.json stays as the template (or the user) wrote it.
// The files are the record: .devcontainer is read-only inside the sandbox, so what runs there can't
// change what the next build runs as root. The Dev Containers CLI takes a local Feature only from
// inside .devcontainer (not by absolute path), and a published one by its OCI reference.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SandboxError } from './devcontainer.js';
import { isObject } from './json.js';
import type { JsonObject } from './json.js';
import { readSettings } from './workspace.js';

/** Where the agent's Feature folder goes, inside .devcontainer. */
export const AGENT_DIR = 'agent';
/** The --feature Features, inside .devcontainer: { REF: options }, as in devcontainer.json's "features". */
export const FEATURES_FILE = 'sandbox-features.json';

/**
 * The agent Feature of the sandbox in config folder DIR: its folder's name (e.g. codex), or null when
 * it has none. More than one is refused: a sandbox has one agent.
 */
export function agentOf(dir: string): string | null {
    const root = join(dir, '.devcontainer', AGENT_DIR);
    if (!existsSync(root)) return null;
    const agents = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'devcontainer-feature.json')))
        .map((e) => e.name).sort();
    if (agents.length > 1) {
        throw new SandboxError(`${root} has more than one agent (${agents.join(', ')}): a sandbox has one; `
            + 'remove the others');
    }
    return agents[0] ?? null;
}

/** The --feature Features recorded in DIR: {} without the file. */
export function recordedFeatures(dir: string): JsonObject {
    const file = join(dir, '.devcontainer', FEATURES_FILE);
    if (!existsSync(file)) return {};
    const features: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isObject(features) || !Object.values(features).every(isObject)) {
        throw new SandboxError(`${file} isn't what sandbox new writes: { "REFERENCE": { options }, ... }`);
    }
    return features;
}

/** Record FEATURES ({ REF: options }) in config folder DIR. */
export function writeFeatures(dir: string, features: JsonObject): void {
    writeFileSync(join(dir, '.devcontainer', FEATURES_FILE), `${JSON.stringify(features, null, 2)}\n`);
}

/** All the Features DIR's sandbox gets next to its config: the recorded ones, then the agent. */
export function extraFeatures(dir: string): JsonObject {
    const agent = agentOf(dir);
    return { ...recordedFeatures(dir), ...(agent ? { [`./${AGENT_DIR}/${agent}`]: {} } : {}) };
}

/**
 * The devcontainer options that add DIR's extra Features: [] without any, and always [] for an
 * --inplace sandbox. Its config folder holds the trusted copy of the project's .devcontainer, so an
 * agent folder or sandbox-features.json there came from the project, and the trust prompt (which
 * shows devcontainer.json) didn't show them: such a config names its Features itself.
 */
export function featureArgs(dir: string): string[] {
    if (readSettings(dir)?.inplace) return [];
    const features = extraFeatures(dir);
    return Object.keys(features).length ? ['--additional-features', JSON.stringify(features)] : [];
}

/**
 * sandbox new's --feature values: REF, or REF={"option": value, ...}. REF is a published Feature's
 * reference (ghcr.io/devcontainers/features/aws-cli:1); local paths are refused, since the CLI takes
 * those only from inside .devcontainer.
 */
export function parseFeatureArgs(values: string[]): JsonObject {
    const features: JsonObject = {};
    for (const value of values) {
        const at = value.indexOf('=');
        const ref = (at < 0 ? value : value.slice(0, at)).trim();
        if (!ref) throw new SandboxError(`--feature ${value}: no Feature reference`);
        if (ref.startsWith('.') || ref.startsWith('/')) {
            throw new SandboxError(`--feature ${ref}: give a published Feature's reference (e.g. `
                + 'ghcr.io/devcontainers/features/aws-cli:1); a local Feature folder goes in the template\'s .devcontainer');
        }
        let options: unknown = {};
        if (at >= 0) {
            try {
                options = JSON.parse(value.slice(at + 1));
            } catch {
                throw new SandboxError(`--feature ${ref}: the options after = must be JSON, e.g. ${ref}='{"version": "latest"}'`);
            }
            if (!isObject(options)) throw new SandboxError(`--feature ${ref}: the options after = must be a JSON object`);
        }
        features[ref] = options;
    }
    return features;
}
