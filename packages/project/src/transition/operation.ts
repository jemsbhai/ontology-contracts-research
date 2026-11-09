import { createHash } from 'node:crypto';

import { Effect } from 'effect';

import {
    CheckProjectOperationalError,
    encodeCheckProjectReport,
    serializeLockfile,
    type CheckProjectError,
    type CheckProjectReport,
    type LockfileV1,
} from '@erden/contracts';
import {
    compareCompetencyAnswers,
    renderQuestion,
    ONTOLOGY_VALIDATION_POLICY_ID,
    ONTOLOGY_VALIDATION_POLICY_SHA256,
    QUESTION_TRANSITION_LIMITS,
    RELEASE_QUERY_ENGINE,
    RELEASE_QUERY_ENGINE_LIMITS,
    type QuestionTransitionReport,
} from '@erden/ontology';

import {
    nodeCheckProjectService,
    type CheckedProjectSemanticSnapshot,
    type CheckProjectOptions,
    type CheckProjectServiceShape,
} from '../check/index.js';

export type ProjectTransitionPolicy = 'preserve' | 'no-loss' | 'no-gain';

export interface ProjectTransitionOptions {
    readonly before: CheckProjectOptions;
    readonly after: CheckProjectOptions;
    readonly policy?: ProjectTransitionPolicy;
}

export interface ProjectTransitionBasis {
    readonly canonicalIri: string;
    readonly manifestSha256: string;
    readonly lockSha256: string;
    readonly checkReportSha256: string;
    readonly sources: CheckProjectReport['sources']['files'];
    readonly dependencies: LockfileV1['packages'];
    readonly directDependencies: LockfileV1['directDependencies'];
    readonly registryOrigin: LockfileV1['registryOrigin'];
    readonly toolchain: LockfileV1['toolchain'];
    readonly reasoningProfile: CheckProjectReport['reasoning']['profile'];
    readonly reasoningTool: CheckProjectReport['reasoning']['tool'];
    readonly reasoningInputDigest: string;
    readonly validationPolicy: Readonly<{ id: string; sha256: string }>;
}

export interface ProjectTransitionDependencyChange {
    readonly canonicalIri: string;
    readonly beforeVersion: string | null;
    readonly afterVersion: string | null;
    readonly beforeArchiveSha256: string | null;
    readonly afterArchiveSha256: string | null;
}

export interface ProjectTransitionReport {
    readonly schema: 'erden.project-transition/v1';
    readonly scope: 'fixed-baseline-root-questions-on-checked-materialized-graphs';
    readonly compatibility: 'consumer-query-contract-only';
    readonly policy: ProjectTransitionPolicy;
    readonly status: 'satisfied' | 'violated' | 'indeterminate';
    readonly reason: string | null;
    readonly comparisonExecution: Readonly<{
        engine: typeof RELEASE_QUERY_ENGINE;
        limits: typeof QUESTION_TRANSITION_LIMITS;
        workerLimits: typeof RELEASE_QUERY_ENGINE_LIMITS;
        boundsScope: 'answer-comparison-stage-only';
    }>;
    readonly before: Readonly<{ check: CheckProjectReport; basis: ProjectTransitionBasis | null }>;
    readonly after: Readonly<{ check: CheckProjectReport; basis: ProjectTransitionBasis | null }>;
    readonly rootSourcesChanged: boolean | null;
    readonly candidateQuestionSuiteChanged: boolean | null;
    readonly baselineQuestionSuite: ReadonlyArray<
        Readonly<{
            id: string;
            contentDigest: string;
            text: string;
            placeholders: Readonly<Record<string, string>>;
            renderedQuery: string;
            renderedQuerySha256: string;
        }>
    > | null;
    readonly dependencyChanges: ReadonlyArray<ProjectTransitionDependencyChange>;
    readonly answers: QuestionTransitionReport | null;
}

