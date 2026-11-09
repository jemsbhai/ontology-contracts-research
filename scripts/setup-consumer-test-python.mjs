// Give the consumer tests their declared HTTP client without depending on a runner's ambient site packages.
// The base Python remains runner-provided and is logged; the test dependency wheels are hash-locked.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const requested = process.env['ERDEN_CONSUMER_TEST_PYTHON'] ?? (process.platform === 'win32' ? 'python' : 'python3');
const base = execFileSync(requested, ['-c', 'import os, sys; print(os.path.realpath(sys.executable))'], {
    encoding: 'utf8',
}).trim();
const directory = realpathSync(mkdtempSync(join(process.env['RUNNER_TEMP'] ?? tmpdir(), 'erden-consumer-tests-')));
execFileSync(base, ['-m', 'venv', '--copies', directory], { stdio: 'inherit' });
const python = realpathSync(join(directory, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'));
const requirements = join(dirname(fileURLToPath(import.meta.url)), 'consumer-test-requirements.txt');
execFileSync(
    python,
    [
        '-m',
        'pip',
        '--isolated',
        'install',
        '--disable-pip-version-check',
        '--require-hashes',
        '--only-binary=:all:',
        '--no-compile',
        '--requirement',
        requirements,
    ],
    { stdio: 'inherit' },
);
execFileSync(python, ['-m', 'pip', '--isolated', 'check'], { stdio: 'inherit' });
execFileSync(python, ['--version'], { stdio: 'inherit' });
execFileSync(python, ['-m', 'pip', '--isolated', 'freeze'], { stdio: 'inherit' });
if (/[\r\n]/u.test(python)) {
    throw new Error('The test Python path must fit on one environment-file line');
}
const setting = `ERDEN_CONSUMER_TEST_PYTHON=${python}\n`;
if (process.env['GITHUB_ENV'] !== undefined) {
    appendFileSync(process.env['GITHUB_ENV'], setting, 'utf8');
}
process.stdout.write(setting);
