/** Consumer-selected relations between complete, set-valued query answers. */
export type QuestionTransitionPolicy = 'preserve' | 'no-loss' | 'no-gain';
export type QuestionTransitionStatus = 'satisfied' | 'violated' | 'indeterminate';

export type QuestionAnswerTerm =
    | Readonly<{ kind: 'iri'; value: string }>
    | Readonly<{ kind: 'literal'; value: string; datatype: string; language: string }>;

export type QuestionAnswerBinding = Readonly<Record<string, QuestionAnswerTerm>>;

/** ASK is represented by one empty binding for true, and no bindings for false. */
export interface QuestionAnswerSet {
    readonly form: 'select' | 'ask';
    readonly variables: ReadonlyArray<string>;
    readonly bindings: ReadonlyArray<QuestionAnswerBinding>;
    readonly sha256: string;
}

export interface QuestionTransitionResult {
    readonly id: string;
    readonly contentDigest: string;
    readonly renderedQuerySha256: string | null;
    /** The actual worker query and graph bytes; distinct from original input identities. */
    readonly execution: QuestionTransitionExecution | null;
    readonly status: QuestionTransitionStatus;
    readonly reason: string | null;
    readonly before: QuestionAnswerSet | null;
    readonly after: QuestionAnswerSet | null;
    readonly added: ReadonlyArray<QuestionAnswerBinding>;
    readonly removed: ReadonlyArray<QuestionAnswerBinding>;
}

/**
 * Identity of one exact serialized default-graph byte stream.
 * May be retained when query/input admission refuses before worker execution.
 */
export interface QuestionTransitionDatasetIdentity {
    readonly sha256: string;
    readonly quadCount: number;
    readonly byteSize: number;
}

export type QuestionTransitionEncoding = 'identity' | 'opaque-literal/v1';

export interface QuestionTransitionExecution {
    readonly encoding: QuestionTransitionEncoding;
    /** Includes the internal lookahead LIMIT used to refuse truncated SELECT answers. */
    readonly querySha256: string;
    readonly datasets: Readonly<{
        before: QuestionTransitionDatasetIdentity;
        after: QuestionTransitionDatasetIdentity;
    }>;
}

export interface QuestionTransitionReport {
    readonly schema: 'erden.question-transition/v1';
    readonly semantics: 'rdf-term-binding-set/v1';
    readonly policy: QuestionTransitionPolicy;
    readonly status: QuestionTransitionStatus;
    readonly reason: string | null;
    /** Original exported graph bytes. Null if either bounded input cannot be serialized. */
    readonly datasets: Readonly<{
        before: QuestionTransitionDatasetIdentity;
        after: QuestionTransitionDatasetIdentity;
    }> | null;
    readonly questions: ReadonlyArray<QuestionTransitionResult>;
}

export interface QuestionTransitionOptions {
    readonly policy?: QuestionTransitionPolicy;
    /** Maximum raw SELECT solution rows, before duplicate elimination; at most 1,000. */
    readonly maxAnswerRows?: number;
    /** Maximum serialized engine answer bytes; at most 4 MiB. */
    readonly maxAnswerBytes?: number;
    readonly signal?: AbortSignal;
}

export const QUESTION_TRANSITION_LIMITS = Object.freeze({
    maxQuestions: 64,
    maxQueryBytes: 8_192,
    maxDatasetQuads: 200_000,
    maxDatasetBytes: 16 * 1_048_576,
});