function sha256(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

function basis(snapshot: CheckedProjectSemanticSnapshot): ProjectTransitionBasis {
    return Object.freeze({
        canonicalIri: snapshot.report.manifest.canonicalIri,
        manifestSha256: snapshot.manifestSha256,
        lockSha256: sha256(serializeLockfile(snapshot.lock)),
        checkReportSha256: sha256(encodeCheckProjectReport(snapshot.report)),
        sources: snapshot.report.sources.files,
        dependencies: snapshot.lock.packages,
        directDependencies: snapshot.lock.directDependencies,
        registryOrigin: snapshot.lock.registryOrigin,
        toolchain: snapshot.lock.toolchain,
        reasoningProfile: snapshot.report.reasoning.profile,
        reasoningTool: snapshot.report.reasoning.tool,
        reasoningInputDigest: snapshot.report.reasoning.inputDigest,
        validationPolicy: Object.freeze({
            id: ONTOLOGY_VALIDATION_POLICY_ID,
            sha256: ONTOLOGY_VALIDATION_POLICY_SHA256,
        }),
    });
}

function dependencyChanges(
    before: CheckedProjectSemanticSnapshot,
    after: CheckedProjectSemanticSnapshot,
): ReadonlyArray<ProjectTransitionDependencyChange> {
    const oldPackages = new Map(before.lock.packages.map((entry) => [entry.canonicalIri, entry]));
    const newPackages = new Map(after.lock.packages.map((entry) => [entry.canonicalIri, entry]));
    return [...new Set([...oldPackages.keys(), ...newPackages.keys()])].sort().flatMap((canonicalIri) => {
        const oldEntry = oldPackages.get(canonicalIri);
        const newEntry = newPackages.get(canonicalIri);
        return oldEntry?.version === newEntry?.version && oldEntry?.archiveSha256 === newEntry?.archiveSha256
            ? []
            : [
                  Object.freeze({
                      canonicalIri,
                      beforeVersion: oldEntry?.version ?? null,
                      afterVersion: newEntry?.version ?? null,
                      beforeArchiveSha256: oldEntry?.archiveSha256 ?? null,
                      afterArchiveSha256: newEntry?.archiveSha256 ?? null,
                  }),
              ];
    });
}

function suiteIdentity(snapshot: CheckedProjectSemanticSnapshot): string {
    return JSON.stringify(
        snapshot.rootQuestions
            .map((question) => ({
                id: question.id,
                contentDigest: question.contentDigest,
                placeholders: Object.entries(question.placeholders).sort(([left], [right]) =>
                    left < right ? -1 : left > right ? 1 : 0,
                ),
            }))
            .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
    );
}

/** Compare one consumer's fixed baseline questions across two actual Erden check runs. */
export function compareProjectTransition(
    options: ProjectTransitionOptions,
    service: CheckProjectServiceShape = nodeCheckProjectService,
): Effect.Effect<ProjectTransitionReport, CheckProjectError> {
    return Effect.gen(function* () {
        const policy = options.policy ?? 'preserve';
        if (!['preserve', 'no-loss', 'no-gain'].includes(policy)) {
            return yield* Effect.fail(
                new CheckProjectOperationalError(
                    'CHECK_OPERATION_FAILED',
                    'validation',
                    'The transition policy is invalid',
                ),
            );
        }
        let before: CheckedProjectSemanticSnapshot | undefined;
        let after: CheckedProjectSemanticSnapshot | undefined;
        const beforeCheck = yield* service.check({
            ...options.before,
            captureSemanticSnapshot: (snapshot) =>
                Effect.sync(() => {
                    before = snapshot;
                }),
        });
        const afterCheck = yield* service.check({
            ...options.after,
            captureSemanticSnapshot: (snapshot) =>
                Effect.sync(() => {
                    after = snapshot;
                }),
        });
        const beforeBasis = before === undefined ? null : basis(before);
        const afterBasis = after === undefined ? null : basis(after);
        const rootSourcesChanged =
            beforeBasis === null || afterBasis === null
                ? null
                : JSON.stringify(beforeBasis.sources.filter((source) => source.id.startsWith('root:'))) !==
                  JSON.stringify(afterBasis.sources.filter((source) => source.id.startsWith('root:')));
        const candidateQuestionSuiteChanged =
            before === undefined || after === undefined ? null : suiteIdentity(before) !== suiteIdentity(after);
        let reason: string | null = null;
        if (
            beforeCheck.outcome !== 'passed' ||
            afterCheck.outcome !== 'passed' ||
            before === undefined ||
            after === undefined
        ) {
            reason = 'both-projects-must-pass';
        } else if (beforeCheck.manifest.canonicalIri !== afterCheck.manifest.canonicalIri) {
            reason = 'consumer-identity-mismatch';
        } else if (beforeCheck.unreasoned !== undefined || afterCheck.unreasoned !== undefined) {
            reason = 'unreasoned-input';
        } else if (before.rootQuestions.length === 0) {
            reason = 'empty-baseline-question-suite';
        } else if (
            JSON.stringify(before.lock.toolchain) !== JSON.stringify(after.lock.toolchain) ||
            JSON.stringify(beforeCheck.reasoning.profile) !== JSON.stringify(afterCheck.reasoning.profile) ||
            JSON.stringify(beforeCheck.reasoning.tool) !== JSON.stringify(afterCheck.reasoning.tool)
        ) {
            reason = 'reasoning-configuration-mismatch';
        }
        const baseline = before;
        const candidate = after;
        const answers =
            reason !== null || baseline === undefined || candidate === undefined
                ? null
                : yield* Effect.tryPromise({
                      try: () =>
                          compareCompetencyAnswers(baseline.graph, candidate.graph, baseline.rootQuestions, { policy }),
                      catch: () =>
                          new CheckProjectOperationalError(
                              'CHECK_OPERATION_FAILED',
                              'validation',
                              'The project transition could not complete',
                          ),
                  });
        return Object.freeze({
            schema: 'erden.project-transition/v1' as const,
            scope: 'fixed-baseline-root-questions-on-checked-materialized-graphs' as const,
            compatibility: 'consumer-query-contract-only' as const,
            policy,
            status: answers?.status ?? 'indeterminate',
            reason: reason ?? answers?.reason ?? null,
            comparisonExecution: Object.freeze({
                engine: RELEASE_QUERY_ENGINE,
                limits: QUESTION_TRANSITION_LIMITS,
                workerLimits: RELEASE_QUERY_ENGINE_LIMITS,
                boundsScope: 'answer-comparison-stage-only' as const,
            }),
            before: Object.freeze({ check: beforeCheck, basis: beforeBasis }),
            after: Object.freeze({ check: afterCheck, basis: afterBasis }),
            rootSourcesChanged,
            candidateQuestionSuiteChanged,
            baselineQuestionSuite:
                before === undefined
                    ? null
                    : before.rootQuestions.map((question) => {
                          const renderedQuery = renderQuestion(question).text;
                          return Object.freeze({
                              id: question.id,
                              contentDigest: question.contentDigest,
                              text: question.text,
                              placeholders: question.placeholders,
                              renderedQuery,
                              renderedQuerySha256: sha256(renderedQuery),
                          });
                      }),
            dependencyChanges: before === undefined || after === undefined ? [] : dependencyChanges(before, after),
            answers,
        });
    });
}

export function encodeProjectTransitionReport(report: ProjectTransitionReport): string {
    return `${JSON.stringify(report, null, 2)}\n`;
}

export function renderProjectTransitionReport(report: ProjectTransitionReport): string {
    const lines = [
        `Erden consumer query transition: ${report.status} (${report.policy})`,
        `Consumer: ${report.before.check.manifest.canonicalIri}`,
        'Scope: fixed baseline root questions on checked materialized graphs; not general ontology compatibility.',
        `Dependency release changes: ${String(report.dependencyChanges.length)}`,
        `Root source identity changed: ${String(report.rootSourcesChanged)}`,
        `Candidate question suite changed: ${String(report.candidateQuestionSuiteChanged)}`,
    ];
    if (report.reason !== null) {
        lines.push(`Reason: ${report.reason}`);
    }
    for (const question of report.answers?.questions ?? []) {
        lines.push(
            `${question.id}: ${question.status}; +${String(question.added.length)} / -${String(question.removed.length)}`,
        );
    }
    return `${lines.join('\n')}\n`;
}
