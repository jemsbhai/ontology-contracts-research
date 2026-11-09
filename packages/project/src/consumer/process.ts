import { spawn } from 'node:child_process';

export interface ConsumerProcessResult {
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly stdout: Uint8Array;
    readonly stderr: Uint8Array;
    readonly timedOut: boolean;
    readonly outputLimit: boolean;
}

/** Bounded direct-child execution; this is not an OS sandbox or arbitrary descendant-process containment. */
export function runConsumerProcess(input: {
    readonly executable: string;
    readonly arguments: readonly string[];
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
}): Promise<ConsumerProcessResult> {
    return new Promise((resolve, reject) => {
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let total = 0;
        let timedOut = false;
        let outputLimit = false;
        let settled = false;
        const child = spawn(input.executable, [...input.arguments], {
            cwd: input.cwd,
            env: { ...input.environment },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            shell: false,
        });
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, input.timeoutMs);
        function capture(chunk: Buffer, target: Buffer[]): void {
            if (outputLimit) {
                return;
            }
            const remaining = input.maxOutputBytes - total;
            if (chunk.byteLength > remaining) {
                if (remaining > 0) {
                    target.push(chunk.subarray(0, remaining));
                }
                total = input.maxOutputBytes;
                outputLimit = true;
                child.kill('SIGKILL');
            } else {
                total += chunk.byteLength;
                target.push(chunk);
            }
        }
        child.stdout.on('data', (chunk: Buffer) => {
            capture(chunk, stdout);
        });
        child.stderr.on('data', (chunk: Buffer) => {
            capture(chunk, stderr);
        });
        child.once('error', (error) => {
            clearTimeout(timer);
            if (!settled) {
                settled = true;
                reject(error);
            }
        });
        child.once('close', (exitCode, signal) => {
            clearTimeout(timer);
            if (!settled) {
                settled = true;
                resolve({
                    exitCode,
                    signal,
                    stdout: Buffer.concat(stdout),
                    stderr: Buffer.concat(stderr),
                    timedOut,
                    outputLimit,
                });
            }
        });
    });
}
