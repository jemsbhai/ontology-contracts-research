import { lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { parseConsumerPlan, type ConsumerFileIdentity, type ConsumerLock, type ConsumerPlan } from '@erden/contracts';

import {
    canonicalJson,
    captureTree,
    CONSUMER_FILE_LIMITS,
    ConsumerOperationError,
    newDirectory,
    portablePath,
    readRegularFile,
    sha256,
    within,
    writeNewFile,
    writeTree,
    type CapturedConsumerFile,
} from './filesystem.js';
import { PYTHON_CONSUMER_ADAPTER } from './python.js';

export const utf8 = new TextDecoder('utf-8', { fatal: true });
export function identities(files: readonly CapturedConsumerFile[]): ConsumerFileIdentity[] {
    return files.map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes.length }));
}
export function treeDigest(files: readonly ConsumerFileIdentity[]): string {
    return sha256(canonicalJson(files));
}
export function same(a: unknown, b: unknown): boolean {
    return canonicalJson(a) === canonicalJson(b);
}
export function required<T>(value: T | undefined): T {
    if (value === undefined) {
        throw new ConsumerOperationError('CONSUMER_INVALID_REFERENCE', 'Consumer contract reference is absent');
    }
    return value;
}
export interface LoadedInputs {
    plan: ConsumerPlan;
    planBytes: Uint8Array;
    base: string;
    python: string;
    lock: ConsumerLock;
    revisions: Map<string, readonly CapturedConsumerFile[]>;
    resources: Map<string, Uint8Array>;
}
export async function loadInputs(planPath: string): Promise<LoadedInputs> {
    const planBytes = await readRegularFile(planPath),
        plan = parseConsumerPlan(utf8.decode(planBytes)),
        base = dirname(resolve(planPath));
    const python = isAbsolute(plan.python) ? resolve(plan.python) : resolve(base, plan.python),
        pythonBytes = await readRegularFile(python);
    const revisions = new Map<string, readonly CapturedConsumerFile[]>(),
        resources = new Map<string, Uint8Array>();
    const lockedRevisions: ConsumerLock['revisions'][number][] = [],
        lockedResources: ConsumerLock['resources'][number][] = [];
    let total = planBytes.length;
    for (const r of plan.revisions) {
        const files = await captureTree(resolve(base, r.directory));
        if (
            !files.some((f) => f.path === r.testFile) ||
            !(await lstat(resolve(base, r.directory, r.cwd))).isDirectory()
        ) {
            throw new ConsumerOperationError(
                'CONSUMER_TEST_INPUT',
                'Declared test file or working directory is absent',
            );
        }
        const manifest = identities(files);
        revisions.set(r.id, files);
        lockedRevisions.push({ id: r.id, sha256: treeDigest(manifest), files: manifest });
        total += files.reduce((sum, f) => sum + f.bytes.length, 0);
    }
    for (const r of plan.resources) {
        const bytes = await readRegularFile(resolve(base, r.file));
        resources.set(r.id, bytes);
        lockedResources.push({ id: r.id, sha256: sha256(bytes), bytes: bytes.length });
        total += bytes.length;
    }
    if (total > CONSUMER_FILE_LIMITS.totalBytes) {
        throw new ConsumerOperationError('CONSUMER_INPUT_LIMIT', 'Combined consumer inputs exceed limits');
    }
    const lock: ConsumerLock = {
        schema: 'erden.consumer-lock/v1',
        planSha256: sha256(planBytes),
        pythonSha256: sha256(pythonBytes),
        adapterSha256: sha256(PYTHON_CONSUMER_ADAPTER),
        revisions: lockedRevisions,
        resources: lockedResources,
    };
    return { plan, planBytes, base, python, lock, revisions, resources };
}
export function protectOutput(i: LoadedInputs, output: string, additional: readonly string[] = []): void {
    const target = resolve(output);
    if (
        i.plan.revisions.some((r) => within(resolve(i.base, r.directory), target)) ||
        i.plan.resources.some((r) => target === resolve(i.base, r.file)) ||
        additional.some((p) => target === resolve(p)) ||
        target === i.python
    ) {
        throw new ConsumerOperationError('CONSUMER_OUTPUT_OVERLAP', 'Consumer output overlaps an input');
    }
}
export async function checkLock(i: LoadedInputs, path: string): Promise<Uint8Array> {
    const bytes = await readRegularFile(path);
    if (!same(JSON.parse(utf8.decode(bytes)), i.lock)) {
        throw new ConsumerOperationError(
            'CONSUMER_LOCK_MISMATCH',
            'Plan, source, runtime, adapter or resource differs from lock',
        );
    }
    return bytes;
}
export async function consumerLock(o: { planPath: string; outputPath: string }): Promise<ConsumerLock> {
    const i = await loadInputs(o.planPath);
    protectOutput(i, o.outputPath, [o.planPath]);
    await writeNewFile(o.outputPath, canonicalJson(i.lock));
    return i.lock;
}
export function validateFilePaths(paths: readonly string[]): void {
    const seen = new Set<string>();
    for (const path of paths) {
        const key = portablePath(path).normalize('NFC').toLowerCase();
        if (seen.has(key)) {
            throw new ConsumerOperationError('CONSUMER_PATH_COLLISION', 'Colliding capsule paths');
        }
        seen.add(key);
    }
    for (const key of seen) {
        const parts = key.split('/');
        for (let n = 1; n < parts.length; n += 1) {
            if (seen.has(parts.slice(0, n).join('/'))) {
                throw new ConsumerOperationError('CONSUMER_PATH_COLLISION', 'File-directory path conflict');
            }
        }
    }
}
export async function consumerPack(o: {
    planPath: string;
    lockPath: string;
    outputPath: string;
}): Promise<{ schema: 'erden.consumer-pack/v1'; sha256: string; bytes: number; files: number }> {
    const i = await loadInputs(o.planPath),
        lockBytes = await checkLock(i, o.lockPath);
    protectOutput(i, o.outputPath, [o.planPath, o.lockPath]);
    const files = new Map<string, CapturedConsumerFile>();
    function add(path: string, bytes: Uint8Array): void {
        const old = files.get(path);
        if (old && old.sha256 !== sha256(bytes)) {
            throw new ConsumerOperationError('CONSUMER_PATH_COLLISION', 'Conflicting input paths');
        }
        files.set(path, { path, sha256: sha256(bytes), bytes });
    }
    add('consumer.plan.json', i.planBytes);
    add('consumer.lock.json', lockBytes);
    for (const r of i.plan.revisions) {
        for (const f of required(i.revisions.get(r.id))) {
            add(`${r.directory}/${f.path}`, f.bytes);
        }
    }
    for (const r of i.plan.resources) {
        add(r.file, required(i.resources.get(r.id)));
    }
    validateFilePaths([...files.keys()]);
    const entries = [...files.values()]
        .sort((a, b) => (a.path < b.path ? -1 : 1))
        .map((f) => ({
            path: f.path,
            sha256: f.sha256,
            bytes: f.bytes.length,
            base64: Buffer.from(f.bytes).toString('base64'),
        }));
    const text = canonicalJson({ schema: 'erden.consumer-capsule/v1', files: entries });
    if (Buffer.byteLength(text) > CONSUMER_FILE_LIMITS.capsuleBytes) {
        throw new ConsumerOperationError('CONSUMER_CAPSULE_LIMIT', 'Capsule exceeds byte limit');
    }
    await writeNewFile(o.outputPath, text);
    return {
        schema: 'erden.consumer-pack/v1',
        sha256: sha256(text),
        bytes: Buffer.byteLength(text),
        files: files.size,
    };
}
function decodeCapsule(bytes: Uint8Array): CapturedConsumerFile[] {
    const raw: unknown = JSON.parse(utf8.decode(bytes));
    if (
        !raw ||
        typeof raw !== 'object' ||
        !('schema' in raw) ||
        raw.schema !== 'erden.consumer-capsule/v1' ||
        !('files' in raw) ||
        !Array.isArray(raw.files) ||
        Object.keys(raw).sort().join(',') !== 'files,schema' ||
        raw.files.length > CONSUMER_FILE_LIMITS.files
    ) {
        throw new ConsumerOperationError('CONSUMER_CAPSULE_INVALID', 'Invalid capsule envelope');
    }
    let total = 0;
    const files = raw.files.map((item: unknown): CapturedConsumerFile => {
        if (!item || typeof item !== 'object') {
            throw new ConsumerOperationError('CONSUMER_CAPSULE_INVALID', 'Invalid capsule entry');
        }
        const f = item as Record<string, unknown>;
        if (
            Object.keys(f).sort().join(',') !== 'base64,bytes,path,sha256' ||
            typeof f.path !== 'string' ||
            typeof f.base64 !== 'string' ||
            typeof f.sha256 !== 'string' ||
            !Number.isSafeInteger(f.bytes) ||
            (f.bytes as number) < 0 ||
            (f.bytes as number) > CONSUMER_FILE_LIMITS.fileBytes ||
            f.base64.length > Math.ceil(CONSUMER_FILE_LIMITS.fileBytes / 3) * 4
        ) {
            throw new ConsumerOperationError('CONSUMER_CAPSULE_INVALID', 'Invalid capsule file fields');
        }
        portablePath(f.path);
        const content = Buffer.from(f.base64, 'base64');
        total += content.length;
        if (
            content.toString('base64') !== f.base64 ||
            content.length !== f.bytes ||
            sha256(content) !== f.sha256 ||
            total > CONSUMER_FILE_LIMITS.totalBytes
        ) {
            throw new ConsumerOperationError('CONSUMER_CAPSULE_INVALID', 'Capsule content identity mismatch');
        }
        return { path: f.path, sha256: f.sha256, bytes: content };
    });
    validateFilePaths(files.map((f) => f.path));
    return files;
}
function verifyCapsuleInputs(files: readonly CapturedConsumerFile[]): void {
    const entries = new Map(files.map((f) => [f.path, f])),
        planBytes = entries.get('consumer.plan.json')?.bytes,
        lockBytes = entries.get('consumer.lock.json')?.bytes;
    if (!planBytes || !lockBytes) {
        throw new ConsumerOperationError('CONSUMER_CAPSULE_INVALID', 'Capsule omits plan or lock');
    }
    const plan = parseConsumerPlan(utf8.decode(planBytes)),
        rawLock: unknown = JSON.parse(utf8.decode(lockBytes));
    if (
        !rawLock ||
        typeof rawLock !== 'object' ||
        !('pythonSha256' in rawLock) ||
        typeof rawLock.pythonSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(rawLock.pythonSha256)
    ) {
        throw new ConsumerOperationError('CONSUMER_CAPSULE_INVALID', 'Invalid runtime lock');
    }
    const expectedPaths = new Set(['consumer.plan.json', 'consumer.lock.json']);
    const revisions = plan.revisions.map((r) => {
        const prefix = `${r.directory}/`;
        const manifest = files
            .filter((f) => f.path.startsWith(prefix))
            .map((f) => ({ path: f.path.slice(prefix.length), sha256: f.sha256, bytes: f.bytes.length }))
            .sort((a, b) => (a.path < b.path ? -1 : 1));
        if (!manifest.some((f) => f.path === r.testFile)) {
            throw new ConsumerOperationError('CONSUMER_CAPSULE_INVALID', 'Capsule omits original tests');
        }
        manifest.forEach((f) => expectedPaths.add(`${prefix}${f.path}`));
        return { id: r.id, sha256: treeDigest(manifest), files: manifest };
    });
    const resources = plan.resources.map((r) => {
        const f = entries.get(r.file);
        if (!f) {
            throw new ConsumerOperationError('CONSUMER_CAPSULE_INVALID', 'Capsule omits resource');
        }
        expectedPaths.add(r.file);
        return { id: r.id, sha256: f.sha256, bytes: f.bytes.length };
    });
    const expected: ConsumerLock = {
        schema: 'erden.consumer-lock/v1',
        planSha256: sha256(planBytes),
        pythonSha256: rawLock.pythonSha256,
        adapterSha256: sha256(PYTHON_CONSUMER_ADAPTER),
        revisions,
        resources,
    };
    if (files.some((f) => !expectedPaths.has(f.path)) || !same(rawLock, expected)) {
        throw new ConsumerOperationError('CONSUMER_CAPSULE_INVALID', 'Capsule inventory differs from lock');
    }
}
export async function consumerInstall(o: { capsulePath: string; destination: string }): Promise<{
    schema: 'erden.consumer-install/v1';
    capsuleSha256: string;
    files: number;
    planPath: string;
    lockPath: string;
}> {
    const bytes = await readRegularFile(o.capsulePath, CONSUMER_FILE_LIMITS.capsuleBytes),
        files = decodeCapsule(bytes);
    verifyCapsuleInputs(files);
    if (within(o.destination, o.capsulePath)) {
        throw new ConsumerOperationError('CONSUMER_OUTPUT_OVERLAP', 'Installation overlaps its capsule');
    }
    await newDirectory(o.destination);
    await writeTree(o.destination, files);
    return {
        schema: 'erden.consumer-install/v1',
        capsuleSha256: sha256(bytes),
        files: files.length,
        planPath: join(resolve(o.destination), 'consumer.plan.json'),
        lockPath: join(resolve(o.destination), 'consumer.lock.json'),
    };
}
