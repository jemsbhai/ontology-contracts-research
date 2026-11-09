/** Explicit finite consumer-execution contracts. These carry no OWL entailment claim. */
export interface ConsumerRevision {
    readonly id: string;
    readonly directory: string;
    readonly testFile: string;
    readonly cwd: string;
    readonly testClasses: ReadonlyArray<string>;
    readonly expectedTests: ReadonlyArray<string>;
}

export interface ConsumerResource {
    readonly id: string;
    readonly uri: string;
    readonly aliases?: ReadonlyArray<string>;
    readonly file: string;
    readonly cachePath: string;
}

export interface ConsumerArm {
    readonly id: string;
    readonly revision: string;
    readonly resources: ReadonlyArray<string>;
    readonly cache:
        | Readonly<{ kind: 'empty' }>
        | Readonly<{ kind: 'seed'; resources: ReadonlyArray<string> }>
        | Readonly<{ kind: 'inherit'; arm: string }>;
    readonly interpretation: 'observe' | 'enforce';
}

export interface ConsumerPlan {
    readonly schema: 'erden.consumer-plan/v1';
    readonly id: string;
    readonly python: string;
    readonly revisions: ReadonlyArray<ConsumerRevision>;
    readonly resources: ReadonlyArray<ConsumerResource>;
    readonly arms: ReadonlyArray<ConsumerArm>;
    readonly environment: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
}

export interface ConsumerFileIdentity {
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
}

export interface ConsumerLock {
    readonly schema: 'erden.consumer-lock/v1';
    readonly planSha256: string;
    readonly pythonSha256: string;
    readonly adapterSha256: string;
    readonly revisions: ReadonlyArray<
        Readonly<{ id: string; sha256: string; files: ReadonlyArray<ConsumerFileIdentity> }>
    >;
    readonly resources: ReadonlyArray<Readonly<{ id: string; sha256: string; bytes: number }>>;
}

export interface ConsumerRunnerInput {
    readonly schema: 'erden.consumer-runner/v1';
    readonly id: string;
    readonly sourceRoot: string;
    readonly testFile: string;
    readonly cwd: string;
    readonly testClasses: ReadonlyArray<string>;
    readonly expectedTests: ReadonlyArray<string>;
    readonly cacheDir: string;
    readonly resources: ReadonlyArray<
        Readonly<{
            id: string;
            uris: ReadonlyArray<string>;
            cachePath: string;
            sourcePath: string;
            sha256: string;
        }>
    >;
}

export interface ConsumerTestResult {
    readonly id: string;
    readonly outcome: 'passed' | 'failed' | 'error' | 'skipped';
    readonly detail: string | null;
}

export interface ConsumerResourceEvent {
    readonly kind: 'http' | 'cache-read' | 'cache-write';
    readonly resourceId: string;
    readonly url: string | null;
    readonly path: string | null;
    readonly sha256: string | null;
}

export interface ConsumerRunnerResult {
    readonly schema: 'erden.consumer-runner-result/v1';
    readonly id: string;
    readonly discoveredTests: ReadonlyArray<string>;
    readonly tests: ReadonlyArray<ConsumerTestResult>;
    readonly resourceEvents: ReadonlyArray<ConsumerResourceEvent>;
    readonly networkAttempts: ReadonlyArray<string>;
    readonly fatalError: string | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly runtime: Readonly<{
        pythonVersion: string;
        executable: string;
        distributions: ReadonlyArray<Readonly<{ name: string; version: string }>>;
        moduleFiles: ReadonlyArray<Readonly<{ path: string; sha256: string }>>;
    }>;
}

