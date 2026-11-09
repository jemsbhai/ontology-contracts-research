import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ConsumerPlan } from '@erden/contracts';

import { canonicalJson, sha256 } from '../src/consumer/filesystem.js';
import {
    consumerInstall,
    consumerLock,
    consumerPack,
    consumerRun,
    consumerVerify,
    type ConsumerRunReport,
} from '../src/consumer/index.js';
import { required } from '../src/consumer/inputs.js';
import { runConsumerProcess } from '../src/consumer/process.js';

const roots: string[] = [];
const pythonCommand =
    process.env['ERDEN_CONSUMER_TEST_PYTHON'] ?? (process.platform === 'win32' ? 'python' : 'python3');
const python = execFileSync(pythonCommand, ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim();
afterEach(async () => {
    for (const root of roots.splice(0)) {
        const absolute = resolve(root);
        if (!absolute.startsWith(resolve(tmpdir())) || !absolute.includes('erden-consumer-lifecycle-')) {
            throw new Error('Unsafe test cleanup');
        }
        await rm(absolute, { recursive: true, force: true });
    }
});
async function fixture(): Promise<{ root: string; planPath: string; lockPath: string; plan: ConsumerPlan }> {
    const root = await mkdtemp(join(tmpdir(), 'erden-consumer-lifecycle-'));
    roots.push(root);
    for (const version of ['old', 'new']) {
        await mkdir(join(root, version));
        const v = version === 'old' ? 1 : 2;
        const source = `import json, os, pathlib, unittest, urllib.request\nclass Original(unittest.TestCase):\n    def test_resource(self):\n        path = pathlib.Path(os.environ['TMPDIR']) / 'context.json'\n        if not path.exists():\n            path.write_bytes(urllib.request.urlopen('https://example.invalid/v${String(v)}').read())\n        self.assertEqual(json.loads(path.read_text())['version'], ${String(v)})\n    def test_original_other_case(self):\n        self.assertEqual(2 + 2, 4)\n`;
        await writeFile(join(root, version, 'original_tests.py'), source);
        await writeFile(join(root, `v${String(v)}.json`), JSON.stringify({ version: v }));
    }
    const plan: ConsumerPlan = {
        schema: 'erden.consumer-plan/v1',
        id: 'unit-lifecycle',
        python,
        revisions: ['old', 'new'].map((id) => ({
            id,
            directory: id,
            testFile: 'original_tests.py',
            cwd: '.',
            testClasses: ['Original'],
            expectedTests: ['Original.test_original_other_case', 'Original.test_resource'],
        })),
        resources: [1, 2].map((v) => ({
            id: `v${String(v)}`,
            uri: `https://example.invalid/v${String(v)}`,
            file: `v${String(v)}.json`,
            cachePath: 'context.json',
        })),
        arms: [
            { id: 'old', revision: 'old', resources: ['v1'], cache: { kind: 'empty' }, interpretation: 'observe' },
            {
                id: 'upgrade',
                revision: 'new',
                resources: ['v2'],
                cache: { kind: 'inherit', arm: 'old' },
                interpretation: 'observe',
            },
            { id: 'fresh', revision: 'new', resources: ['v2'], cache: { kind: 'empty' }, interpretation: 'observe' },
            {
                id: 'rollback',
                revision: 'old',
                resources: ['v1'],
                cache: { kind: 'inherit', arm: 'fresh' },
                interpretation: 'observe',
            },
            {
                id: 'enforce',
                revision: 'new',
                resources: ['v2'],
                cache: { kind: 'inherit', arm: 'old' },
                interpretation: 'enforce',
            },
            {
                id: 'repair',
                revision: 'new',
                resources: ['v2'],
                cache: { kind: 'seed', resources: ['v2'] },
                interpretation: 'enforce',
            },
        ],
        environment: {},
        timeoutMs: 30_000,
        maxOutputBytes: 2 * 1024 * 1024,
    };
    const planPath = join(root, 'plan.json'),
        lockPath = join(root, 'lock.json');
    await writeFile(planPath, canonicalJson(plan));
    return { root, planPath, lockPath, plan };
}

describe('consumer lifecycle (authored implementation fixtures, not external consumer evidence)', () => {
    it('packages complete inputs, installs to a new tree, executes actual inherited states and verifies honest failures', async () => {
        const f = await fixture();
        await consumerLock({ planPath: f.planPath, outputPath: f.lockPath });
        const capsule = join(f.root, 'capsule.json');
        await consumerPack({ ...f, outputPath: capsule });
        const installed = await consumerInstall({ capsulePath: capsule, destination: join(f.root, 'installed') });
        const outputPath = join(f.root, 'run');
        const report = await consumerRun({ ...installed, outputPath });
        expect(
            report.status,
            JSON.stringify(
                report.arms.map(({ id, status, execution, process, failures }) => ({
                    id,
                    status,
                    execution,
                    process,
                    failures,
                })),
            ),
        ).toBe('failed');
        expect(report.arms.map((arm) => arm.status)).toEqual([
            'passed',
            'failed',
            'passed',
            'failed',
            'refused',
            'passed',
        ]);
        expect(required(report.arms[1]).cacheBeforeSha256).toBe(required(report.arms[0]).cacheAfterSha256);
        expect(required(report.arms[3]).cacheBeforeSha256).toBe(required(report.arms[2]).cacheAfterSha256);
        expect(required(report.arms[4]).execution).toBe('not-run');
        const reportPath = join(outputPath, 'report.json');
        expect(await consumerVerify({ ...installed, reportPath })).toMatchObject({
            valid: true,
            executionStatus: 'failed',
        });
        await expect(
            consumerInstall({ capsulePath: capsule, destination: join(f.root, 'installed') }),
        ).rejects.toThrow();
        await expect(consumerRun({ ...installed, outputPath })).rejects.toThrow();

        const original = await readFile(reportPath, 'utf8');
        const altered = JSON.parse(original) as ConsumerRunReport;
        altered.arms = altered.arms.slice(1);
        await writeFile(reportPath, canonicalJson(altered));
        expect((await consumerVerify({ ...installed, reportPath })).valid).toBe(false);
        const relabeled = JSON.parse(original) as ConsumerRunReport;
        required(relabeled.arms[1]).revision = 'old';
        await writeFile(reportPath, canonicalJson(relabeled));
        expect((await consumerVerify({ ...installed, reportPath })).reasons).toContain(
            'upgrade:source-or-cache-binding',
        );
        const wrongParent = JSON.parse(original) as ConsumerRunReport;
        required(wrongParent.arms[1]).inheritedFrom = 'fresh';
        await writeFile(reportPath, canonicalJson(wrongParent));
        expect((await consumerVerify({ ...installed, reportPath })).reasons).toContain(
            'upgrade:cache-inheritance-binding',
        );
        await writeFile(reportPath, original);

        const extraClaim = JSON.parse(original) as ConsumerRunReport & { completeExecutionProof: boolean };
        extraClaim.completeExecutionProof = true;
        await writeFile(reportPath, canonicalJson(extraClaim));
        expect((await consumerVerify({ ...installed, reportPath })).reasons).toContain('CONSUMER_REPORT_INVALID');
        const truthyIntegrity = JSON.parse(original) as Record<string, unknown>;
        truthyIntegrity.inputIntegrity = 'true';
        await writeFile(reportPath, canonicalJson(truthyIntegrity));
        expect((await consumerVerify({ ...installed, reportPath })).reasons).toContain('CONSUMER_REPORT_INVALID');
        await writeFile(reportPath, original);

        const runnerPath = join(outputPath, 'arms', 'fresh', 'runner.stdout.json');
        const originalRunner = await readFile(runnerPath, 'utf8');
        for (const target of ['report', 'test', 'resource', 'runtime', 'module', 'distribution']) {
            const extra = JSON.parse(originalRunner) as {
                tests: Record<string, unknown>[];
                resourceEvents: Record<string, unknown>[];
                runtime: {
                    moduleFiles: Record<string, unknown>[];
                    distributions: Record<string, unknown>[];
                };
            } & Record<string, unknown>;
            const record =
                target === 'report'
                    ? extra
                    : target === 'test'
                      ? required(extra.tests[0])
                      : target === 'resource'
                        ? required(extra.resourceEvents[0])
                        : target === 'runtime'
                          ? extra.runtime
                          : target === 'module'
                            ? required(extra.runtime.moduleFiles[0])
                            : required(extra.runtime.distributions[0]);
            (record as Record<string, unknown>).completeExecutionProof = true;
            const encoded = canonicalJson(extra);
            await writeFile(runnerPath, encoded);
            const updated = JSON.parse(original) as ConsumerRunReport;
            required(updated.arms[2]).runnerSha256 = sha256(encoded);
            await writeFile(reportPath, canonicalJson(updated));
            expect((await consumerVerify({ ...installed, reportPath })).reasons).toContain('CONSUMER_RUNNER_PROTOCOL');
        }
        const runner = JSON.parse(originalRunner) as { tests: unknown[] };
        runner.tests.pop();
        const bytes = canonicalJson(runner);
        await writeFile(runnerPath, bytes);
        const rebound = JSON.parse(original) as ConsumerRunReport;
        required(rebound.arms[2]).runnerSha256 = sha256(bytes);
        required(rebound.arms[2]).status = 'incomplete';
        required(rebound.arms[2]).testCoverage = 'incomplete';
        required(rebound.arms[2]).failures = ['test-coverage-incomplete'];
        rebound.status = 'incomplete';
        await writeFile(reportPath, canonicalJson(rebound));
        expect((await consumerVerify({ ...installed, reportPath })).reasons).toContain(
            'fresh:incomplete-obligation-coverage',
        );
        for (const mutation of ['skipped', 'duplicate', 'unobserved-resource']) {
            const mutated = JSON.parse(originalRunner) as {
                tests: { id: string; outcome: string }[];
                resourceEvents: unknown[];
            };
            if (mutation === 'skipped') {
                required(mutated.tests[0]).outcome = 'skipped';
            } else if (mutation === 'duplicate') {
                mutated.tests.push({ ...required(mutated.tests[0]) });
            } else {
                mutated.resourceEvents = [];
            }
            const encoded = canonicalJson(mutated);
            await writeFile(runnerPath, encoded);
            const updated = JSON.parse(original) as ConsumerRunReport;
            const arm = required(updated.arms[2]);
            arm.runnerSha256 = sha256(encoded);
            arm.status = 'incomplete';
            updated.status = 'incomplete';
            if (mutation === 'unobserved-resource') {
                arm.resourceCoverage = 'incomplete';
                arm.observedResources = [];
                arm.failures = ['resource-observation-incomplete'];
            } else {
                arm.testCoverage = 'incomplete';
                arm.failures = ['test-coverage-incomplete'];
            }
            await writeFile(reportPath, canonicalJson(updated));
            expect((await consumerVerify({ ...installed, reportPath })).reasons).toContain(
                'fresh:incomplete-obligation-coverage',
            );
        }
    }, 120_000);

    it('rejects source changes and malformed capsules before output creation', async () => {
        const f = await fixture();
        await consumerLock({ planPath: f.planPath, outputPath: f.lockPath });
        const capsule = join(f.root, 'capsule.json');
        await consumerPack({ ...f, outputPath: capsule });
        const raw = JSON.parse(await readFile(capsule, 'utf8')) as {
            files: { path: string; sha256: string; bytes: number; base64: string }[];
        };
        required(raw.files[0]).path = '../escaped';
        const bad = join(f.root, 'bad.json');
        await writeFile(bad, canonicalJson(raw));
        const destination = join(f.root, 'rejected');
        await expect(consumerInstall({ capsulePath: bad, destination })).rejects.toThrow();
        await expect(access(destination)).rejects.toThrow();
        await writeFile(join(f.root, 'new', 'original_tests.py'), '# changed original tests\n');
        await expect(consumerRun({ ...f, outputPath: join(f.root, 'changed-run') })).rejects.toThrow(
            'differs from lock',
        );
        await expect(access(join(f.root, 'changed-run'))).rejects.toThrow();
    });

    it('rejects symbolic-link inputs and refuses to overwrite existing lock files', async () => {
        const f = await fixture();
        await consumerLock({ planPath: f.planPath, outputPath: f.lockPath });
        await expect(consumerLock({ planPath: f.planPath, outputPath: f.lockPath })).rejects.toThrow();
        await mkdir(join(f.root, 'external'));
        await symlink(
            join(f.root, 'external'),
            join(f.root, 'new', 'linked'),
            process.platform === 'win32' ? 'junction' : 'dir',
        );
        await expect(
            consumerLock({ planPath: f.planPath, outputPath: join(f.root, 'linked-lock.json') }),
        ).rejects.toThrow('symbolic');
    });

    it('bounds direct-child wall time and combined output', async () => {
        const timeout = await runConsumerProcess({
            executable: process.execPath,
            arguments: ['-e', 'setTimeout(()=>{},60000)'],
            cwd: tmpdir(),
            environment: process.env,
            timeoutMs: 100,
            maxOutputBytes: 1024,
        });
        expect(timeout.timedOut).toBe(true);
        const output = await runConsumerProcess({
            executable: process.execPath,
            arguments: ['-e', 'process.stdout.write("x".repeat(100000))'],
            cwd: tmpdir(),
            environment: process.env,
            timeoutMs: 10_000,
            maxOutputBytes: 1024,
        });
        expect(output.outputLimit).toBe(true);
        expect(output.stdout.length + output.stderr.length).toBeLessThanOrEqual(1024);
    });
});
