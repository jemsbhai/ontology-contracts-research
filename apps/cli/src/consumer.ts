import { resolve } from 'node:path';

import { consumerInstall, consumerLock, consumerPack, consumerRun, consumerVerify } from '@erden/project';

export interface CliConsumerRuntime {
    readonly lock: typeof consumerLock;
    readonly pack: typeof consumerPack;
    readonly install: typeof consumerInstall;
    readonly run: typeof consumerRun;
    readonly verify: typeof consumerVerify;
}

export const nodeCliConsumerRuntime: CliConsumerRuntime = {
    lock: consumerLock,
    pack: consumerPack,
    install: consumerInstall,
    run: consumerRun,
    verify: consumerVerify,
};

interface Context {
    readonly cwd: () => string;
    readonly stdout: { readonly write: (text: string) => void };
    readonly stderr: { readonly write: (text: string) => void };
    readonly consumer?: CliConsumerRuntime;
}

const HELP = `Erden consumer transition contracts (explicit Python consumer semantics)

  erden consumer lock <plan.json> --output <lock.json> [--json]
  erden consumer pack <plan.json> --lock <lock.json> --output <capsule.json> [--json]
  erden consumer install <capsule.json> --output <new-directory> [--json]
  erden consumer run <plan.json> --lock <lock.json> --output <new-directory> [--json]
  erden consumer verify <plan.json> --lock <lock.json> --report <report.json> [--json]

Runs unchanged original unittest classes over the complete declared cache-state matrix.
Verification checks evidence coverage and bindings; it trusts the runner and original oracle.
This local capsule workflow does not perform OWL reasoning or registry publication.
`;

export async function runConsumerCommand(args: ReadonlyArray<string>, context: Context): Promise<number> {
    if (args.length === 0 || args[0] === '--help' || args[0] === 'help') {
        context.stdout.write(HELP);
        return 0;
    }
    const command = args[0] ?? '';
    const required: Readonly<Record<string, ReadonlyArray<string>>> = {
        lock: ['--output'],
        pack: ['--lock', '--output'],
        install: ['--output'],
        run: ['--lock', '--output'],
        verify: ['--lock', '--report'],
    };
    const flags = required[command];
    const input = args[1];
    const options = new Map<string, string>();
    let json = false;
    try {
        if (!flags || !input || input.startsWith('-')) {
            throw new TypeError('Expected consumer subcommand and input file');
        }
        for (let i = 2; i < args.length; i += 1) {
            const flag = args[i] as string;
            if (flag === '--json' && !json) {
                json = true;
                continue;
            }
            const value = args[i + 1];
            if (!flags.includes(flag) || options.has(flag) || !value || value.startsWith('-')) {
                throw new TypeError(`Invalid or repeated consumer option: ${flag}`);
            }
            options.set(flag, value);
            i += 1;
        }
        if (flags.some((flag) => !options.has(flag))) {
            throw new TypeError(`Required options: ${flags.join(', ')}`);
        }
    } catch (error) {
        context.stderr.write(`${error instanceof Error ? error.message : 'Invalid consumer arguments'}\n${HELP}`);
        return 2;
    }
    const runtime = context.consumer ?? nodeCliConsumerRuntime;
    function path(value: string): string {
        return resolve(context.cwd(), value);
    }
    const planPath = path(input);
    const outputPath = options.has('--output') ? path(options.get('--output') as string) : '';
    const lockPath = options.has('--lock') ? path(options.get('--lock') as string) : '';
    try {
        let result: unknown;
        switch (command) {
            case 'lock':
                result = await runtime.lock({ planPath, outputPath });
                break;
            case 'pack':
                result = await runtime.pack({ planPath, lockPath, outputPath });
                break;
            case 'install':
                result = await runtime.install({ capsulePath: planPath, destination: outputPath });
                break;
            case 'run':
                result = await runtime.run({ planPath, lockPath, outputPath });
                break;
            case 'verify':
                result = await runtime.verify({
                    planPath,
                    lockPath,
                    reportPath: path(options.get('--report') as string),
                });
                break;
            default:
                throw new TypeError('Unknown consumer command');
        }
        // All commands expose their versioned result in JSON. Text mode adds the operation scope.
        if (!json) {
            context.stdout.write(`Erden consumer ${command}: declared execution contract; no OWL entailment claim.\n`);
        }
        context.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        const record = result as Record<string, unknown>;
        return (command === 'run' && record.status !== 'passed') || (command === 'verify' && record.valid !== true)
            ? 1
            : 0;
    } catch (error) {
        context.stderr.write(
            `Consumer ${command} failed: ${error instanceof Error ? error.message : 'operation failed'}\n`,
        );
        return 3;
    }
}
