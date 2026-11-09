import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

export const CONSUMER_FILE_LIMITS = Object.freeze({
    files: 10_000,
    fileBytes: 32 * 1024 * 1024,
    totalBytes: 256 * 1024 * 1024,
    capsuleBytes: 384 * 1024 * 1024,
});

export class ConsumerOperationError extends Error {
    constructor(
        readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = 'ConsumerOperationError';
    }
}

export function sha256(bytes: Uint8Array | string): string {
    return createHash('sha256').update(bytes).digest('hex');
}

export function canonicalJson(value: unknown): string {
    function canonical(item: unknown): unknown {
        if (Array.isArray(item)) {
            return item.map(canonical);
        }
        if (item !== null && typeof item === 'object') {
            return Object.fromEntries(
                Object.entries(item)
                    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                    .map(([key, child]) => [key, canonical(child)]),
            );
        }
        return item;
    }
    return `${JSON.stringify(canonical(value))}\n`;
}

export function portablePath(value: string): string {
    if (
        typeof value !== 'string' ||
        value.length === 0 ||
        value.length > 1024 ||
        value.includes('\\') ||
        value.includes(':') ||
        value.includes('\0') ||
        isAbsolute(value) ||
        value
            .split('/')
            .some(
                (part) =>
                    part === '' ||
                    part === '.' ||
                    part === '..' ||
                    /[. ]$/u.test(part) ||
                    /[<>"|?*\x00-\x1f]/u.test(part) ||
                    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
            )
    ) {
        throw new ConsumerOperationError(
            'CONSUMER_UNSAFE_PATH',
            'Consumer file paths must be safe relative portable paths',
        );
    }
    return value;
}

export function within(parent: string, child: string): boolean {
    const rel = relative(resolve(parent), resolve(child));
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

export async function noSymlinkPath(value: string): Promise<void> {
    const absolute = resolve(value);
    const root = parse(absolute).root;
    let current = root;
    for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
        current = join(current, part);
        const stat = await lstat(current);
        if (stat.isSymbolicLink()) {
            throw new ConsumerOperationError('CONSUMER_SYMLINK', 'Consumer paths must not traverse symbolic links');
        }
    }
}

export async function readRegularFile(value: string, maximum = CONSUMER_FILE_LIMITS.fileBytes): Promise<Uint8Array> {
    await noSymlinkPath(value);
    const before = await lstat(value, { bigint: true });
    if (!before.isFile() || before.size > BigInt(maximum)) {
        throw new ConsumerOperationError('CONSUMER_INPUT_LIMIT', 'Consumer input is not a bounded regular file');
    }
    const handle = await open(value, 'r');
    try {
        const opened = await handle.stat({ bigint: true });
        if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
            throw new ConsumerOperationError('CONSUMER_INPUT_CHANGED', 'Consumer input changed during capture');
        }
        const buffer = Buffer.alloc(Number(before.size) + 1);
        let length = 0;
        while (length < buffer.length) {
            const read = await handle.read(buffer, length, buffer.length - length, null);
            if (read.bytesRead === 0) {
                break;
            }
            length += read.bytesRead;
        }
        const bytes = buffer.subarray(0, length);
        const after = await handle.stat({ bigint: true });
        const pathAfter = await lstat(value, { bigint: true });
        if (
            bytes.length > maximum ||
            after.size !== before.size ||
            after.mtimeNs !== before.mtimeNs ||
            after.ctimeNs !== before.ctimeNs ||
            pathAfter.ino !== before.ino ||
            pathAfter.dev !== before.dev ||
            pathAfter.isSymbolicLink()
        ) {
            throw new ConsumerOperationError('CONSUMER_INPUT_CHANGED', 'Consumer input changed during capture');
        }
        return bytes;
    } finally {
        await handle.close();
    }
}

export interface CapturedConsumerFile {
    readonly path: string;
    readonly sha256: string;
    readonly bytes: Uint8Array;
}

export async function captureTree(root: string): Promise<readonly CapturedConsumerFile[]> {
    const absolute = resolve(root);
    await noSymlinkPath(absolute);
    if (!(await lstat(absolute)).isDirectory()) {
        throw new ConsumerOperationError('CONSUMER_SOURCE_DIRECTORY', 'Consumer source must be a directory');
    }
    const actual = await realpath(absolute);
    if (relative(absolute, actual) !== '') {
        throw new ConsumerOperationError(
            'CONSUMER_SYMLINK',
            'Consumer source must have a direct canonical filesystem path',
        );
    }
    const files: CapturedConsumerFile[] = [];
    const seen = new Set<string>();
    let total = 0;
    async function walk(directory: string, prefix: string): Promise<void> {
        const names = (await readdir(directory)).sort();
        for (const name of names) {
            const logical = portablePath(prefix === '' ? name : `${prefix}/${name}`);
            const folded = logical.normalize('NFC').toLowerCase();
            if (seen.has(folded)) {
                throw new ConsumerOperationError(
                    'CONSUMER_PATH_COLLISION',
                    'Consumer source has nonportable colliding paths',
                );
            }
            seen.add(folded);
            const file = join(directory, name);
            const stat = await lstat(file);
            if (stat.isSymbolicLink()) {
                throw new ConsumerOperationError('CONSUMER_SYMLINK', 'Consumer source contains a symbolic link');
            }
            if (stat.isDirectory()) {
                await walk(file, logical);
            } else if (stat.isFile()) {
                const bytes = await readRegularFile(file);
                total += bytes.length;
                if (files.length >= CONSUMER_FILE_LIMITS.files || total > CONSUMER_FILE_LIMITS.totalBytes) {
                    throw new ConsumerOperationError('CONSUMER_INPUT_LIMIT', 'Consumer source exceeds capture limits');
                }
                files.push({ path: logical, sha256: sha256(bytes), bytes });
            } else {
                throw new ConsumerOperationError('CONSUMER_SPECIAL_FILE', 'Consumer source contains a nonregular file');
            }
        }
        if (JSON.stringify(names) !== JSON.stringify((await readdir(directory)).sort())) {
            throw new ConsumerOperationError(
                'CONSUMER_INPUT_CHANGED',
                'Consumer source directory changed during capture',
            );
        }
    }
    await walk(absolute, '');
    return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export async function writeNewFile(value: string, bytes: Uint8Array | string): Promise<void> {
    await noSymlinkPath(dirname(resolve(value)));
    const handle = await open(value, 'wx');
    try {
        await handle.writeFile(bytes);
    } finally {
        await handle.close();
    }
}

export async function newDirectory(value: string): Promise<void> {
    await noSymlinkPath(dirname(resolve(value)));
    await mkdir(value);
}

export async function writeTree(root: string, files: readonly CapturedConsumerFile[]): Promise<void> {
    for (const file of files) {
        const logical = portablePath(file.path);
        const target = resolve(root, ...logical.split('/'));
        if (!within(root, target)) {
            throw new ConsumerOperationError('CONSUMER_UNSAFE_PATH', 'Consumer destination escaped its root');
        }
        await mkdir(dirname(target), { recursive: true });
        await writeNewFile(target, file.bytes);
    }
}
