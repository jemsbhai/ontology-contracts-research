import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { runConsumerCommand, type CliConsumerRuntime } from '../src/consumer.js';

function context(result: unknown = { status: 'passed' }) {
    const execute = vi.fn(() => Promise.resolve(result));
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
        execute,
        stdout,
        stderr,
        runtime: {
            cwd: () => resolve('consumer-fixture'),
            stdout: {
                write: (value: string) => {
                    stdout.push(value);
                },
            },
            stderr: {
                write: (value: string) => {
                    stderr.push(value);
                },
            },
            consumer: {
                lock: execute,
                pack: execute,
                install: execute,
                run: execute,
                verify: execute,
            } as unknown as CliConsumerRuntime,
        },
    };
}

describe('consumer command boundary', () => {
    it.each([
        ['run', 'plan.json'],
        ['pack', 'plan.json', '--output', 'capsule.json'],
        ['run', 'plan.json', '--lock', 'lock.json', '--output', 'out', '--ignore-failures'],
        ['lock', 'plan.json', '--output', 'one', '--output', 'two'],
        ['verify', 'plan.json', '--lock', 'lock.json', '--report', 'report.json', '--json', '--json'],
    ])('rejects malformed arguments before invoking a filesystem operation: %j', async (...args) => {
        const captured = context();
        expect(await runConsumerCommand(args, captured.runtime)).toBe(2);
        expect(captured.execute).not.toHaveBeenCalled();
    });

    it('uses the caller working directory and preserves failed evaluation status', async () => {
        const captured = context({ status: 'failed', coverage: 'complete' });
        expect(
            await runConsumerCommand(
                ['run', 'plan.json', '--lock', 'lock.json', '--output', 'out', '--json'],
                captured.runtime,
            ),
        ).toBe(1);
        expect(captured.execute).toHaveBeenCalledWith({
            planPath: resolve('consumer-fixture/plan.json'),
            lockPath: resolve('consumer-fixture/lock.json'),
            outputPath: resolve('consumer-fixture/out'),
        });
        expect(JSON.parse(captured.stdout.join(''))).toEqual({ status: 'failed', coverage: 'complete' });
    });

    it('distinguishes valid evidence of a failed experiment from invalid evidence', async () => {
        for (const valid of [true, false]) {
            const captured = context({ valid, status: 'failed' });
            expect(
                await runConsumerCommand(
                    ['verify', 'plan.json', '--lock', 'lock.json', '--report', 'report.json', '--json'],
                    captured.runtime,
                ),
            ).toBe(valid ? 0 : 1);
        }
    });

    it('reports execution errors separately from consumer failures', async () => {
        const captured = context();
        captured.execute.mockRejectedValue(new Error('source bytes changed'));
        expect(await runConsumerCommand(['lock', 'plan.json', '--output', 'lock.json'], captured.runtime)).toBe(3);
        expect(captured.stderr.join('')).toContain('source bytes changed');
    });
});
