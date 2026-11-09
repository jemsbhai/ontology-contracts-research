import { DataFactory, Parser, Writer, type Literal } from 'n3';

import { QUESTION_TRANSITION_LIMITS } from './model.js';
import type { QuestionAnswerTerm } from './model.js';
import { tokenizeTransitionQuery, type TransitionQueryToken } from './policy.js';

/** All literals, including literals already using this datatype, are encoded once. */
export const TRANSITION_LITERAL_DATATYPE = 'urn:erden:question-transition:opaque-literal:v1';

/** Injective in the RDF 1.1 lexical form, datatype IRI and case-insensitive language tag. */
export function encodeIdentityLiteral(term: Literal): Literal {
    return DataFactory.literal(
        JSON.stringify([term.value, term.datatype.value, term.language.toLowerCase()]),
        DataFactory.namedNode(TRANSITION_LITERAL_DATATYPE),
    );
}

export function decodeIdentityLiteral(term: QuestionAnswerTerm): QuestionAnswerTerm | null {
    if (term.kind === 'iri') {
        return term;
    }
    if (term.datatype !== TRANSITION_LITERAL_DATATYPE || term.language !== '') {
        return null;
    }
    let tuple: unknown;
    try {
        tuple = JSON.parse(term.value);
    } catch {
        return null;
    }
    if (
        !Array.isArray(tuple) ||
        tuple.length !== 3 ||
        !tuple.every((part) => typeof part === 'string') ||
        JSON.stringify(tuple) !== term.value
    ) {
        return null;
    }
    const [value, datatype, language] = tuple as [string, string, string];
    if (
        language !== language.toLowerCase() ||
        (language.length > 0 && datatype !== 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString')
    ) {
        return null;
    }
    return Object.freeze({ kind: 'literal', value, datatype, language });
}

interface EncodedToken {
    readonly text: string;
    readonly next: number;
}

function variable(token: TransitionQueryToken | undefined): boolean {
    return token?.kind === 'other' && /^[?$][A-Za-z_][A-Za-z_0-9]*$/u.test(token.text);
}

const STRUCTURAL_WORDS = new Set(['WHERE', 'OPTIONAL', 'UNION', 'MINUS', 'VALUES', 'UNDEF']);
const GRAPH_OPERATORS = new Set(['{', '}', '(', ')', '[', ']', ';', ',', '.', '*', '+', '/', '?', '!', '|', '^']);

/**
 * Compile an identity-only fragment. This is admission plus lexical rewriting,
 * not a replacement grammar parser: the pinned SPARQL engine still checks the
 * complete grammar. SELECT projects only variables; no expression creates terms.
 * The only FILTER predicates are sameTerm and BOUND, composed with !, && and ||.
 * Every accepted operation commutes with an injective renaming of RDF literals.
 */
export function admitTermIdentityQuery(text: string): Readonly<{ form: 'select' | 'ask'; canonical: string }> | null {
    if (Buffer.byteLength(text) > QUESTION_TRANSITION_LIMITS.maxQueryBytes) {
        return null;
    }
    const tokens = tokenizeTransitionQuery(text);
    if (tokens === null) {
        return null;
    }
    let start = 0;
    const prefixes: string[] = [];
    while (tokens[start]?.kind === 'word' && tokens[start]?.text.toUpperCase() === 'PREFIX') {
        const name = tokens[start + 1];
        const iri = tokens[start + 2];
        if (name?.kind !== 'name' || !name.text.endsWith(':') || iri?.kind !== 'iri') {
            return null;
        }
        prefixes.push(`PREFIX ${name.text} ${iri.text}`);
        start += 3;
    }
    const form = tokens[start]?.kind === 'word' ? tokens[start]?.text.toLowerCase() : undefined;
    if (form !== 'select' && form !== 'ask') {
        return null;
    }
    const output = [...prefixes, form.toUpperCase()];
    let offset = start + 1;
    if (form === 'select') {
        const modifier = tokens[offset];
        if (modifier?.kind === 'word' && ['DISTINCT', 'REDUCED'].includes(modifier.text.toUpperCase())) {
            output.push(modifier.text);
            offset += 1;
        }
        if (tokens[offset]?.text === '*') {
            output.push('*');
            offset += 1;
        } else {
            const first = offset;
            while (variable(tokens[offset])) {
                output.push(tokens[offset]?.text ?? '');
                offset += 1;
            }
            if (offset === first) {
                return null;
            }
        }
    }
    if (tokens[offset]?.kind === 'word' && tokens[offset]?.text.toUpperCase() === 'WHERE') {
        output.push('WHERE');
        offset += 1;
    }
    if (tokens[offset]?.text !== '{') {
        return null;
    }

    function term(index: number): EncodedToken | null {
        const token = tokens?.[index];
        if (token === undefined) {
            return null;
        }
        if (variable(token) || token.kind === 'iri' || token.kind === 'name') {
            return { text: token.text, next: index + 1 };
        }
        const boolean = token.kind === 'word' && ['TRUE', 'FALSE'].includes(token.text.toUpperCase());
        if (token.kind !== 'literal' && token.kind !== 'number' && !boolean) {
            return null;
        }
        const literal = [boolean ? token.text.toLowerCase() : token.text];
        let next = index + 1;
        if (token.kind === 'literal' && tokens?.[next]?.text.startsWith('@')) {
            literal.push(tokens[next]?.text ?? '');
            next += 1;
        } else if (token.kind === 'literal' && tokens?.[next]?.text === '^^') {
            const datatype = tokens[next + 1];
            if (datatype?.kind !== 'iri' && datatype?.kind !== 'name') {
                return null;
            }
            literal.push('^^', datatype.text);
            next += 2;
        }
        try {
            const quads = new Parser().parse(
                `${prefixes.join('\n')}\n<urn:erden:q> <urn:erden:p> ${literal.join('')} .`,
            );
            const parsed = quads[0]?.object;
            if (quads.length !== 1 || parsed?.termType !== 'Literal') {
                return null;
            }
            const encoded = encodeIdentityLiteral(parsed);
            // Writer owns all escaping; do not interpolate a source lexical form into SPARQL.
            const serialized = new Writer({ format: 'N-Triples' }).quadsToString([
                DataFactory.quad(DataFactory.namedNode('urn:erden:q'), DataFactory.namedNode('urn:erden:p'), encoded),
            ]);
            const prefix = '<urn:erden:q> <urn:erden:p> ';
            const suffix = ' .\n';
            if (!serialized.startsWith(prefix) || !serialized.endsWith(suffix)) {
                return null;
            }
            return { text: serialized.slice(prefix.length, -suffix.length), next };
        } catch {
            return null;
        }
    }

    // Recursive descent accepts only identity-preserving predicates, not SPARQL
    // value equality, numeric arithmetic, type inspection or effective booleans.
    function primary(index: number): EncodedToken | null {
        const token = tokens?.[index];
        if (token?.text === '!') {
            const right = primary(index + 1);
            return right === null ? null : { text: `! ${right.text}`, next: right.next };
        }
        if (token?.text === '(') {
            const inner = disjunction(index + 1);
            return inner === null || tokens?.[inner.next]?.text !== ')'
                ? null
                : { text: `( ${inner.text} )`, next: inner.next + 1 };
        }
        if (token?.kind !== 'word' || tokens?.[index + 1]?.text !== '(') {
            return null;
        }
        if (token.text.toUpperCase() === 'BOUND') {
            const arg = tokens[index + 2];
            return !variable(arg) || tokens[index + 3]?.text !== ')'
                ? null
                : { text: `BOUND ( ${arg?.text ?? ''} )`, next: index + 4 };
        }
        if (token.text.toUpperCase() !== 'SAMETERM') {
            return null;
        }
        const left = term(index + 2);
        if (left === null || tokens[left.next]?.text !== ',') {
            return null;
        }
        const right = term(left.next + 1);
        return right === null || tokens[right.next]?.text !== ')'
            ? null
            : { text: `sameTerm ( ${left.text} , ${right.text} )`, next: right.next + 1 };
    }

    function conjunction(index: number): EncodedToken | null {
        let left = primary(index);
        while (left !== null && tokens?.[left.next]?.text === '&&') {
            const right = primary(left.next + 1);
            if (right === null) {
                return null;
            }
            left = { text: `${left.text} && ${right.text}`, next: right.next };
        }
        return left;
    }

    function disjunction(index: number): EncodedToken | null {
        let left = conjunction(index);
        while (left !== null && tokens?.[left.next]?.text === '||') {
            const right = conjunction(left.next + 1);
            if (right === null) {
                return null;
            }
            left = { text: `${left.text} || ${right.text}`, next: right.next };
        }
        return left;
    }

    while (offset < tokens.length) {
        const token = tokens[offset];
        if (token === undefined) {
            return null;
        }
        if (token.kind === 'word' && token.text.toUpperCase() === 'FILTER') {
            const filter = primary(offset + 1);
            if (filter === null) {
                return null;
            }
            output.push(`FILTER ( ${filter.text} )`);
            offset = filter.next;
            continue;
        }
        const encoded = term(offset);
        if (encoded !== null) {
            output.push(encoded.text);
            offset = encoded.next;
            continue;
        }
        if (
            (token.kind === 'word' && (STRUCTURAL_WORDS.has(token.text.toUpperCase()) || token.text === 'a')) ||
            (token.kind === 'other' && GRAPH_OPERATORS.has(token.text))
        ) {
            output.push(token.text);
            offset += 1;
            continue;
        }
        return null;
    }
    const canonical = output.join(' ');
    return Buffer.byteLength(canonical) <= QUESTION_TRANSITION_LIMITS.maxQueryBytes
        ? Object.freeze({ form, canonical })
        : null;
}
