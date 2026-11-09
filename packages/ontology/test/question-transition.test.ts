import { createHash } from 'node:crypto';

import { DataFactory, Parser, Store } from 'n3';
import { describe, expect, it, vi } from 'vitest';

import {
    compareCompetencyAnswers,
    encodeQuestionTransitionGraph,
    parseCompetencyQuestionMetadata,
    type AssembledOntology,
    type LoadedCompetencyQuestion,
    type ReleaseQueryEngineInput,
} from '../src/index.js';
import { admitTransitionQuery } from '../src/question-transition/policy.js';
import { admitTermIdentityQuery, TRANSITION_LITERAL_DATATYPE } from '../src/question-transition/term-encoding.js';
import * as releaseQuery from '../src/release-query/index.js';

const OWNER = { canonicalIri: 'urn:consumer', role: 'root' as const, ownedIriPrefixes: ['urn:consumer:'] };
const SELECT = 'SELECT ?value WHERE { <urn:s> <urn:p> ?value }';

function graph(text = ''): AssembledOntology {
    return { dataset: new Store(new Parser().parse(text)), sources: [], provenance: [] };
}

function question(text = SELECT, id = 'q'): LoadedCompetencyQuestion {
    const bytes = Buffer.from(text);
    const parsed = parseCompetencyQuestionMetadata(text);
    return {
        id,
        owner: OWNER,
        locator: `${id}.rq`,
        text,
        bytes,
        contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        placeholders: {},
        metadata: parsed.metadata,
        diagnostics: parsed.diagnostics,
    };
}

