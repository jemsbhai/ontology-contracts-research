import { QUESTION_TRANSITION_LIMITS } from './model.js';

export interface TransitionQueryToken {
    readonly kind: 'word' | 'name' | 'iri' | 'literal' | 'number' | 'other';
    readonly text: string;
}

const FORBIDDEN = new Set([
    'BASE',
    'FROM',
    'SERVICE',
    'GRAPH',
    'LIMIT',
    'OFFSET',
    'GROUP',
    'HAVING',
    'CONSTRUCT',
    'DESCRIBE',
    'INSERT',
    'DELETE',
    'LOAD',
    'CLEAR',
    'CREATE',
    'DROP',
    'COPY',
    'MOVE',
    'ADD',
    'WITH',
    'USING',
]);
const FUNCTIONS = new Set([
    'FILTER',
    'BIND',
    'IN',
    'NOT',
    'IF',
    'COALESCE',
    'STR',
    'LANG',
    'LANGMATCHES',
    'DATATYPE',
    'BOUND',
    'IRI',
    'URI',
    'STRLANG',
    'STRBEFORE',
    'STRAFTER',
    'STRSTARTS',
    'STRENDS',
    'STRLEN',
    'CONCAT',
    'SUBSTR',
    'UCASE',
    'LCASE',
    'ENCODE_FOR_URI',
    'CONTAINS',
    'REPLACE',
    'REGEX',
    'ABS',
    'CEIL',
    'FLOOR',
    'ROUND',
    'YEAR',
    'MONTH',
    'DAY',
    'HOURS',
    'MINUTES',
    'SECONDS',
    'TIMEZONE',
    'TZ',
    'MD5',
    'SHA1',
    'SHA256',
    'SHA384',
    'SHA512',
    'ISIRI',
    'ISURI',
    'ISBLANK',
    'ISLITERAL',
    'ISNUMERIC',
    'SAMETERM',
    'ASC',
    'DESC',
]);

/**
 * Admission, not a replacement SPARQL parser. Preserve lexical tokens, discard
 * comments, and restrict the evaluated language; Oxigraph checks the grammar.
 * In particular, keywords in strings, IRIs, variable names and prefixed names
 * are not mistaken for executable syntax. Unsupported lexical escapes outside
 * literals/IRIs are refused, so they cannot change the inspected token stream.
 */
export function tokenizeTransitionQuery(text: string): ReadonlyArray<TransitionQueryToken> | null {
    const tokens: TransitionQueryToken[] = [];
    let offset = 0;
    while (offset < text.length) {
        const tail = text.slice(offset);
        const whitespace = /^\s+/u.exec(tail)?.[0];
        if (whitespace !== undefined) {
            offset += whitespace.length;
            continue;
        }
        if (tail.startsWith('#')) {
            const end = tail.search(/[\r\n]/u);
            offset = end < 0 ? text.length : offset + end + 1;
            continue;
        }
        const quote = tail[0];
        if (quote === '"' || quote === "'") {
            const delimiter = tail.startsWith(quote.repeat(3)) ? quote.repeat(3) : quote;
            let end = offset + delimiter.length;
            let closed = false;
            while (end < text.length) {
                if (text[end] === '\\') {
                    end += 2;
                } else if (text.startsWith(delimiter, end)) {
                    end += delimiter.length;
                    closed = true;
                    break;
                } else {
                    end += 1;
                }
            }
            if (!closed) {
                return null;
            }
            tokens.push({ kind: 'literal', text: text.slice(offset, end) });
            offset = end;
            continue;
        }
        const iri = /^<[^<>"{}|^`\\\s]*>/u.exec(tail)?.[0];
        if (iri !== undefined) {
            if (!/^<[A-Za-z][A-Za-z0-9+.-]*:/u.test(iri)) {
                return null;
            }
            tokens.push({ kind: 'iri', text: iri });
            offset += iri.length;
            continue;
        }
        const variable = /^[?$][A-Za-z_][A-Za-z_0-9]*/u.exec(tail)?.[0];
        const name = /^(?:[A-Za-z_][A-Za-z_0-9.-]*)?:[A-Za-z_0-9.:-]*/u.exec(tail)?.[0];
        const language = /^@[A-Za-z]+(?:-[A-Za-z0-9]+)*/u.exec(tail)?.[0];
        const number = /^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?/u.exec(tail)?.[0];
        const word = /^[A-Za-z_][A-Za-z_0-9]*/u.exec(tail)?.[0];
        const operator = /^(?:\|\||&&|!=|<=|>=|\^\^|[{}()[\];,.*+/?!|^=<>-])/u.exec(tail)?.[0];
        const selected = variable ?? name ?? language ?? number ?? word ?? operator;
        if (selected === undefined) {
            return null;
        }
        tokens.push({
            kind: selected === name ? 'name' : selected === number ? 'number' : selected === word ? 'word' : 'other',
            text: selected,
        });
        offset += selected.length;
    }
    return tokens;
}

export function admitTransitionQuery(text: string): Readonly<{
    form: 'select' | 'ask';
    canonical: string;
}> | null {
    if (Buffer.byteLength(text) > QUESTION_TRANSITION_LIMITS.maxQueryBytes) {
        return null;
    }
    const tokens = tokenizeTransitionQuery(text);
    if (tokens === null) {
        return null;
    }
    let start = 0;
    while (tokens[start]?.kind === 'word' && tokens[start]?.text.toUpperCase() === 'PREFIX') {
        if (
            tokens[start + 1]?.kind !== 'name' ||
            !tokens[start + 1]?.text.endsWith(':') ||
            tokens[start + 2]?.kind !== 'iri'
        ) {
            return null;
        }
        start += 3;
    }
    const form = tokens[start]?.kind === 'word' ? tokens[start]?.text.toLowerCase() : undefined;
    if (form !== 'select' && form !== 'ask') {
        return null;
    }
    for (let index = start; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === undefined) {
            return null;
        }
        const upper = token.text.toUpperCase();
        // Typed constants and constructed datatypes can lose lexical/type identity
        // inside the pinned engine. Only canonical integer numeric tokens are safe;
        // decimals, exponents, leading zeroes, explicit plus and negative zero are refused.
        if (token.text === '^^' || (token.kind === 'number' && !/^(?:0|-?[1-9][0-9]*)$/u.test(token.text))) {
            return null;
        }
        if (
            token.kind === 'word' &&
            (FORBIDDEN.has(upper) || (index !== start && (upper === 'SELECT' || upper === 'ASK')))
        ) {
            return null;
        }
        if (tokens[index + 1]?.text === '(') {
            if (token.kind === 'iri' || token.kind === 'name') {
                return null;
            }
            if (
                token.kind === 'word' &&
                !FUNCTIONS.has(upper) &&
                !(index === start && form === 'select') &&
                upper !== 'DISTINCT' &&
                upper !== 'REDUCED'
            ) {
                return null;
            }
        }
    }
    return Object.freeze({ form, canonical: tokens.map((token) => token.text).join(' ') });
}
