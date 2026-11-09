import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ConsumerRunnerInput, ConsumerRunnerResult } from '@erden/contracts';

import { PYTHON_CONSUMER_ADAPTER } from '../src/consumer/python.js';

const PYTHON = process.env['ERDEN_CONSUMER_TEST_PYTHON'] ?? (process.platform === 'win32' ? 'python' : 'python3');

function run(
    source: string,
    classes: ReadonlyArray<string>,
    expected: ReadonlyArray<string>,
    inspect?: (result: ConsumerRunnerResult, root: string) => void,
): ConsumerRunnerResult {
    const root = mkdtempSync(join(tmpdir(), 'erden-consumer-python-'));
    try {
        mkdirSync(join(root, 'source'));
        mkdirSync(join(root, 'cache'));
        writeFileSync(join(root, 'source', 'original_tests.py'), source);
        const payload = Buffer.from('{"answer":42}\n');
        writeFileSync(join(root, 'resource.json'), payload);
        writeFileSync(join(root, 'adapter.py'), PYTHON_CONSUMER_ADAPTER);
        const input: ConsumerRunnerInput = {
            schema: 'erden.consumer-runner/v1',
            id: 'probe',
            sourceRoot: join(root, 'source'),
            cwd: '.',
            testFile: 'original_tests.py',
            testClasses: classes,
            expectedTests: expected,
            cacheDir: join(root, 'cache'),
            resources: [
                {
                    id: 'resource',
                    uris: ['https://example.invalid/resource', 'http://example.invalid/resource'],
                    cachePath: 'resource.json',
                    sourcePath: join(root, 'resource.json'),
                    sha256: createHash('sha256').update(payload).digest('hex'),
                },
            ],
        };
        writeFileSync(join(root, 'input.json'), JSON.stringify(input));
        const bytes = execFileSync(PYTHON, [join(root, 'adapter.py'), join(root, 'input.json')], {
            timeout: 30_000,
            maxBuffer: 16 * 1024 * 1024,
            env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
        });
        const result = JSON.parse(bytes.toString('utf8')) as ConsumerRunnerResult;
        expect(result.schema).toBe('erden.consumer-runner-result/v1');
        expect(result.id).toBe('probe');
        inspect?.(result, root);
        return result;
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

describe('original Python unittest consumer adapter', () => {
    it('records each distribution name and version from the same metadata snapshot', () => {
        const result = run(
            String.raw`
import importlib.metadata, unittest
class ChangingDistribution:
    def __init__(self):
        self.reads = 0
    @property
    def metadata(self):
        self.reads += 1
        return {"Name": "snapshot-" + str(self.reads), "Version": str(self.reads) + ".0"}
    @property
    def version(self):
        return self.metadata["Version"]
class Original(unittest.TestCase):
    def test_snapshot(self):
        distribution = ChangingDistribution()
        importlib.metadata.distributions = lambda: [distribution]
`,
            ['Original'],
            ['Original.test_snapshot'],
        );
        expect(result.fatalError).toBeNull();
        expect(result.tests.map((test) => test.outcome)).toEqual(['passed']);
        expect(result.runtime.distributions).toEqual([{ name: 'snapshot-1', version: '1.0' }]);
    }, 40_000);

    it.each(['Name', 'Version'])(
        'retains the distribution %s size bound',
        (field) => {
            const result = run(
                String.raw`
import importlib.metadata, unittest
class OversizedDistribution:
    metadata = {"Name": "fixture", "Version": "1.0"}
    metadata["${field}"] = "x" * 1025
    @property
    def version(self):
        return self.metadata["Version"]
class Original(unittest.TestCase):
    def test_bound(self):
        importlib.metadata.distributions = lambda: [OversizedDistribution()]
`,
                ['Original'],
                ['Original.test_bound'],
            );
            expect(result.tests.map((test) => test.outcome)).toEqual(['passed']);
            expect(result.fatalError).toContain('Distribution observation bound exceeded');
        },
        40_000,
    );

    it('runs inherited full classes and pins both HTTP transports while observing cache bytes', () => {
        const result = run(
            String.raw`
import json, os, pathlib, unittest, urllib.request
class Base(unittest.TestCase):
    def test_transport(self):
        payload = urllib.request.urlopen("http://example.invalid/resource").read()
        import requests
        response = requests.get("https://example.invalid/resource")
        response.raise_for_status()
        self.assertEqual(payload, response.content)
        path = pathlib.Path(os.environ["TMPDIR"]) / "resource.json"
        path.write_bytes(payload)
        self.assertEqual(json.loads(path.read_bytes()), {"answer": 42})
        print("original stdout")
class Derived(Base):
    pass
`,
            ['Base', 'Derived'],
            ['Base.test_transport', 'Derived.test_transport'],
            (report, root) => {
                expect(readFileSync(join(root, 'cache', 'resource.json'), 'utf8')).toBe('{"answer":42}\n');
                expect(report.runtime.moduleFiles.some((item) => item.path.endsWith('original_tests.py'))).toBe(true);
            },
        );
        expect(result.fatalError).toBeNull();
        expect(result.tests.map((test) => test.outcome)).toEqual(['passed', 'passed']);
        expect(result.discoveredTests).toEqual(['Base.test_transport', 'Derived.test_transport']);
        expect(result.stdout).toContain('original stdout');
        expect(result.stderr).toContain('Ran 2 tests');
        expect(result.networkAttempts).toEqual([]);
        expect(result.resourceEvents.filter((event) => event.kind === 'http')).toHaveLength(4);
        const sha256 = createHash('sha256').update('{"answer":42}\n').digest('hex');
        expect(result.resourceEvents.find((event) => event.kind === 'cache-read')?.sha256).toBe(sha256);
        expect(result.resourceEvents.find((event) => event.kind === 'cache-write')?.sha256).toBe(sha256);
    }, 40_000);

    it('keeps pinned Requests sessions independent of ambient authentication and proxy settings', () => {
        const result = run(
            String.raw`
import unittest
from unittest.mock import patch
import requests
class Original(unittest.TestCase):
    def test_offline_session(self):
        with patch("requests.sessions.get_netrc_auth", side_effect=AssertionError("ambient netrc lookup")), patch("requests.sessions.get_environ_proxies", side_effect=AssertionError("ambient proxy lookup")):
            self.assertEqual(requests.get("https://example.invalid/resource").json(), {"answer": 42})
            with requests.Session() as session:
                self.assertFalse(session.trust_env)
                self.assertEqual(session.get("http://example.invalid/resource").json(), {"answer": 42})
`,
            ['Original'],
            ['Original.test_offline_session'],
        );
        expect(result.fatalError).toBeNull();
        expect(result.tests.map((test) => test.outcome)).toEqual(['passed']);
        expect(result.networkAttempts).toEqual([]);
        expect(result.resourceEvents.filter((event) => event.kind === 'http')).toHaveLength(2);
    }, 40_000);

    it('rejects an incomplete declared inventory before executing any test', () => {
        const result = run(
            String.raw`
import unittest
class Original(unittest.TestCase):
    def test_one(self):
        print("BODY EXECUTED")
    def test_two(self):
        print("BODY EXECUTED")
`,
            ['Original'],
            ['Original.test_one'],
        );
        expect(result.fatalError).toContain('do not exactly match');
        expect(result.discoveredTests).toEqual(['Original.test_one', 'Original.test_two']);
        expect(result.tests).toEqual([]);
        expect(result.stdout).not.toContain('BODY EXECUTED');
    }, 40_000);

    it('retains failures, errors, skips, expected failures and every subtest outcome', () => {
        const result = run(
            String.raw`
import unittest
class Original(unittest.TestCase):
    def test_error(self):
        raise RuntimeError("original error")
    @unittest.expectedFailure
    def test_expected(self):
        self.fail("expected original failure")
    def test_failure(self):
        self.fail("original failure")
    @unittest.skip("original skip")
    def test_skip(self):
        pass
    def test_subtests(self):
        for i in (0, 1):
            with self.subTest(i=i):
                self.assertEqual(i, 0)
    @unittest.expectedFailure
    def test_unexpected(self):
        pass
`,
            ['Original'],
            [
                'Original.test_error',
                'Original.test_expected',
                'Original.test_failure',
                'Original.test_skip',
                'Original.test_subtests',
                'Original.test_unexpected',
            ],
        );
        expect(result.fatalError).toBeNull();
        expect(result.tests.map((test) => test.outcome)).toEqual([
            'error',
            'skipped',
            'failed',
            'skipped',
            'failed',
            'failed',
        ]);
        expect(result.tests.find((test) => test.id === 'Original.test_expected')?.detail).toContain('expected-failure');
        expect(result.tests.find((test) => test.id === 'Original.test_unexpected')?.detail).toBe('unexpected-success');
        const detail = result.tests.find((test) => test.id === 'Original.test_subtests')?.detail;
        expect(detail).toContain('(i=0): passed');
        expect(detail).toContain('(i=1): failed');
    }, 40_000);

    it('does not accept caught undeclared network or subprocess attempts', () => {
        const result = run(
            String.raw`
import socket, subprocess, unittest, urllib.request
class Original(unittest.TestCase):
    def test_boundaries(self):
        with self.assertRaises(PermissionError):
            urllib.request.urlopen("https://undeclared.invalid/")
        with self.assertRaises(PermissionError):
            socket.create_connection(("127.0.0.1", 9))
        with self.assertRaises(PermissionError):
            subprocess.run(["do-not-run", "SECRET_ARGUMENT"], env={"SECRET_ENV": "secret"})
`,
            ['Original'],
            ['Original.test_boundaries'],
        );
        expect(result.fatalError).toContain('Forbidden network or subprocess');
        expect(result.networkAttempts).toHaveLength(3);
        expect(JSON.stringify(result.networkAttempts)).not.toContain('SECRET');
    }, 40_000);

    it('rejects class setup failures and bounded-output overflow instead of zero-test success', () => {
        const result = run(
            String.raw`
import unittest
class Original(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        print("x" * 1048577)
        raise RuntimeError("setup failed")
    def test_never(self):
        pass
`,
            ['Original'],
            ['Original.test_never'],
        );
        expect(result.fatalError).toContain('did not cover every declared test');
        expect(result.fatalError).toContain('Captured test output exceeded');
        expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1_048_576);
        expect(result.tests.some((test) => test.outcome === 'passed')).toBe(false);
    }, 40_000);
});