describe('consumer question transitions on the actual bounded Oxigraph engine', () => {
    it('detects a constant-cardinality replacement with exact typed witnesses', async () => {
        const result = await compareCompetencyAnswers(
            graph('<urn:s> <urn:p> <urn:old> .'),
            graph('<urn:s> <urn:p> <urn:new> .'),
            [question()],
        );
        expect(result.status).toBe('violated');
        expect(result.questions[0]).toMatchObject({
            before: { bindings: [{ value: { kind: 'iri', value: 'urn:old' } }] },
            after: { bindings: [{ value: { kind: 'iri', value: 'urn:new' } }] },
            removed: [{ value: { kind: 'iri', value: 'urn:old' } }],
            added: [{ value: { kind: 'iri', value: 'urn:new' } }],
        });
    });

    it('evaluates preserve/no-loss/no-gain in the declared direction', async () => {
        const before = graph('<urn:s> <urn:p> <urn:a> .');
        const after = graph('<urn:s> <urn:p> <urn:a>, <urn:b> .');
        expect((await compareCompetencyAnswers(before, after, [question()], { policy: 'no-loss' })).status).toBe(
            'satisfied',
        );
        expect((await compareCompetencyAnswers(before, after, [question()], { policy: 'no-gain' })).status).toBe(
            'violated',
        );
        expect((await compareCompetencyAnswers(after, before, [question()], { policy: 'no-gain' })).status).toBe(
            'satisfied',
        );
        expect((await compareCompetencyAnswers(after, before, [question()], { policy: 'no-loss' })).status).toBe(
            'violated',
        );
    });

    it('preserves an entire multi-question suite and stable answer serialization', async () => {
        const before = graph('<urn:s> <urn:p> <urn:a>, <urn:b> .');
        const after = graph('<urn:s> <urn:p> <urn:b>, <urn:a> .');
        const suite = [question('ASK { <urn:s> <urn:p> <urn:a> }', 'z'), question(SELECT, 'a')];
        const result = await compareCompetencyAnswers(before, after, suite);
        expect(result.status).toBe('satisfied');
        expect(result.questions.map((item) => item.id)).toEqual(['a', 'z']);
        for (const item of result.questions) {
            expect(item.before?.sha256).toBe(item.after?.sha256);
            expect(item.added).toEqual([]);
            expect(item.removed).toEqual([]);
        }
    });

    it('compares SELECT sets rather than row order or multiplicity', async () => {
        const query = question('SELECT ?value WHERE { <urn:s> <urn:p> ?value . ?x <urn:q> <urn:o> }');
        const before = graph('<urn:s> <urn:p> "same" . <urn:x> <urn:q> <urn:o> .');
        const after = graph('<urn:s> <urn:p> "same" . <urn:x> <urn:q> <urn:o> . <urn:y> <urn:q> <urn:o> .');
        const result = await compareCompetencyAnswers(before, after, [query]);
        expect(result.status).toBe('satisfied');
        expect(result.questions[0]?.after?.bindings).toHaveLength(1);
    });

    it('preserves query semantics after a carriage-return-terminated comment', async () => {
        const result = await compareCompetencyAnswers(
            graph('<urn:s> <urn:p> <urn:old> .'),
            graph('<urn:s> <urn:p> <urn:new> .'),
            [question('SELECT ?value WHERE { <urn:s> <urn:p> ?value # comment\r FILTER(false)\n }')],
        );
        expect(result.status).toBe('satisfied');
        expect(result.questions[0]?.before?.bindings).toEqual([]);
        expect(result.questions[0]?.after?.bindings).toEqual([]);
    });

    it('distinguishes IRIs, plain literals, typed literals, languages and unbound variables', async () => {
        const query = question(
            'SELECT ?value ?optional WHERE { <urn:s> <urn:p> ?value . OPTIONAL { <urn:s> <urn:q> ?optional } }',
        );
        const before = graph('<urn:s> <urn:p> <urn:label>, "1", "hello"@en .');
        const after = graph('<urn:s> <urn:p> "urn:label", "1"^^<urn:datatype:integer>, "hello"@fr ; <urn:q> "bound" .');
        const result = await compareCompetencyAnswers(before, after, [query]);
        expect(result.status).toBe('violated');
        expect(result.questions[0]?.removed).toHaveLength(3);
        expect(result.questions[0]?.added).toHaveLength(3);
        expect(result.questions[0]?.before?.bindings.every((row) => !Object.hasOwn(row, 'optional'))).toBe(true);
        expect(result.questions[0]?.after?.bindings.every((row) => Object.hasOwn(row, 'optional'))).toBe(true);
    });

    it('compares normalizing graph literals through an injective opaque encoding', async () => {
        const before = graph(
            '<urn:s> <urn:p> "01"^^<http://www.w3.org/2001/XMLSchema#integer>, "1.00"^^<http://www.w3.org/2001/XMLSchema#decimal> .',
        );
        const after = graph(
            '<urn:s> <urn:p> "1"^^<http://www.w3.org/2001/XMLSchema#integer>, "1.0"^^<http://www.w3.org/2001/XMLSchema#decimal> .',
        );
        const result = await compareCompetencyAnswers(before, after, [question()]);
        expect(result.status).toBe('violated');
        expect(result.reason).toBeNull();
        expect(result.questions[0]?.removed.map((row) => row.value?.value).sort()).toEqual(['01', '1.00']);
        expect(result.questions[0]?.added.map((row) => row.value?.value).sort()).toEqual(['1', '1.0']);
        expect(result.questions[0]?.execution?.encoding).toBe('opaque-literal/v1');
        expect(result.datasets).not.toBeNull();
        expect(result.datasets?.before.sha256).not.toBe(result.datasets?.after.sha256);
        const canonical = graph('<urn:s> <urn:p> "1"^^<http://www.w3.org/2001/XMLSchema#integer> .');
        expect((await compareCompetencyAnswers(canonical, canonical, [question()])).status).toBe('satisfied');
    });

    it('preserves lexical forms and datatype IRIs for booleans, dates and numeric subtypes', async () => {
        const before = graph(`
            <urn:s> <urn:p> "1"^^<http://www.w3.org/2001/XMLSchema#boolean>,
                "2001-01-01T01:00:00+01:00"^^<http://www.w3.org/2001/XMLSchema#dateTime>,
                "01"^^<http://www.w3.org/2001/XMLSchema#unsignedByte>,
                "not-a-number"^^<http://www.w3.org/2001/XMLSchema#integer> .
        `);
        const after = graph(`
            <urn:s> <urn:p> "true"^^<http://www.w3.org/2001/XMLSchema#boolean>,
                "2001-01-01T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>,
                "01"^^<http://www.w3.org/2001/XMLSchema#integer>,
                "not-a-number"^^<http://www.w3.org/2001/XMLSchema#integer> .
        `);
        const result = await compareCompetencyAnswers(before, after, [question()]);
        expect(result.status).toBe('violated');
        expect(result.questions[0]?.removed).toHaveLength(3);
        expect(result.questions[0]?.added).toHaveLength(3);
        expect(result.questions[0]?.before?.bindings).toContainEqual({
            value: {
                kind: 'literal',
                value: '01',
                datatype: 'http://www.w3.org/2001/XMLSchema#unsignedByte',
                language: '',
            },
        });
    });

    it('rewrites typed, numeric, language and escaped query constants without value normalization', async () => {
        const before = graph(
            '<urn:s> <urn:p> "01"^^<http://www.w3.org/2001/XMLSchema#integer>, "say \\"hello\\""@EN .',
        );
        const after = graph('<urn:s> <urn:p> "1"^^<http://www.w3.org/2001/XMLSchema#integer>, "say \\"hello\\""@en .');
        for (const constant of ['"01"^^xsd:integer', '01']) {
            const result = await compareCompetencyAnswers(before, after, [
                question(`PREFIX xsd: <http://www.w3.org/2001/XMLSchema#> ASK { <urn:s> <urn:p> ${constant} }`),
            ]);
            expect(result.questions[0]).toMatchObject({
                status: 'violated',
                before: { bindings: [{}] },
                after: { bindings: [] },
            });
        }
        const language = await compareCompetencyAnswers(before, after, [
            question('SELECT ?s WHERE { ?s <urn:p> "say \\"hello\\""@eN }'),
        ]);
        expect(language.status).toBe('satisfied');
        expect(language.questions[0]?.before?.bindings).toEqual([{ s: { kind: 'iri', value: 'urn:s' } }]);
    });

    it('keeps exact literal joins and sameTerm filters distinct from numeric value equality', async () => {
        const before = graph('<urn:a> <urn:p> 01 . <urn:b> <urn:q> 1 .');
        const after = graph('<urn:a> <urn:p> 01 . <urn:b> <urn:q> 01 .');
        const result = await compareCompetencyAnswers(before, after, [
            question('SELECT ?left ?right ?value WHERE { ?left <urn:p> ?value . ?right <urn:q> ?value }', 'join'),
            question('SELECT ?value WHERE { <urn:b> <urn:q> ?value FILTER(sameTerm(?value, 01)) }', 'same-term'),
            question('SELECT ?value WHERE { <urn:b> <urn:q> ?value FILTER(?value = 1) }', 'value-equality'),
        ]);
        expect(result.questions.map((item) => [item.id, item.status])).toEqual([
            ['join', 'violated'],
            ['same-term', 'violated'],
            ['value-equality', 'indeterminate'],
        ]);
        expect(result.questions[0]?.before?.bindings).toEqual([]);
        expect(result.questions[0]?.after?.bindings).toHaveLength(1);
        expect(result.questions[2]?.reason).toBe('query-outside-term-identity-profile');
    });

    it('preserves optional unbound variables, union, minus and bound Boolean filters', async () => {
        const before = graph('<urn:a> <urn:p> 01 . <urn:b> <urn:q> "bonjour"@FR .');
        const after = graph('<urn:a> <urn:p> 01 ; <urn:q> "bonjour"@fr . <urn:b> <urn:q> "bonjour"@FR .');
        const result = await compareCompetencyAnswers(before, after, [
            question(`
            SELECT ?s ?value ?optional WHERE {
                { ?s <urn:p> ?value } UNION { ?s <urn:q> ?value }
                OPTIONAL { ?s <urn:q> ?optional }
                MINUS { ?s <urn:exclude> ?value }
                FILTER(!BOUND(?optional) || (BOUND(?optional) && sameTerm(?optional, "bonjour"@fr)))
            }
        `),
        ]);
        expect(result.status).toBe('violated');
        expect(result.questions[0]?.before?.bindings).toHaveLength(2);
        expect(result.questions[0]?.after?.bindings).toHaveLength(3);
        expect(result.questions[0]?.before?.bindings.some((row) => !Object.hasOwn(row, 'optional'))).toBe(true);
        expect(result.questions[0]?.after?.bindings.every((row) => Object.hasOwn(row, 'optional'))).toBe(true);
    });

    it('supports VALUES and property paths over literal endpoints', async () => {
        const value = graph('<urn:a> <urn:p> 01, 1 ; <urn:q> <urn:b> . <urn:b> <urn:p> 01 .');
        const result = await compareCompetencyAnswers(value, value, [
            question(`
            SELECT ?s ?value WHERE {
                VALUES ?value { 01 }
                ?s (<urn:p>|<urn:q>/<urn:p>) ?value
            }
        `),
        ]);
        expect(result.status).toBe('satisfied');
        expect(result.questions[0]?.before?.bindings).toHaveLength(2);
        expect(result.questions[0]?.before?.bindings.every((row) => row.value?.value === '01')).toBe(true);
    });

    it('encodes preexisting proxy-datatype literals once, without collisions or recursive decoding', async () => {
        const payload = '["01","http://www.w3.org/2001/XMLSchema#integer",""]';
        const value = graph('<urn:irrelevant> <urn:p> 1 . <urn:s> <urn:p> 01 .');
        value.dataset.addQuad(
            DataFactory.namedNode('urn:s'),
            DataFactory.namedNode('urn:p'),
            DataFactory.literal(payload, DataFactory.namedNode(TRANSITION_LITERAL_DATATYPE)),
        );
        const result = await compareCompetencyAnswers(value, value, [question()]);
        expect(result.status).toBe('satisfied');
        expect(result.questions[0]?.before?.bindings).toHaveLength(2);
        expect(result.questions[0]?.before?.bindings).toContainEqual({
            value: { kind: 'literal', value: payload, datatype: TRANSITION_LITERAL_DATATYPE, language: '' },
        });
    });

    it('admits structural IRI lookups even with irrelevant numeric triples, while preserving resource refusals', async () => {
        const value = graph('<urn:irrelevant> <urn:p> 01 . <urn:s> <urn:p> <urn:a>, <urn:b> .');
        const result = await compareCompetencyAnswers(value, value, [question()]);
        expect(result.status).toBe('satisfied');
        expect(result.questions[0]?.execution?.encoding).toBe('opaque-literal/v1');
        const rows = await compareCompetencyAnswers(value, value, [question()], { maxAnswerRows: 1 });
        expect(rows.questions[0]?.reason).toBe('row-limit');
        expect(rows.questions[0]?.before).toBeNull();
        expect(rows.questions[0]?.after).toBeNull();
        const bytes = await compareCompetencyAnswers(value, value, [question()], { maxAnswerBytes: 1 });
        expect(bytes.questions[0]?.reason).toBe('result-byte-limit');
    });

    it('preserves opaque non-XSD literal datatype and lexical distinctions', async () => {
        const result = await compareCompetencyAnswers(
            graph('<urn:s> <urn:p> "01"^^<urn:datatype:count> .'),
            graph('<urn:s> <urn:p> "1"^^<urn:datatype:count> .'),
            [question()],
        );
        expect(result.status).toBe('violated');
        expect(result.questions[0]?.removed).toEqual([
            { value: { kind: 'literal', value: '01', datatype: 'urn:datatype:count', language: '' } },
        ]);
        expect(result.questions[0]?.added).toEqual([
            { value: { kind: 'literal', value: '1', datatype: 'urn:datatype:count', language: '' } },
        ]);
    });

    it('refuses typed query constants before the engine can collapse a changed branch answer', async () => {
        const query = question(
            'SELECT (IF(EXISTS { <urn:s> <urn:p> <urn:o> }, "01"^^<http://www.w3.org/2001/XMLSchema#integer>, "1"^^<http://www.w3.org/2001/XMLSchema#integer>) AS ?value) WHERE {}',
        );
        const result = await compareCompetencyAnswers(graph(), graph('<urn:s> <urn:p> <urn:o> .'), [query]);
        expect(result.status).toBe('indeterminate');
        expect(result.questions[0]?.reason).toBe('query-outside-profile');
        expect(result.questions[0]?.before).toBeNull();
        expect(result.questions[0]?.after).toBeNull();
    });

    it('compares ASK answers as zero or one empty solution binding', async () => {
        const result = await compareCompetencyAnswers(graph(), graph('<urn:s> <urn:p> <urn:a> .'), [
            question('ASK { <urn:s> <urn:p> ?value }'),
        ]);
        expect(result.status).toBe('violated');
        expect(result.questions[0]).toMatchObject({
            before: { form: 'ask', bindings: [] },
            after: { form: 'ask', bindings: [{}] },
            added: [{}],
            removed: [],
        });
    });

    it('does not compare blank-node output labels across versions', async () => {
        const result = await compareCompetencyAnswers(
            graph('<urn:s> <urn:p> [ <urn:q> <urn:o> ] .'),
            graph('<urn:s> <urn:p> [ <urn:q> <urn:o> ] .'),
            [question()],
        );
        expect(result.status).toBe('indeterminate');
        expect(result.questions[0]?.reason).toBe('unsupported-result-term-or-shape');
    });

    it('allows named answers reached through anonymous structure and source-prefixed blank labels', async () => {
        const value = graph();
        value.dataset.addQuad(
            DataFactory.namedNode('urn:s'),
            DataFactory.namedNode('urn:p'),
            DataFactory.blankNode('source/anonymous/1'),
        );
        value.dataset.addQuad(
            DataFactory.blankNode('source/anonymous/1'),
            DataFactory.namedNode('urn:q'),
            DataFactory.namedNode('urn:o'),
        );
        const result = await compareCompetencyAnswers(value, value, [
            question('SELECT ?value WHERE { <urn:s> <urn:p>/<urn:q> ?value }'),
        ]);
        expect(result.status).toBe('satisfied');
        expect(result.questions[0]?.before?.bindings).toEqual([{ value: { kind: 'iri', value: 'urn:o' } }]);
        expect(
            value.dataset.getQuads(null, null, null, null).some((quad) => quad.subject.value === 'source/anonymous/1'),
        ).toBe(true);
    });

    it('reports row and byte limits as indeterminate instead of comparing partial answers', async () => {
        const value = graph('<urn:s> <urn:p> <urn:a>, <urn:b> .');
        const rows = await compareCompetencyAnswers(value, value, [question()], { maxAnswerRows: 1 });
        expect(rows.status).toBe('indeterminate');
        expect(rows.questions[0]?.reason).toBe('row-limit');
        const bytes = await compareCompetencyAnswers(value, value, [question()], { maxAnswerBytes: 1 });
        expect(bytes.status).toBe('indeterminate');
        expect(bytes.questions[0]?.reason).toBe('result-byte-limit');
    });

    it('exports parseable graph bytes whose identities match the actual worker inputs', async () => {
        const before = graph();
        const anonymous = DataFactory.blankNode('source/anonymous/1');
        before.dataset.addQuad(DataFactory.namedNode('urn:s'), DataFactory.namedNode('urn:p'), anonymous);
        before.dataset.addQuad(anonymous, DataFactory.namedNode('urn:q'), DataFactory.namedNode('urn:old'));
        const after: AssembledOntology = {
            ...before,
            dataset: new Store(before.dataset.getQuads(null, null, null, null)),
        };
        after.dataset.addQuad(anonymous, DataFactory.namedNode('urn:q'), DataFactory.namedNode('urn:new'));
        const beforeBytes = encodeQuestionTransitionGraph(before);
        const afterBytes = encodeQuestionTransitionGraph(after);
        if (beforeBytes === null || afterBytes === null) {
            throw new Error('Expected both default graphs to be exportable');
        }
        const exported = [beforeBytes, afterBytes];
        for (const bytes of exported) {
            expect(bytes.toString()).not.toContain('source/anonymous/1');
            expect(new Parser({ format: 'N-Quads' }).parse(bytes.toString())).toHaveLength(
                bytes === beforeBytes ? 2 : 3,
            );
        }
        const inputs: ReleaseQueryEngineInput[] = [];
        const factory = releaseQuery.makeNodeReleaseQueryEngine;
        const spy = vi.spyOn(releaseQuery, 'makeNodeReleaseQueryEngine').mockImplementation(() => {
            const engine = factory();
            return {
                ...engine,
                execute: (input, signal) => {
                    inputs.push(input);
                    return engine.execute(input, signal);
                },
            };
        });
        try {
            const result = await compareCompetencyAnswers(before, after, [
                question('SELECT ?value WHERE { <urn:s> <urn:p>/<urn:q> ?value }'),
            ]);
            expect(result.status).toBe('violated');
            expect(inputs).toHaveLength(2);
            const datasets = result.datasets;
            if (datasets === null) {
                throw new Error('Expected graph identities after successful encoding');
            }
            for (const [index, side] of (['before', 'after'] as const).entries()) {
                const bytes = exported[index];
                const input = inputs[index];
                const component = input?.declared[0];
                if (bytes === undefined || input === undefined || component === undefined) {
                    throw new Error('Expected captured worker input for both graphs');
                }
                const identity = datasets[side];
                expect(identity).toEqual({
                    sha256: createHash('sha256').update(bytes).digest('hex'),
                    quadCount: index === 0 ? 2 : 3,
                    byteSize: bytes.byteLength,
                });
                expect(input.datasetSha256).toBe(identity.sha256);
                expect(Buffer.from(component.nquads)).toEqual(bytes);
            }
            expect(datasets.before.sha256).not.toBe(datasets.after.sha256);
            expect(before.dataset.getQuads(null, null, null, null).some((quad) => quad.object.equals(anonymous))).toBe(
                true,
            );
        } finally {
            spy.mockRestore();
        }
    });

    it('separately binds original graphs, encoded worker graphs and the actual execution query', async () => {
        const before = graph('<urn:s> <urn:p> 01 .');
        const after = graph('<urn:s> <urn:p> 1 .');
        const inputs: ReleaseQueryEngineInput[] = [];
        const factory = releaseQuery.makeNodeReleaseQueryEngine;
        const spy = vi.spyOn(releaseQuery, 'makeNodeReleaseQueryEngine').mockImplementation(() => {
            const engine = factory();
            return {
                ...engine,
                execute: (input, signal) => {
                    inputs.push(input);
                    return engine.execute(input, signal);
                },
            };
        });
        try {
            const result = await compareCompetencyAnswers(before, after, [question()]);
            const execution = result.questions[0]?.execution;
            expect(result.status).toBe('violated');
            expect(execution?.encoding).toBe('opaque-literal/v1');
            expect(inputs).toHaveLength(2);
            for (const [index, side] of (['before', 'after'] as const).entries()) {
                const value = index === 0 ? before : after;
                const bytes = encodeQuestionTransitionGraph(value, 'opaque-literal/v1');
                const input = inputs[index];
                expect(bytes).not.toBeNull();
                expect(Buffer.from(input?.declared[0]?.nquads ?? [])).toEqual(bytes);
                expect(execution?.datasets[side].sha256).toBe(input?.datasetSha256);
                expect(execution?.datasets[side].byteSize).toBe(bytes?.byteLength);
                expect(execution?.datasets[side].sha256).not.toBe(result.datasets?.[side].sha256);
                expect(execution?.querySha256).toBe(
                    createHash('sha256')
                        .update(input?.engineQuery ?? '')
                        .digest('hex'),
                );
                expect(input?.engineQuery).toContain('LIMIT 1001');
            }
        } finally {
            spy.mockRestore();
        }
    });

    it('rejects mismatched question bytes, missing bindings, and dependency-owned suites', async () => {
        const original = question();
        const result = await compareCompetencyAnswers(graph(), graph(), [
            { ...original, id: 'bytes', text: 'ASK {}' },
            question('ASK { {{missing}} <urn:p> ?o }', 'placeholder'),
            { ...original, id: 'dependency', owner: { ...OWNER, role: 'dependency' } },
        ]);
        expect(result.status).toBe('indeterminate');
        expect(result.questions.map((item) => item.reason)).toEqual([
            'query-content-mismatch',
            'question-not-consumer-owned',
            'query-placeholder-missing',
        ]);
    });

    it('never passes an empty suite, duplicate IDs, cancellation or invalid grammar', async () => {
        expect((await compareCompetencyAnswers(graph(), graph(), [])).status).toBe('indeterminate');
        expect((await compareCompetencyAnswers(graph(), graph(), [question(), question()])).reason).toBe(
            'duplicate-question-id',
        );
        const controller = new AbortController();
        controller.abort();
        expect(
            (await compareCompetencyAnswers(graph(), graph(), [question()], { signal: controller.signal })).questions[0]
                ?.reason,
        ).toBe('cancelled');
        expect(
            (await compareCompetencyAnswers(graph(), graph(), [question('SELECT ?value WHERE { broken }')])).status,
        ).toBe('indeterminate');
    });

    it('does not silently change a named input graph into the default graph', async () => {
        const value = graph();
        value.dataset.addQuad(
            DataFactory.namedNode('urn:s'),
            DataFactory.namedNode('urn:p'),
            DataFactory.namedNode('urn:o'),
            DataFactory.namedNode('urn:g'),
        );
        expect(encodeQuestionTransitionGraph(value)).toBeNull();
        const result = await compareCompetencyAnswers(value, value, [question()]);
        expect(result.reason).toBe('dataset-outside-profile-or-limit');
        expect(result.datasets).toBeNull();
    });

    it('leaves dataset identities unavailable when graph reading fails', async () => {
        const unavailable = graph('<urn:s> <urn:p> <urn:a> .');
        const spy = vi.spyOn(unavailable.dataset, 'getQuads').mockImplementation(() => {
            throw new Error('Graph is unavailable');
        });
        try {
            const result = await compareCompetencyAnswers(graph(), unavailable, [question()]);
            expect(result.reason).toBe('dataset-unavailable');
            expect(result.datasets).toBeNull();
        } finally {
            spy.mockRestore();
        }
    });
});

