import { createHash } from 'node:crypto';

import { DataFactory, Writer, type Quad, type Term } from 'n3';

import type { AssembledOntology, LoadedCompetencyQuestion } from '../model.js';
import { compareCodePoints } from '../order.js';
import { renderQuestion } from '../questions.js';
import { makeNodeReleaseQueryEngine, RELEASE_QUERY_ENGINE_LIMITS } from '../release-query/index.js';
import type { NodeReleaseQueryEngine } from '../release-query/index.js';

import { QUESTION_TRANSITION_LIMITS } from './model.js';
import type {
    QuestionAnswerBinding,
    QuestionAnswerSet,
    QuestionAnswerTerm,
    QuestionTransitionEncoding,
    QuestionTransitionExecution,
    QuestionTransitionOptions,
    QuestionTransitionPolicy,
    QuestionTransitionReport,
    QuestionTransitionResult,
} from './model.js';
import { admitTransitionQuery } from './policy.js';
import { admitTermIdentityQuery, decodeIdentityLiteral, encodeIdentityLiteral } from './term-encoding.js';

export * from './model.js';

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const XSD_NAMESPACE = 'http://www.w3.org/2001/XMLSchema#';
const LANG_STRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';

function sha(value: string | Uint8Array): string {
    return createHash('sha256').update(value).digest('hex');
}

function isCancelled(signal: AbortSignal | undefined): boolean {
    return signal?.aborted ?? false;
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Readonly<Record<string, unknown>>)
        : null;
}

function termForEngine<T extends Term>(term: T): T {
    return (term.termType === 'BlankNode' ? DataFactory.blankNode(`b${sha(term.value)}`) : term) as T;
}

/**
 * Encode a bounded default graph. Identity encoding exports the original RDF terms;
 * opaque-literal/v1 exports the actual graph for the restricted exact-term worker.
 * Source-prefixed blank-node labels are mapped to legal deterministic labels;
 * this preserves the graph without exposing those labels as comparable answers.
 * The bytes identify this serialization, not an RDF graph-isomorphism class.
 * Unsupported terms, named graphs and exceeded graph limits return null.
 */
export function encodeQuestionTransitionGraph(
    graph: AssembledOntology,
    encoding: QuestionTransitionEncoding = 'identity',
): Buffer | null {
    if (
        !['identity', 'opaque-literal/v1'].includes(encoding) ||
        graph.dataset.size > QUESTION_TRANSITION_LIMITS.maxDatasetQuads
    ) {
        return null;
    }
    const quads: Quad[] = [];
    for (const quad of graph.dataset.getQuads(null, null, null, null)) {
        if (
            quad.graph.termType !== 'DefaultGraph' ||
            !['NamedNode', 'BlankNode'].includes(quad.subject.termType) ||
            quad.predicate.termType !== 'NamedNode' ||
            !['NamedNode', 'BlankNode', 'Literal'].includes(quad.object.termType)
        ) {
            return null;
        }
        if (quad.object.termType === 'Literal') {
            const direction = (quad.object as { readonly direction?: unknown }).direction;
            if (direction !== undefined && direction !== '') {
                return null;
            }
        }
        const object =
            encoding === 'opaque-literal/v1' && quad.object.termType === 'Literal'
                ? encodeIdentityLiteral(quad.object)
                : termForEngine(quad.object);
        quads.push(DataFactory.quad(termForEngine(quad.subject), quad.predicate, object));
    }
    const bytes = Buffer.from(new Writer({ format: 'N-Quads' }).quadsToString(quads));
    return bytes.byteLength <= QUESTION_TRANSITION_LIMITS.maxDatasetBytes ? bytes : null;
}

/**
 * Oxigraph normalizes several XSD lexical forms and datatype IRIs at load time.
 * Require the exact-term route for all non-string XSD graph literals, including
 * canonical ones, rather than guessing which values the engine will change.
 */
function hasNormalizingLiteralInput(graph: AssembledOntology): boolean {
    return graph.dataset.getQuads(null, null, null, null).some((quad) => {
        const term = quad.object;
        return (
            term.termType === 'Literal' &&
            term.datatype.value.startsWith(XSD_NAMESPACE) &&
            term.datatype.value !== XSD_STRING
        );
    });
}

