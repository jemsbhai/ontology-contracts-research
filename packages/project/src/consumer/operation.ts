import { lstat, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { ConsumerArm, ConsumerFileIdentity, ConsumerRunnerInput, ConsumerRunnerResult } from '@erden/contracts';

import {
    canonicalJson,
    captureTree,
    ConsumerOperationError,
    newDirectory,
    readRegularFile,
    sha256,
    writeNewFile,
    writeTree,
} from './filesystem.js';
import {
    checkLock,
    identities,
    loadInputs,
    protectOutput,
    required,
    same,
    treeDigest,
    utf8,
    validateFilePaths,
    type LoadedInputs,
} from './inputs.js';
import { runConsumerProcess } from './process.js';
import { PYTHON_CONSUMER_ADAPTER } from './python.js';

export { consumerLock, consumerPack, consumerInstall } from './inputs.js';
export { ConsumerOperationError } from './filesystem.js';
export interface ConsumerCacheMismatch {
    resourceId: string;
    cachePath: string;
    expectedSha256: string;
    actualSha256: string;
}
export interface ConsumerArmReport {
    id: string;
    revision: string;
    interpretation: ConsumerArm['interpretation'];
    cachePolicy: ConsumerArm['cache'];
    status: 'passed' | 'failed' | 'incomplete' | 'refused';
    execution: 'completed' | 'not-run' | 'operational-error';
    inheritedFrom: string | null;
    sourceBeforeSha256: string;
    sourceAfterSha256: string | null;
    cacheBefore: readonly ConsumerFileIdentity[];
    cacheAfter: readonly ConsumerFileIdentity[];
    cacheBeforeSha256: string;
    cacheAfterSha256: string;
    mismatches: readonly ConsumerCacheMismatch[];
    runnerSha256: string | null;
    runnerStderrSha256: string | null;
    process: { exitCode: number | null; signal: string | null; timedOut: boolean; outputLimit: boolean } | null;
    testCoverage: 'complete' | 'incomplete' | 'not-run';
    resourceCoverage: 'complete' | 'incomplete' | 'not-run';
    observedResources: readonly string[];
    failures: readonly string[];
}
export interface ConsumerRunReport {
    schema: 'erden.consumer-run/v1';
    status: 'passed' | 'failed' | 'incomplete';
    scope: 'trusted-python-consumer-runner-not-owl-or-execution-attestation';
    planSha256: string;
    lockSha256: string;
    pythonSha256: string;
    adapterSha256: string;
    inputIntegrity: boolean;
    arms: readonly ConsumerArmReport[];
}
export interface ConsumerVerificationReport {
    schema: 'erden.consumer-verification/v1';
    valid: boolean;
    executionStatus: 'passed' | 'failed' | 'incomplete' | null;
    reasons: readonly string[];
    scope: 'coverage-and-binding-under-trusted-runner-not-cryptographic-execution-proof';
}
function resourceMap(i: LoadedInputs) {
    return new Map(i.plan.resources.map((r) => [r.id, r]));
}
function cacheMismatches(
    i: LoadedInputs,
    arm: ConsumerArm,
    files: readonly ConsumerFileIdentity[],
): ConsumerCacheMismatch[] {
    const resources = resourceMap(i),
        hashes = new Map(i.lock.resources.map((r) => [r.id, r.sha256])),
        cache = new Map(files.map((f) => [f.path, f.sha256]));
    return arm.resources.flatMap((id) => {
        const r = required(resources.get(id)),
            actual = cache.get(r.cachePath),
            expected = required(hashes.get(id));
        return actual !== undefined && actual !== expected
            ? [{ resourceId: id, cachePath: r.cachePath, expectedSha256: expected, actualSha256: actual }]
            : [];
    });
}
function closedRecord(value: unknown, fields: readonly string[], code: string): Record<string, unknown> {
    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        !same(Object.keys(value).sort(), [...fields].sort())
    ) {
        throw new ConsumerOperationError(code, 'Record fields differ from the versioned consumer contract');
    }
    return value as Record<string, unknown>;
}
function parseRunner(bytes: Uint8Array): ConsumerRunnerResult {
    const value: unknown = JSON.parse(utf8.decode(bytes));
    const code = 'CONSUMER_RUNNER_PROTOCOL';
    const r = closedRecord(
        value,
        [
            'schema',
            'id',
            'discoveredTests',
            'tests',
            'resourceEvents',
            'networkAttempts',
            'fatalError',
            'stdout',
            'stderr',
            'runtime',
        ],
        code,
    );
    if (
        r.schema !== 'erden.consumer-runner-result/v1' ||
        typeof r.id !== 'string' ||
        !Array.isArray(r.discoveredTests) ||
        !Array.isArray(r.tests) ||
        !Array.isArray(r.resourceEvents) ||
        !Array.isArray(r.networkAttempts) ||
        !(r.fatalError === null || typeof r.fatalError === 'string') ||
        typeof r.stdout !== 'string' ||
        typeof r.stderr !== 'string' ||
        !r.runtime ||
        typeof r.runtime !== 'object'
    ) {
        throw new ConsumerOperationError('CONSUMER_RUNNER_PROTOCOL', 'Invalid runner report');
    }
    if (
        r.discoveredTests.some((id) => typeof id !== 'string') ||
        r.networkAttempts.some((item) => typeof item !== 'string') ||
        r.tests.length > 8192 ||
        r.discoveredTests.length > 8192 ||
        r.resourceEvents.length > 100_000
    ) {
        throw new ConsumerOperationError('CONSUMER_RUNNER_PROTOCOL', 'Runner report exceeds contract');
    }
    for (const rawItem of r.tests as unknown[]) {
        const item = closedRecord(rawItem, ['id', 'outcome', 'detail'], code);
        if (
            typeof item.id !== 'string' ||
            !['passed', 'failed', 'error', 'skipped'].includes(item.outcome as string) ||
            !(item.detail === null || typeof item.detail === 'string')
        ) {
            throw new ConsumerOperationError('CONSUMER_RUNNER_PROTOCOL', 'Invalid test record');
        }
    }
    for (const rawItem of r.resourceEvents as unknown[]) {
        const item = closedRecord(rawItem, ['kind', 'resourceId', 'url', 'path', 'sha256'], code);
        if (
            !['http', 'cache-read', 'cache-write'].includes(item.kind as string) ||
            typeof item.resourceId !== 'string' ||
            !(item.url === null || typeof item.url === 'string') ||
            !(item.path === null || typeof item.path === 'string') ||
            !(item.sha256 === null || (typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(item.sha256)))
        ) {
            throw new ConsumerOperationError('CONSUMER_RUNNER_PROTOCOL', 'Invalid resource observation');
        }
    }
    const runtime = closedRecord(r.runtime, ['pythonVersion', 'executable', 'distributions', 'moduleFiles'], code);
    if (
        typeof runtime.pythonVersion !== 'string' ||
        typeof runtime.executable !== 'string' ||
        !Array.isArray(runtime.distributions) ||
        !Array.isArray(runtime.moduleFiles)
    ) {
        throw new ConsumerOperationError('CONSUMER_RUNNER_PROTOCOL', 'Invalid runtime observation');
    }
    for (const rawItem of runtime.distributions as unknown[]) {
        const item = closedRecord(rawItem, ['name', 'version'], code);
        if (typeof item.name !== 'string' || typeof item.version !== 'string') {
            throw new ConsumerOperationError('CONSUMER_RUNNER_PROTOCOL', 'Invalid package observation');
        }
    }
    for (const rawItem of runtime.moduleFiles as unknown[]) {
        const item = closedRecord(rawItem, ['path', 'sha256'], code);
        if (typeof item.path !== 'string' || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sha256)) {
            throw new ConsumerOperationError('CONSUMER_RUNNER_PROTOCOL', 'Invalid module observation');
        }
    }
    return r as unknown as ConsumerRunnerResult;
}
function parseRunReport(value: unknown): ConsumerRunReport {
    const code = 'CONSUMER_REPORT_INVALID';
    const r = closedRecord(
        value,
        [
            'schema',
            'status',
            'scope',
            'planSha256',
            'lockSha256',
            'pythonSha256',
            'adapterSha256',
            'inputIntegrity',
            'arms',
        ],
        code,
    );
    if (!Array.isArray(r.arms) || typeof r.inputIntegrity !== 'boolean') {
        throw new ConsumerOperationError(code, 'Invalid run report');
    }
    for (const rawArm of r.arms as unknown[]) {
        const arm = closedRecord(
            rawArm,
            [
                'id',
                'revision',
                'interpretation',
                'cachePolicy',
                'status',
                'execution',
                'inheritedFrom',
                'sourceBeforeSha256',
                'sourceAfterSha256',
                'cacheBefore',
                'cacheAfter',
                'cacheBeforeSha256',
                'cacheAfterSha256',
                'mismatches',
                'runnerSha256',
                'runnerStderrSha256',
                'process',
                'testCoverage',
                'resourceCoverage',
                'observedResources',
                'failures',
            ],
            code,
        );
        if (
            !Array.isArray(arm.cacheBefore) ||
            !Array.isArray(arm.cacheAfter) ||
            !Array.isArray(arm.mismatches) ||
            !Array.isArray(arm.observedResources) ||
            !Array.isArray(arm.failures) ||
            arm.observedResources.some((id) => typeof id !== 'string') ||
            arm.failures.some((failure) => typeof failure !== 'string') ||
            typeof arm.id !== 'string' ||
            typeof arm.revision !== 'string' ||
            !['observe', 'enforce'].includes(arm.interpretation as string) ||
            !['passed', 'failed', 'incomplete', 'refused'].includes(arm.status as string) ||
            !['completed', 'not-run', 'operational-error'].includes(arm.execution as string) ||
            !['complete', 'incomplete', 'not-run'].includes(arm.testCoverage as string) ||
            !['complete', 'incomplete', 'not-run'].includes(arm.resourceCoverage as string)
        ) {
            throw new ConsumerOperationError(code, 'Invalid arm report');
        }
        const cache = arm.cachePolicy;
        if (!cache || typeof cache !== 'object' || !('kind' in cache)) {
            throw new ConsumerOperationError(code, 'Invalid cache policy');
        }
        closedRecord(
            cache,
            cache.kind === 'empty' ? ['kind'] : cache.kind === 'seed' ? ['kind', 'resources'] : ['kind', 'arm'],
            code,
        );
        for (const rawFile of [...(arm.cacheBefore as unknown[]), ...(arm.cacheAfter as unknown[])]) {
            closedRecord(rawFile, ['path', 'sha256', 'bytes'], code);
        }
        for (const mismatch of arm.mismatches as unknown[]) {
            closedRecord(mismatch, ['resourceId', 'cachePath', 'expectedSha256', 'actualSha256'], code);
        }
        if (arm.process !== null) {
            const child = closedRecord(arm.process, ['exitCode', 'signal', 'timedOut', 'outputLimit'], code);
            if (
                !(
                    child.exitCode === null ||
                    (typeof child.exitCode === 'number' && Number.isInteger(child.exitCode))
                ) ||
                !(child.signal === null || typeof child.signal === 'string') ||
                typeof child.timedOut !== 'boolean' ||
                typeof child.outputLimit !== 'boolean'
            ) {
                throw new ConsumerOperationError(code, 'Invalid process record');
            }
        }
    }
    return r as unknown as ConsumerRunReport;
}
type Assessment = Pick<
    ConsumerArmReport,
    'testCoverage' | 'resourceCoverage' | 'observedResources' | 'failures' | 'status'