describe('bounded query admission', () => {
    it('admits only identity-preserving filters and variable-only projections on the encoded route', () => {
        for (const text of [
            'SELECT ?x WHERE { ?s <urn:p> ?x FILTER(?x = 1) }',
            'SELECT ?x WHERE { ?s <urn:p> ?x FILTER(?x) }',
            'SELECT ?x WHERE { ?s <urn:p> ?x FILTER(STR(?x) = "01") }',
            'SELECT ?x WHERE { ?s <urn:p> ?x FILTER(sameTerm(STR(?x), "01")) }',
            'SELECT ?x WHERE { ?s <urn:p> ?x FILTER(sameTerm(?x, 1) && ?x > 0) }',
            'SELECT ?x WHERE { ?s <urn:p> ?x BIND(STR(?x) AS ?label) }',
            'SELECT (?x AS ?copy) WHERE { ?s <urn:p> ?x }',
            'SELECT ?x WHERE { ?s <urn:p> ?x } ORDER BY ?x',
            'SELECT ?x WHERE { { SELECT ?x WHERE { ?s <urn:p> ?x } } }',
            'SELECT ?x WHERE { SERVICE <urn:remote> { ?s <urn:p> ?x } }',
            'SELECT ?x WHERE { GRAPH ?g { ?s <urn:p> ?x } }',
            'SELECT ?x FROM <urn:graph> WHERE { ?s <urn:p> ?x }',
        ]) {
            expect(admitTermIdentityQuery(text), text).toBeNull();
        }
        expect(admitTermIdentityQuery('SELECT ?x WHERE { ?s <urn:p> ?x FILTER(sameTerm(?x, 01)) }')?.form).toBe(
            'select',
        );
        expect(admitTermIdentityQuery('ASK { ?s <urn:p> ?x FILTER(!BOUND(?y) || sameTerm(?x, "01")) }')?.form).toBe(
            'ask',
        );
        expect(
            admitTermIdentityQuery('PREFIX FILTER: <urn:> SELECT ?BOUND WHERE { ?BOUND FILTER:STR "BIND NOW SERVICE" }')
                ?.form,
        ).toBe('select');
    });

    it('rechecks the query byte bound after literal expansion', () => {
        const text = `SELECT ?s WHERE { ?s <urn:p> "${'\\\\'.repeat(2100)}" }`;
        expect(Buffer.byteLength(text)).toBeLessThan(8192);
        expect(admitTermIdentityQuery(text)).toBeNull();
    });

    it('rejects partial, external, nondeterministic and unsupported forms', () => {
        for (const text of [
            `${SELECT} LIMIT 1`,
            `${SELECT} OFFSET 1`,
            'SELECT ?x FROM <urn:g> WHERE { ?x ?p ?o }',
            'SELECT ?x WHERE { SERVICE <https://example.invalid/> { ?x ?p ?o } }',
            'SELECT (RAND() AS ?x) WHERE {}',
            'SELECT (NOW() AS ?x) WHERE {}',
            'SELECT (UUID() AS ?x) WHERE {}',
            'SELECT (BNODE() AS ?x) WHERE {}',
            'SELECT (<urn:extension>() AS ?x) WHERE {}',
            'PREFIX x: <urn:> SELECT (x:extension() AS ?x) WHERE {}',
            'SELECT (COUNT(*) AS ?x) WHERE {}',
            'SELECT ?x WHERE { { SELECT ?x WHERE {} } }',
            'CONSTRUCT { ?x ?p ?o } WHERE { ?x ?p ?o }',
            'DESCRIBE <urn:x>',
            'SELECT ?x WHERE { GRAPH ?g { ?x ?p ?o } }',
            'SELECT (R\\u0041ND() AS ?x) WHERE {}',
            'SELECT ("01"^^<http://www.w3.org/2001/XMLSchema#integer> AS ?value) WHERE {}',
            'SELECT (STRDT("01", <http://www.w3.org/2001/XMLSchema#integer>) AS ?value) WHERE {}',
            'SELECT ("value"^^<urn:datatype:opaque> AS ?value) WHERE {}',
            'SELECT (IF(EXISTS { <urn:s> <urn:p> ?o }, 01, 1) AS ?value) WHERE {}',
            'SELECT (1.00 AS ?value) WHERE {}',
            'SELECT (1e0 AS ?value) WHERE {}',
            'SELECT (+1 AS ?value) WHERE {}',
            'SELECT (-0 AS ?value) WHERE {}',
        ]) {
            expect(admitTransitionQuery(text), text).toBeNull();
        }
    });

    it('keeps keyword-like IRIs, literals, names, variables and comments as data', () => {
        const query =
            'PREFIX LIMIT: <urn:> SELECT ?SERVICE WHERE { ?SERVICE LIMIT:NOW "LIMIT 1; SERVICE; RAND()" . FILTER(?SERVICE != <urn:OFFSET>) } # UUID()';
        expect(admitTransitionQuery(query)?.form).toBe('select');
        expect(admitTransitionQuery('SELECT (STRLEN("NOW()") AS ?value) WHERE {}')?.form).toBe('select');
        expect(admitTransitionQuery('SELECT ?x WHERE { ?x <urn:p> "escaped \\" quote" }')?.form).toBe('select');
    });

    it('admits canonical integer expressions and engine-generated numeric results', () => {
        expect(
            admitTransitionQuery('SELECT ?value WHERE { <urn:s> <urn:p> ?value . FILTER(STRLEN(?value) > 0) }')?.form,
        ).toBe('select');
        expect(admitTransitionQuery('SELECT (IF(true, -1, 1) AS ?value) WHERE {}')?.form).toBe('select');
        expect(admitTransitionQuery('SELECT (STRLEN("01") AS ?value) WHERE {}')?.form).toBe('select');
    });
});