function answerTerm(value: unknown): QuestionAnswerTerm | null {
    const term = record(value);
    if (term === null || typeof term.value !== 'string') {
        return null;
    }
    if (term.type === 'uri' && Object.keys(term).every((key) => key === 'type' || key === 'value')) {
        return Object.freeze({ kind: 'iri', value: term.value });
    }
    if (
        term.type !== 'literal' ||
        !Object.keys(term).every((key) => ['type', 'value', 'datatype', 'xml:lang'].includes(key))
    ) {
        return null;
    }
    const language = term['xml:lang'];
    if (language !== undefined && (typeof language !== 'string' || language.length === 0)) {
        return null;
    }
    if (term.datatype !== undefined && typeof term.datatype !== 'string') {
        return null;
    }
    const normalizedLanguage = typeof language === 'string' ? language.toLowerCase() : '';
    const datatype =
        typeof term.datatype === 'string' ? term.datatype : normalizedLanguage.length > 0 ? LANG_STRING : XSD_STRING;
    if (normalizedLanguage.length > 0 && datatype !== LANG_STRING) {
        return null;
    }
    return Object.freeze({ kind: 'literal', value: term.value, datatype, language: normalizedLanguage });
}

function decodeAnswer(
    text: string,
    form: 'select' | 'ask',
    encoding: QuestionTransitionEncoding,
): QuestionAnswerSet | null {
    const value = record(JSON.parse(text));
    if (value === null) {
        return null;
    }
    let variables: string[];
    let bindings: QuestionAnswerBinding[];
    if (form === 'ask') {
        if (typeof value.boolean !== 'boolean') {
            return null;
        }
        variables = [];
        bindings = value.boolean ? [Object.freeze({})] : [];
    } else {
        const head = record(value.head);
        const results = record(value.results);
        if (
            head === null ||
            !Array.isArray(head.vars) ||
            !head.vars.every((item) => typeof item === 'string') ||
            results === null ||
            !Array.isArray(results.bindings)
        ) {
            return null;
        }
        variables = [...head.vars].sort(compareCodePoints);
        if (new Set(variables).size !== variables.length) {
            return null;
        }
        const unique = new Map<string, QuestionAnswerBinding>();
        for (const raw of results.bindings as unknown[]) {
            const row = record(raw);
            if (row === null || Object.keys(row).some((key) => !variables.includes(key))) {
                return null;
            }
            const entries: [string, QuestionAnswerTerm][] = [];
            for (const name of Object.keys(row).sort(compareCodePoints)) {
                const rawTerm = answerTerm(row[name]);
                const term =
                    rawTerm !== null && encoding === 'opaque-literal/v1' ? decodeIdentityLiteral(rawTerm) : rawTerm;
                if (term === null) {
                    return null;
                }
                entries.push([name, term]);
            }
            const binding = Object.freeze(Object.fromEntries(entries));
            unique.set(JSON.stringify(binding), binding);
        }
        bindings = [...unique].sort(([left], [right]) => compareCodePoints(left, right)).map(([, row]) => row);
    }
    const body = { form, variables: Object.freeze(variables), bindings: Object.freeze(bindings) };
    return Object.freeze({ ...body, sha256: sha(JSON.stringify(body)) });
}

function unknown(
    question: LoadedCompetencyQuestion,
    reason: string,
    renderedQuerySha256: string | null = null,
    execution: QuestionTransitionExecution | null = null,
): QuestionTransitionResult {
    return Object.freeze({
        id: question.id,
        contentDigest: question.contentDigest,
        renderedQuerySha256,
        execution,
        status: 'indeterminate',
        reason,
        before: null,
        after: null,
        added: Object.freeze([]),
        removed: Object.freeze([]),
    });
}

function report(
    policy: QuestionTransitionPolicy,
    questions: ReadonlyArray<QuestionTransitionResult>,
    reason: string | null = null,
    datasets: QuestionTransitionReport['datasets'] = null,
): QuestionTransitionReport {
    const status =
        reason !== null || questions.length === 0
            ? 'indeterminate'
            : questions.some((question) => question.status === 'violated')
              ? 'violated'
              : questions.some((question) => question.status === 'indeterminate')
                ? 'indeterminate'
                : 'satisfied';
    return Object.freeze({
        schema: 'erden.question-transition/v1',
        semantics: 'rdf-term-binding-set/v1',
        policy,
        status,
        reason,
        datasets,
        questions: Object.freeze([...questions]),
    });
}

/**
 * Compare one fixed consumer-owned suite on two already checked materialized
 * graphs. This tests answer relations on those graphs, not all OWL models.
 * The worker bounds evaluation; any incomplete/unsupported outcome is unknown.
 */