>;
function assessRunner(i: LoadedInputs, arm: ConsumerArm, r: ConsumerRunnerResult, cacheDir: string): Assessment {
    const expected = [...required(i.plan.revisions.find((v) => v.id === arm.revision)).expectedTests].sort();
    const completeTests =
        r.id === arm.id &&
        same([...r.discoveredTests].sort(), expected) &&
        same(r.tests.map((t) => t.id).sort(), expected) &&
        r.tests.every((t) => t.outcome !== 'skipped') &&
        r.fatalError === null;
    const failures: string[] = [];
    if (!completeTests) {
        failures.push('test-coverage-incomplete');
    }
    if (r.tests.some((t) => t.outcome === 'failed' || t.outcome === 'error')) {
        failures.push('original-test-failure');
    }
    if (r.networkAttempts.length) {
        failures.push('undeclared-network-attempt');
    }
    if (r.fatalError !== null) {
        failures.push('runner-setup-error');
    }
    if (resolve(r.runtime.executable) !== i.python) {
        failures.push('runtime-identity-mismatch');
    }
    const observed = new Set<string>(),
        resources = resourceMap(i),
        hashes = new Map(i.lock.resources.map((v) => [v.id, v.sha256]));
    for (const e of r.resourceEvents) {
        const resource = resources.get(e.resourceId);
        if (!resource || !arm.resources.includes(e.resourceId)) {
            failures.push('undeclared-resource-observation');
            continue;
        }
        if (e.kind === 'http' && (e.url === null || ![resource.uri, ...(resource.aliases ?? [])].includes(e.url))) {
            failures.push('resource-url-mismatch');
        }
        if (
            e.kind !== 'http' &&
            (e.path === null ||
                (e.path !== resource.cachePath && resolve(e.path) !== resolve(cacheDir, resource.cachePath)))
        ) {
            failures.push('resource-cache-path-mismatch');
        }
        if (e.sha256 !== hashes.get(e.resourceId)) {
            failures.push('resource-identity-mismatch');
        }
        if ((e.kind === 'http' || e.kind === 'cache-read') && e.sha256 !== null) {
            observed.add(e.resourceId);
        }
    }
    const completeResources = arm.resources.every((id) => observed.has(id));
    if (!completeResources) {
        failures.push('resource-observation-incomplete');
    }
    return {
        testCoverage: completeTests ? 'complete' : 'incomplete',
        resourceCoverage: completeResources ? 'complete' : 'incomplete',
        observedResources: [...observed].sort(),
        failures: [...new Set(failures)].sort(),
        status: !completeTests || !completeResources ? 'incomplete' : failures.length ? 'failed' : 'passed',
    };
}
async function verifyModules(r: ConsumerRunnerResult, seen: Map<string, string>): Promise<void> {
    const paths = new Set<string>();
    for (const module of r.runtime.moduleFiles) {
        const path = resolve(module.path);
        if (
            paths.has(path) ||
            sha256(await readRegularFile(path)) !== module.sha256 ||
            (seen.has(path) && seen.get(path) !== module.sha256)
        ) {
            throw new ConsumerOperationError(
                'CONSUMER_RUNTIME_MODULE_CHANGED',
                'Observed Python module identity changed',
            );
        }
        paths.add(path);
        seen.set(path, module.sha256);
    }
}
async function seedCache(i: LoadedInputs, arm: ConsumerArm, directory: string, root: string): Promise<void> {
    if (arm.cache.kind === 'inherit') {
        await writeTree(directory, await captureTree(join(root, 'arms', arm.cache.arm, 'cache')));
    } else if (arm.cache.kind === 'seed') {
        const resources = resourceMap(i);
        const files = arm.cache.resources.map((id) => {
            const bytes = required(i.resources.get(id));
            return { path: required(resources.get(id)).cachePath, sha256: sha256(bytes), bytes };
        });
        validateFilePaths(files.map((f) => f.path));
        await writeTree(directory, files);
    }
}
function environment(plan: LoadedInputs['plan']): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {};
    // Host essentials are inherited explicitly; this is not complete OS/runtime hermeticity.
    for (const key of [
        'SystemRoot',
        'SYSTEMROOT',
        'WINDIR',
        'COMSPEC',
        'PATH',
        'PATHEXT',
        'LANG',
        'LC_ALL',
        'TZ',
        'APPDATA',
        'LOCALAPPDATA',
    ]) {
        if (process.env[key] !== undefined) {
            env[key] = process.env[key];
        }
    }
    return { ...env, ...plan.environment, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', PYTHONHASHSEED: '0' };
}
export async function consumerRun(o: {
    planPath: string;
    lockPath: string;
    outputPath: string;
}): Promise<ConsumerRunReport> {
    const i = await loadInputs(o.planPath),
        lockBytes = await checkLock(i, o.lockPath),
        root = resolve(o.outputPath);
    protectOutput(i, root, [o.planPath, o.lockPath]);
    await newDirectory(root);
    await mkdir(join(root, 'arms'));
    await mkdir(join(root, 'resources'));
    const adapterPath = join(root, 'adapter.py');
    await writeNewFile(adapterPath, PYTHON_CONSUMER_ADAPTER);
    await writeNewFile(join(root, 'plan.json'), i.planBytes);
    await writeNewFile(join(root, 'lock.json'), lockBytes);
    for (const [id, bytes] of i.resources) {
        await writeNewFile(join(root, 'resources', resourceFile(i, id)), bytes);
    }
    const arms: ConsumerArmReport[] = [],
        modules = new Map<string, string>();
    for (const arm of i.plan.arms) {
        const directory = join(root, 'arms', arm.id),
            source = join(directory, 'source'),
            cache = join(directory, 'cache'),
            initial = join(directory, 'initial-cache');
        await newDirectory(directory);
        await newDirectory(source);
        await newDirectory(cache);
        await newDirectory(initial);
        await writeTree(source, required(i.revisions.get(arm.revision)));
        await seedCache(i, arm, cache, root);
        const beforeFiles = await captureTree(cache);
        await writeTree(initial, beforeFiles);
        const before = identities(beforeFiles),
            mismatches = cacheMismatches(i, arm, before),
            sourceBeforeSha256 = required(i.lock.revisions.find((r) => r.id === arm.revision)).sha256;
        const common = {
            id: arm.id,
            revision: arm.revision,
            interpretation: arm.interpretation,
            cachePolicy: arm.cache,
            inheritedFrom: arm.cache.kind === 'inherit' ? arm.cache.arm : null,
            sourceBeforeSha256,
            cacheBefore: before,
            cacheBeforeSha256: treeDigest(before),
            mismatches,
        };
        if (arm.interpretation === 'enforce' && mismatches.length) {
            arms.push({
                ...common,
                status: 'refused',
                execution: 'not-run',
                sourceAfterSha256: sourceBeforeSha256,
                cacheAfter: before,
                cacheAfterSha256: treeDigest(before),
                runnerSha256: null,
                runnerStderrSha256: null,
                process: null,
                testCoverage: 'not-run',
                resourceCoverage: 'not-run',
                observedResources: [],
                failures: ['interpretation-preflight-mismatch'],
            });
            continue;
        }
        const revision = required(i.plan.revisions.find((r) => r.id === arm.revision)),
            resources = resourceMap(i);
        const spec: ConsumerRunnerInput = {
            schema: 'erden.consumer-runner/v1',
            id: arm.id,
            sourceRoot: source,
            testFile: revision.testFile,
            cwd: revision.cwd,
            testClasses: revision.testClasses,
            expectedTests: revision.expectedTests,
            cacheDir: cache,
            resources: arm.resources.map((id) => ({
                id,
                uris: [required(resources.get(id)).uri, ...(required(resources.get(id)).aliases ?? [])],
                cachePath: required(resources.get(id)).cachePath,
                sourcePath: join(root, 'resources', resourceFile(i, id)),
                sha256: required(i.lock.resources.find((r) => r.id === id)).sha256,
            })),
        };
        const input = join(directory, 'runner-input.json');
        await writeNewFile(input, canonicalJson(spec));
        let stdout: Uint8Array = new Uint8Array(),
            stderr: Uint8Array = new Uint8Array(),
            child: ConsumerArmReport['process'] = null;
        let execution: ConsumerArmReport['execution'] = 'operational-error';
        let assessment: Assessment = {
            testCoverage: 'incomplete',
            resourceCoverage: 'incomplete',
            observedResources: [],
            failures: ['runner-operational-error'],
            status: 'incomplete',
        };
        try {
            const result = await runConsumerProcess({
                executable: i.python,
                arguments: [adapterPath, input],
                cwd: source,
                environment: environment(i.plan),
                timeoutMs: i.plan.timeoutMs,
                maxOutputBytes: i.plan.maxOutputBytes,
            });
            stdout = result.stdout;
            stderr = result.stderr;
            child = {
                exitCode: result.exitCode,
                signal: result.signal,
                timedOut: result.timedOut,
                outputLimit: result.outputLimit,
            };
            if (result.exitCode === 0 && !result.timedOut && !result.outputLimit) {
                const runner = parseRunner(stdout);
                assessment = assessRunner(i, arm, runner, cache);
                execution = 'completed';
                await verifyModules(runner, modules);
            }
        } catch (error) {
            assessment = {
                ...assessment,
                status: 'incomplete',
                failures: [
                    ...assessment.failures,
                    error instanceof ConsumerOperationError ? error.code : 'runner-operational-error',
                ],
            };
        }
        await writeNewFile(join(directory, 'runner.stdout.json'), stdout);
        await writeNewFile(join(directory, 'runner.stderr.txt'), stderr);
        let sourceAfterSha256: string | null = null;
        try {
            sourceAfterSha256 = treeDigest(identities(await captureTree(source)));
        } catch {
            /* No integrity claim for malformed source. */
        }
        if (sourceAfterSha256 !== sourceBeforeSha256) {
            assessment = { ...assessment, status: 'incomplete', failures: [...assessment.failures, 'source-changed'] };
        }
        const after = identities(await captureTree(cache));
        if (mismatches.length && assessment.status === 'passed') {
            assessment = {
                ...assessment,
                status: 'failed',
                failures: [...assessment.failures, 'interpretation-cache-mismatch'],
            };
        }
        arms.push({
            ...common,
            ...assessment,
            execution,
            sourceAfterSha256,
            cacheAfter: after,
            cacheAfterSha256: treeDigest(after),
            runnerSha256: sha256(stdout),
            runnerStderrSha256: sha256(stderr),
            process: child,
        });
    }
    let inputIntegrity = false;
    try {
        inputIntegrity =
            same((await loadInputs(o.planPath)).lock, i.lock) &&
            sha256(await readRegularFile(o.lockPath)) === sha256(lockBytes);
    } catch {
        /* Input drift prevents success. */
    }
    const status =
        !inputIntegrity || arms.some((a) => a.status === 'incomplete')
            ? 'incomplete'
            : arms.some((a) => a.status !== 'passed')
              ? 'failed'
              : 'passed';
    const report: ConsumerRunReport = {
        schema: 'erden.consumer-run/v1',
        status,
        scope: 'trusted-python-consumer-runner-not-owl-or-execution-attestation',
        planSha256: i.lock.planSha256,
        lockSha256: sha256(lockBytes),
        pythonSha256: i.lock.pythonSha256,
        adapterSha256: i.lock.adapterSha256,
        inputIntegrity,
        arms,
    };
    await writeNewFile(join(root, 'report.json'), canonicalJson(report));
    return report;
}
function resourceFile(i: LoadedInputs, id: string): string {
    const file = required(i.plan.resources.find((r) => r.id === id)).file;
    const extension = file.slice(file.lastIndexOf('/') + 1).includes('.') ? file.slice(file.lastIndexOf('.')) : '';
    return `${id}${extension}`;
}
export async function consumerVerify(o: {
    planPath: string;
    lockPath: string;
    reportPath: string;
}): Promise<ConsumerVerificationReport> {
    const reasons: string[] = [];
    let executionStatus: ConsumerVerificationReport['executionStatus'] = null;
    try {
        const i = await loadInputs(o.planPath),
            lockBytes = await checkLock(i, o.lockPath);
        const raw: unknown = JSON.parse(utf8.decode(await readRegularFile(o.reportPath)));
        const r = parseRunReport(raw),
            root = dirname(resolve(o.reportPath));
        if (
            (raw as Record<string, unknown>).schema !== 'erden.consumer-run/v1' ||
            (raw as Record<string, unknown>).scope !==
                'trusted-python-consumer-runner-not-owl-or-execution-attestation' ||
            !['passed', 'failed', 'incomplete'].includes(r.status) ||
            r.planSha256 !== i.lock.planSha256 ||
            r.lockSha256 !== sha256(lockBytes) ||
            r.pythonSha256 !== i.lock.pythonSha256 ||
            r.adapterSha256 !== i.lock.adapterSha256 ||
            (raw as Record<string, unknown>).inputIntegrity !== true
        ) {
            reasons.push('report-identity-or-input-integrity');
        }
        if (
            sha256(await readRegularFile(join(root, 'adapter.py'))) !== i.lock.adapterSha256 ||
            sha256(await readRegularFile(join(root, 'plan.json'))) !== i.lock.planSha256 ||
            sha256(await readRegularFile(join(root, 'lock.json'))) !== sha256(lockBytes)
        ) {
            reasons.push('retained-execution-input-mismatch');
        }
        for (const resource of i.lock.resources) {
            if (
                sha256(await readRegularFile(join(root, 'resources', resourceFile(i, resource.id)))) !== resource.sha256
            ) {
                reasons.push('retained-resource-mismatch');
            }
        }
        if (
            !same(
                r.arms.map((a) => a.id),
                i.plan.arms.map((a) => a.id),
            )
        ) {
            reasons.push('arm-coverage-or-order');
        }
        const validated = new Map<string, ConsumerArmReport>(),
            modules = new Map<string, string>();
        for (let n = 0; n < i.plan.arms.length; n += 1) {
            const arm = required(i.plan.arms[n]),
                recorded = r.arms[n];
            if (!recorded || recorded.id !== arm.id) {
                continue;
            }
            const dir = join(root, 'arms', arm.id),
                cacheDir = join(dir, 'cache');
            const before = identities(await captureTree(join(dir, 'initial-cache'))),
                after = identities(await captureTree(cacheDir));
            const sourceAfter = treeDigest(identities(await captureTree(join(dir, 'source')))),
                expectedSource = required(i.lock.revisions.find((v) => v.id === arm.revision)).sha256;
            const mismatches = cacheMismatches(i, arm, before);
            if (
                recorded.revision !== arm.revision ||
                recorded.interpretation !== arm.interpretation ||
                !same(recorded.cachePolicy, arm.cache) ||
                recorded.sourceBeforeSha256 !== expectedSource ||
                recorded.sourceAfterSha256 !== sourceAfter ||
                sourceAfter !== expectedSource ||
                !same(recorded.cacheBefore, before) ||
                !same(recorded.cacheAfter, after) ||
                recorded.cacheBeforeSha256 !== treeDigest(before) ||
                recorded.cacheAfterSha256 !== treeDigest(after) ||
                !same(recorded.mismatches, mismatches)
            ) {
                reasons.push(`${arm.id}:source-or-cache-binding`);
            }
            if (arm.cache.kind === 'empty' && before.length) {
                reasons.push(`${arm.id}:initial-cache-not-empty`);
            }
            if (arm.cache.kind === 'seed') {
                const resources = resourceMap(i);
                const expected = arm.cache.resources
                    .map((id) => ({
                        path: required(resources.get(id)).cachePath,
                        sha256: required(i.lock.resources.find((v) => v.id === id)).sha256,
                        bytes: required(i.resources.get(id)).length,
                    }))
                    .sort((a, b) => (a.path < b.path ? -1 : 1));
                if (!same(before, expected)) {
                    reasons.push(`${arm.id}:seed-binding`);
                }
            }
            if (arm.cache.kind === 'inherit') {
                const parent = validated.get(arm.cache.arm);
                if (!parent || recorded.inheritedFrom !== arm.cache.arm || !same(before, parent.cacheAfter)) {
                    reasons.push(`${arm.id}:cache-inheritance-binding`);
                }
            } else if (recorded.inheritedFrom !== null) {
                reasons.push(`${arm.id}:unexpected-cache-parent`);
            }
            if (arm.interpretation === 'enforce' && mismatches.length) {
                if (
                    recorded.status !== 'refused' ||
                    recorded.execution !== 'not-run' ||
                    recorded.runnerSha256 !== null ||
                    recorded.runnerStderrSha256 !== null ||
                    recorded.process !== null ||
                    recorded.testCoverage !== 'not-run' ||
                    recorded.resourceCoverage !== 'not-run' ||
                    !same(recorded.failures, ['interpretation-preflight-mismatch']) ||
                    !same(recorded.observedResources, []) ||
                    !same(before, after)
                ) {
                    reasons.push(`${arm.id}:invalid-enforcement-refusal`);
                }
                try {
                    await lstat(join(dir, 'runner.stdout.json'));
                    reasons.push(`${arm.id}:refusal-has-execution`);
                } catch (error) {
                    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
                        throw error;
                    }
                }
            } else {
                const revision = required(i.plan.revisions.find((v) => v.id === arm.revision)),
                    resources = resourceMap(i);
                const expectedSpec: ConsumerRunnerInput = {
                    schema: 'erden.consumer-runner/v1',
                    id: arm.id,
                    sourceRoot: join(dir, 'source'),
                    testFile: revision.testFile,
                    cwd: revision.cwd,
                    testClasses: revision.testClasses,
                    expectedTests: revision.expectedTests,
                    cacheDir,
                    resources: arm.resources.map((id) => ({
                        id,
                        uris: [required(resources.get(id)).uri, ...(required(resources.get(id)).aliases ?? [])],
                        cachePath: required(resources.get(id)).cachePath,
                        sourcePath: join(root, 'resources', resourceFile(i, id)),
                        sha256: required(i.lock.resources.find((v) => v.id === id)).sha256,
                    })),
                };
                if (
                    !same(JSON.parse(utf8.decode(await readRegularFile(join(dir, 'runner-input.json')))), expectedSpec)
                ) {
                    reasons.push(`${arm.id}:runner-input-binding`);
                }
                const bytes = await readRegularFile(join(dir, 'runner.stdout.json'), i.plan.maxOutputBytes),
                    stderr = await readRegularFile(join(dir, 'runner.stderr.txt'), i.plan.maxOutputBytes);
                if (
                    recorded.runnerSha256 !== sha256(bytes) ||
                    recorded.runnerStderrSha256 !== sha256(stderr) ||
                    recorded.execution !== 'completed' ||
                    !recorded.process ||
                    recorded.process.exitCode !== 0 ||
                    recorded.process.signal !== null ||
                    recorded.process.timedOut ||
                    recorded.process.outputLimit
                ) {
                    reasons.push(`${arm.id}:runner-execution-binding`);
                }
                const runner = parseRunner(bytes),
                    assessment = assessRunner(i, arm, runner, cacheDir);
                await verifyModules(runner, modules);
                const expectedStatus =
                    mismatches.length && assessment.status === 'passed' ? 'failed' : assessment.status;
                const expectedFailures =
                    mismatches.length && assessment.status === 'passed'
                        ? [...assessment.failures, 'interpretation-cache-mismatch']
                        : assessment.failures;
                if (
                    recorded.status !== expectedStatus ||
                    recorded.testCoverage !== assessment.testCoverage ||
                    recorded.resourceCoverage !== assessment.resourceCoverage ||
                    !same(recorded.observedResources, assessment.observedResources) ||
                    !same(recorded.failures, expectedFailures)
                ) {
                    reasons.push(`${arm.id}:runner-result-mismatch`);
                }
                if (assessment.testCoverage !== 'complete' || assessment.resourceCoverage !== 'complete') {
                    reasons.push(`${arm.id}:incomplete-obligation-coverage`);
                }
            }
            validated.set(arm.id, recorded);
        }
        const expectedStatus = r.arms.some((a) => a.status === 'incomplete')
            ? 'incomplete'
            : r.arms.some((a) => a.status !== 'passed')
              ? 'failed'
              : 'passed';
        if (r.status !== expectedStatus) {
            reasons.push('aggregate-status-mismatch');
        }
        executionStatus = r.status;
    } catch (error) {
        reasons.push(error instanceof ConsumerOperationError ? error.code : 'consumer-verification-error');
    }
    return {
        schema: 'erden.consumer-verification/v1',
        valid: !reasons.length,
        executionStatus,
        reasons: [...new Set(reasons)].sort(),
        scope: 'coverage-and-binding-under-trusted-runner-not-cryptographic-execution-proof',
    };
}
