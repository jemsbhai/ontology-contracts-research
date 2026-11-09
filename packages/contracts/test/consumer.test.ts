import { describe, expect, it } from 'vitest';

import { assertConsumerRelativePath, parseConsumerPlan, type ConsumerPlan } from '../src/consumer.js';

const plan: ConsumerPlan = {
    schema: 'erden.consumer-plan/v1',
    id: 'consumer',
    python: 'python',
    revisions: [
        {
            id: 'old',
            directory: 'source',
            testFile: 'tests/test_app.py',
            cwd: 'tests',
            testClasses: ['AppTest'],
            expectedTests: ['AppTest.test_parse'],
        },
    ],
    resources: [
        { id: 'v1', uri: 'https://example.test/v1', file: 'resources/v1.json', cachePath: 'context.json' },
        { id: 'v2', uri: 'https://example.test/v2', file: 'resources/v2.json', cachePath: 'context.json' },
    ],
    arms: [
        { id: 'fresh', revision: 'old', resources: ['v1'], cache: { kind: 'empty' }, interpretation: 'observe' },
        {
            id: 'upgrade',
            revision: 'old',
            resources: ['v2'],
            cache: { kind: 'inherit', arm: 'fresh' },
            interpretation: 'observe',
        },
    ],
    environment: {},
    timeoutMs: 10000,
    maxOutputBytes: 1048576,
};

describe('consumer contract admission', () => {
    it('keeps a retained cache distinct from a desired resource version', () => {
        expect(parseConsumerPlan(JSON.stringify(plan))).toEqual(plan);
    });

    it.each(['../outside', '/absolute', 'C:/outside', 'a\\b', 'a/../../b', 'a/CON.txt', 'a./file', 'a/*', 'a\0b'])(
        'rejects paths that could escape or alias an installed capsule: %s',
        (path) => {
            expect(() => {
                assertConsumerRelativePath(path);
            }).toThrow();
        },
    );

    it('refuses ambiguous cache ownership within one arm', () => {
        expect(() =>
            parseConsumerPlan(JSON.stringify({ ...plan, arms: [{ ...plan.arms[0], resources: ['v1', 'v2'] }] })),
        ).toThrow(/Conflicting cache aliases/u);
    });

    it('refuses forward or circular cache-state references', () => {
        expect(() => parseConsumerPlan(JSON.stringify({ ...plan, arms: [...plan.arms].reverse() }))).toThrow(
            /earlier arm/u,
        );
    });

    it('does not admit an empty original oracle or duplicate test identity', () => {
        for (const expectedTests of [[], ['AppTest.test_parse', 'AppTest.test_parse']]) {
            expect(() =>
                parseConsumerPlan(JSON.stringify({ ...plan, revisions: [{ ...plan.revisions[0], expectedTests }] })),
            ).toThrow();
        }
    });

    it('rejects unknown policy fields and interpreter environment injection', () => {
        expect(() => parseConsumerPlan(JSON.stringify({ ...plan, ignoreFailures: true }))).toThrow(/unknown field/u);
        expect(() => parseConsumerPlan(JSON.stringify({ ...plan, environment: { PYTHONPATH: '/outside' } }))).toThrow(
            /Reserved/u,
        );
    });

    it('rejects credentials in resource URLs and unbounded execution', () => {
        expect(() =>
            parseConsumerPlan(
                JSON.stringify({
                    ...plan,
                    resources: [{ ...plan.resources[0], uri: 'https://user:secret@example.test/context' }],
                }),
            ),
        ).toThrow();
        expect(() => parseConsumerPlan(JSON.stringify({ ...plan, timeoutMs: 0 }))).toThrow(/timeout/u);
    });
});