function object(value: unknown, keys: ReadonlyArray<string>, label: string): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label}: expected object`);
    }
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some((key) => !keys.includes(key))) {
        throw new TypeError(`${label}: unknown field`);
    }
    return record;
}

function string(value: unknown, label: string): asserts value is string {
    if (typeof value !== 'string' || !value.length || value.includes('\0') || !value.isWellFormed()) {
        throw new TypeError(`${label}: expected nonempty Unicode string`);
    }
}

export function assertConsumerRelativePath(value: unknown, allowDot = false): asserts value is string {
    string(value, 'path');
    if (allowDot && value === '.') {
        return;
    }
    if (
        /[\\:<>"|?*\u0000-\u001f]/u.test(value) ||
        value.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/u.test(part))
    ) {
        throw new TypeError('Consumer paths must be safe relative POSIX paths');
    }
    if (value.split('/').some((part) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) {
        throw new TypeError('Consumer paths may not name reserved devices');
    }
}

function strings(value: unknown, label: string, maximum = 4096): asserts value is string[] {
    if (!Array.isArray(value) || value.length > maximum) {
        throw new TypeError(`${label}: expected bounded array`);
    }
    for (const item of value) {
        string(item, label);
    }
    if (new Set(value).size !== value.length) {
        throw new TypeError(`${label}: duplicates`);
    }
}

function id(value: unknown): asserts value is string {
    string(value, 'id');
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(value)) {
        throw new TypeError('Invalid consumer identifier');
    }
}

function list(value: unknown, label: string, maximum: number): asserts value is unknown[] {
    if (!Array.isArray(value) || !value.length || value.length > maximum) {
        throw new TypeError(`${label}: expected nonempty bounded array`);
    }
}

function url(value: unknown): void {
    string(value, 'uri');
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
        throw new TypeError('Consumer resources require HTTP(S) URLs without credentials or fragments');
    }
}

/** Strict validation before filesystem work or Python execution. Defaults are deliberately absent. */
export function parseConsumerPlan(text: string): ConsumerPlan {
    if (text.length > 4_194_304) {
        throw new TypeError('Consumer plan exceeds size bound');
    }
    const p = object(
        JSON.parse(text) as unknown,
        ['schema', 'id', 'python', 'revisions', 'resources', 'arms', 'environment', 'timeoutMs', 'maxOutputBytes'],
        'plan',
    );
    if (p.schema !== 'erden.consumer-plan/v1') {
        throw new TypeError('Unsupported consumer plan schema');
    }
    id(p.id);
    string(p.python, 'python');
    list(p.revisions, 'revisions', 32);
    const revisions = new Set<string>();
    for (const value of p.revisions) {
        const r = object(value, ['id', 'directory', 'testFile', 'cwd', 'testClasses', 'expectedTests'], 'revision');
        id(r.id);
        if (revisions.has(r.id)) {
            throw new TypeError('Duplicate revision');
        }
        revisions.add(r.id);
        assertConsumerRelativePath(r.directory);
        assertConsumerRelativePath(r.testFile);
        assertConsumerRelativePath(r.cwd, true);
        strings(r.testClasses, 'testClasses', 128);
        strings(r.expectedTests, 'expectedTests');
        const classes = r.testClasses;
        if (!r.testClasses.length || !r.expectedTests.length) {
            throw new TypeError('Empty test contract');
        }
        if (r.testClasses.some((name) => !/^[A-Za-z_]\w*$/u.test(name))) {
            throw new TypeError('Invalid test class');
        }
        if (
            r.expectedTests.some(
                (name) =>
                    !/^[A-Za-z_]\w*\.[A-Za-z_]\w*$/u.test(name) || !classes.includes(name.split('.')[0] as string),
            )
        ) {
            throw new TypeError('Invalid test identity');
        }
    }
    if (!Array.isArray(p.resources) || p.resources.length > 256) {
        throw new TypeError('Invalid resources');
    }
    const resources = new Map<string, ConsumerResource>();
    for (const value of p.resources) {
        const r = object(value, ['id', 'uri', 'aliases', 'file', 'cachePath'], 'resource');
        id(r.id);
        if (resources.has(r.id)) {
            throw new TypeError('Duplicate resource');
        }
        url(r.uri);
        if (r.aliases !== undefined) {
            strings(r.aliases, 'aliases', 32);
            r.aliases.forEach(url);
            if (r.aliases.includes(r.uri as string)) {
                throw new TypeError('Duplicate resource URL');
            }
        }
        assertConsumerRelativePath(r.file);
        assertConsumerRelativePath(r.cachePath);
        resources.set(r.id, r as unknown as ConsumerResource);
    }
    function checkResources(value: unknown): void {
        strings(value, 'arm resources', 256);
        const paths = new Set<string>();
        const urls = new Set<string>();
        for (const name of value) {
            const resource = resources.get(name);
            if (!resource) {
                throw new TypeError('Unknown resource');
            }
            const path = resource.cachePath.toLowerCase();
            if (paths.has(path)) {
                throw new TypeError('Conflicting cache aliases');
            }
            paths.add(path);
            for (const uri of [resource.uri, ...(resource.aliases ?? [])]) {
                if (urls.has(uri)) {
                    throw new TypeError('Conflicting resource URLs');
                }
                urls.add(uri);
            }
        }
    }
    list(p.arms, 'arms', 128);
    const arms = new Set<string>();
    for (const value of p.arms) {
        const arm = object(value, ['id', 'revision', 'resources', 'cache', 'interpretation'], 'arm');
        id(arm.id);
        if (arms.has(arm.id) || !revisions.has(arm.revision as string)) {
            throw new TypeError('Duplicate arm or unknown revision');
        }
        if (arm.interpretation !== 'observe' && arm.interpretation !== 'enforce') {
            throw new TypeError('Invalid interpretation policy');
        }
        checkResources(arm.resources);
        const cache = object(arm.cache, ['kind', 'resources', 'arm'], 'cache');
        if (cache.kind === 'empty') {
            if (Object.keys(cache).length !== 1) {
                throw new TypeError('Unexpected empty-cache field');
            }
        } else if (cache.kind === 'seed') {
            if (cache.arm !== undefined) {
                throw new TypeError('Unexpected seed-cache field');
            }
            checkResources(cache.resources);
        } else if (cache.kind === 'inherit') {
            if (cache.resources !== undefined || !arms.has(cache.arm as string)) {
                throw new TypeError('Cache must inherit an earlier arm');
            }
        } else {
            throw new TypeError('Invalid cache policy');
        }
        arms.add(arm.id);
    }
    const env = p.environment;
    if (!env || typeof env !== 'object' || Array.isArray(env)) {
        throw new TypeError('Invalid environment');
    }
    for (const [key, value] of Object.entries(env)) {
        if (
            !/^[A-Z_][A-Z0-9_]*$/u.test(key) ||
            /^(?:PYTHON|TMP|TEMP|HOME|USERPROFILE|PATH|LD_|DYLD_|ERDEN_)/u.test(key)
        ) {
            throw new TypeError('Reserved environment setting');
        }
        string(value, 'environment value');
    }
    if (!Number.isSafeInteger(p.timeoutMs) || (p.timeoutMs as number) < 100 || (p.timeoutMs as number) > 600_000) {
        throw new TypeError('Invalid timeout');
    }
    if (
        !Number.isSafeInteger(p.maxOutputBytes) ||
        (p.maxOutputBytes as number) < 1024 ||
        (p.maxOutputBytes as number) > 16_777_216
    ) {
        throw new TypeError('Invalid output bound');
    }
    return p as unknown as ConsumerPlan;
}