export async function compareCompetencyAnswers(
    before: AssembledOntology,
    after: AssembledOntology,
    questions: ReadonlyArray<LoadedCompetencyQuestion>,
    options: QuestionTransitionOptions = {},
): Promise<QuestionTransitionReport> {
    const policy = options.policy ?? 'preserve';
    const maxRows = options.maxAnswerRows ?? RELEASE_QUERY_ENGINE_LIMITS.maxResultRows;
    const maxBytes = options.maxAnswerBytes ?? RELEASE_QUERY_ENGINE_LIMITS.maxResultBytes;
    if (
        !['preserve', 'no-loss', 'no-gain'].includes(policy) ||
        !Number.isSafeInteger(maxRows) ||
        maxRows < 1 ||
        maxRows > RELEASE_QUERY_ENGINE_LIMITS.maxResultRows ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 1 ||
        maxBytes > RELEASE_QUERY_ENGINE_LIMITS.maxResultBytes
    ) {
        throw new TypeError('Invalid competency-question transition options');
    }
    if (questions.length === 0) {
        return report(policy, [], 'empty-suite');
    }
    if (questions.length > QUESTION_TRANSITION_LIMITS.maxQuestions) {
        return report(policy, [], 'suite-limit');
    }
    if (new Set(questions.map((question) => question.id)).size !== questions.length) {
        return report(policy, [], 'duplicate-question-id');
    }
    let oldBytes: Buffer | null;
    let newBytes: Buffer | null;
    try {
        oldBytes = encodeQuestionTransitionGraph(before);
        newBytes = encodeQuestionTransitionGraph(after);
    } catch {
        return report(policy, [], 'dataset-unavailable');
    }
    if (oldBytes === null || newBytes === null) {
        return report(policy, [], 'dataset-outside-profile-or-limit');
    }
    const datasets = Object.freeze({
        before: Object.freeze({ sha256: sha(oldBytes), quadCount: before.dataset.size, byteSize: oldBytes.byteLength }),
        after: Object.freeze({ sha256: sha(newBytes), quadCount: after.dataset.size, byteSize: newBytes.byteLength }),
    });
    const requiresTermIdentity = hasNormalizingLiteralInput(before) || hasNormalizingLiteralInput(after);
    const prepared = [...questions]
        .sort((left, right) => compareCodePoints(left.id, right.id))
        .map((question) => {
            try {
                const text = new TextDecoder('utf-8', { fatal: true }).decode(question.bytes);
                if (text !== question.text || `sha256:${sha(question.bytes)}` !== question.contentDigest) {
                    return { question, problem: 'query-content-mismatch', query: null, digest: null };
                }
                if (question.owner.role !== 'root') {
                    return { question, problem: 'question-not-consumer-owned', query: null, digest: null };
                }
                const rendered = renderQuestion(question);
                const digest = sha(rendered.text);
                if (rendered.missing.length > 0) {
                    return { question, problem: 'query-placeholder-missing', query: null, digest };
                }
                const direct = requiresTermIdentity ? null : admitTransitionQuery(rendered.text);
                const encoded = direct === null ? admitTermIdentityQuery(rendered.text) : null;
                const admitted = direct ?? encoded;
                const query: Readonly<{
                    form: 'select' | 'ask';
                    canonical: string;
                    encoding: QuestionTransitionEncoding;
                }> | null =
                    admitted === null
                        ? null
                        : {
                              ...admitted,
                              encoding: direct === null ? 'opaque-literal/v1' : 'identity',
                          };
                return {
                    question,
                    problem:
                        query === null
                            ? requiresTermIdentity
                                ? 'query-outside-term-identity-profile'
                                : 'query-outside-profile'
                            : null,
                    query,
                    digest,
                };
            } catch {
                return { question, problem: 'query-content-invalid', query: null, digest: null };
            }
        });
    const output: QuestionTransitionResult[] = [];
    let engine: NodeReleaseQueryEngine | undefined;
    let engineReady = false;
    let encodedBytes: readonly [Buffer | null, Buffer | null] | undefined;
    try {
        for (const item of prepared) {
            if (item.problem !== null || item.query === null) {
                output.push(unknown(item.question, item.problem ?? 'query-outside-profile', item.digest));
                continue;
            }
            if (isCancelled(options.signal)) {
                output.push(unknown(item.question, 'cancelled', item.digest));
                continue;
            }
            if (item.query.encoding === 'opaque-literal/v1' && encodedBytes === undefined) {
                try {
                    encodedBytes = [
                        encodeQuestionTransitionGraph(before, 'opaque-literal/v1'),
                        encodeQuestionTransitionGraph(after, 'opaque-literal/v1'),
                    ];
                } catch {
                    encodedBytes = [null, null];
                }
            }
            const workerBytes = item.query.encoding === 'identity' ? [oldBytes, newBytes] : encodedBytes;
            const oldWorkerBytes = workerBytes?.[0];
            const newWorkerBytes = workerBytes?.[1];
            if (oldWorkerBytes == null || newWorkerBytes == null) {
                output.push(unknown(item.question, 'encoded-dataset-outside-limit', item.digest));
                continue;
            }
            const engineQuery =
                item.query.canonical + (item.query.form === 'select' ? ` LIMIT ${String(maxRows + 1)}` : '');
            const execution: QuestionTransitionExecution = Object.freeze({
                encoding: item.query.encoding,
                querySha256: sha(engineQuery),
                datasets: Object.freeze({
                    before: Object.freeze({
                        sha256: sha(oldWorkerBytes),
                        quadCount: before.dataset.size,
                        byteSize: oldWorkerBytes.byteLength,
                    }),
                    after: Object.freeze({
                        sha256: sha(newWorkerBytes),
                        quadCount: after.dataset.size,
                        byteSize: newWorkerBytes.byteLength,
                    }),
                }),
            });
            if (engine === undefined) {
                engine = makeNodeReleaseQueryEngine();
                engineReady = await engine.start();
            }
            if (!engineReady) {
                output.push(unknown(item.question, 'engine-unavailable', item.digest, execution));
                continue;
            }
            const answers: QuestionAnswerSet[] = [];
            let problem: string | null = null;
            for (const bytes of [oldWorkerBytes, newWorkerBytes]) {
                try {
                    const answer = await engine.execute(
                        {
                            declared: [{ nquads: bytes, multiplicity: 1 }],
                            inferred: [],
                            datasetSha256: sha(bytes),
                            form: item.query.form,
                            engineQuery,
                        },
                        options.signal ?? new AbortController().signal,
                    );
                    if (answer.outcome !== 'complete') {
                        problem = answer.outcome;
                        break;
                    }
                    if (Buffer.byteLength(answer.result) > maxBytes) {
                        problem = 'result-byte-limit';
                        break;
                    }
                    const raw = JSON.parse(answer.result) as { results?: { bindings?: unknown[] } };
                    if (item.query.form === 'select' && (raw.results?.bindings?.length ?? 0) > maxRows) {
                        problem = 'row-limit';
                        break;
                    }
                    const decoded = decodeAnswer(answer.result, item.query.form, item.query.encoding);
                    if (decoded === null) {
                        problem = 'unsupported-result-term-or-shape';
                        break;
                    }
                    answers.push(decoded);
                } catch {
                    problem = isCancelled(options.signal) ? 'cancelled' : 'engine-unavailable';
                    break;
                }
            }
            const oldAnswer = answers[0];
            const newAnswer = answers[1];
            if (
                problem !== null ||
                oldAnswer === undefined ||
                newAnswer === undefined ||
                JSON.stringify(oldAnswer.variables) !== JSON.stringify(newAnswer.variables)
            ) {
                output.push(unknown(item.question, problem ?? 'answer-shape-mismatch', item.digest, execution));
                continue;
            }
            const oldKeys = new Set(oldAnswer.bindings.map((row) => JSON.stringify(row)));
            const newKeys = new Set(newAnswer.bindings.map((row) => JSON.stringify(row)));
            const added = newAnswer.bindings.filter((row) => !oldKeys.has(JSON.stringify(row)));
            const removed = oldAnswer.bindings.filter((row) => !newKeys.has(JSON.stringify(row)));
            const satisfied =
                policy === 'no-loss'
                    ? removed.length === 0
                    : policy === 'no-gain'
                      ? added.length === 0
                      : added.length === 0 && removed.length === 0;
            output.push(
                Object.freeze({
                    id: item.question.id,
                    contentDigest: item.question.contentDigest,
                    renderedQuerySha256: item.digest,
                    execution,
                    status: satisfied ? 'satisfied' : 'violated',
                    reason: null,
                    before: oldAnswer,
                    after: newAnswer,
                    added: Object.freeze(added),
                    removed: Object.freeze(removed),
                }),
            );
        }
    } finally {
        await engine?.close();
    }
    return report(policy, output, null, datasets);
}
