// ─────────────────────────────────────────────────────────────────────────────────
// RC Deliveries — the formula cell.
//
// Operators have kept the RC sheet in Excel for years and type arithmetic straight
// into two columns. Both patterns are load-bearing, not cosmetic:
//
//   WT       `=27045*88%`   the truck scaled 27,045 kg; 12% comes off for wet/quality,
//                           and 23,799.6 kg is what actually gets paid for
//   PHP/KG   `=39.5+2.7`    a base price plus a sundrying/handling adjustment
//
// So this module does two jobs. `evaluateFormula` is a general arithmetic evaluator so
// the cell behaves like Excel. `parseWeightInput` / `parsePriceInput` then DECOMPOSE the
// recognised shapes into their business parts, because the next feature is liquidation
// and "we paid on 23,799.6 kg" is a much weaker record than "the scale said 27,045 and
// we deducted 12%".
//
// NO `eval`, NO `new Function`. This parses operator-typed text that is rendered back
// into the page; a recursive-descent parser over a fixed grammar is the whole reason
// arbitrary input is safe here.
//
// Grammar (`%` is Excel's postfix "divide by 100", so `88%` is the literal 0.88):
//
//   expr    := term (('+' | '-') term)*
//   term    := factor (('*' | '/') factor)*
//   factor  := ('-' | '+')* postfix
//   postfix := primary '%'*
//   primary := NUMBER | '(' expr ')'
// ─────────────────────────────────────────────────────────────────────────────────

/** Kilograms carry 3 decimals; a deduction can land on a fraction of a kilo. */
export const WEIGHT_PRECISION = 3;
/** ₱/kg carries 4 — `=38.5+2.61` must not round before it reaches the total. */
export const PRICE_PRECISION = 4;

export type FormulaResult =
    | { ok: true; value: number }
    | { ok: false; error: string };

// ─── Rounding ────────────────────────────────────────────────────────────────────

/**
 * Round half away from zero at `dp` decimals, scaling through a string to dodge the
 * float artefact that makes the naive version wrong.
 *
 * `27045 * 0.88` is `23799.600000000002` in IEEE-754, and `Math.round(x * 1000) / 1000`
 * inherits that error on other inputs (the classic `1.005` case). Re-parsing the
 * exponent-shifted decimal string sidesteps it.
 */
export function roundTo(value: number, dp: number): number {
    if (!Number.isFinite(value)) return value;
    const shifted = Number(`${value}e${dp}`);
    if (!Number.isFinite(shifted)) return value;
    return Number(`${Math.round(Math.abs(shifted)) * Math.sign(shifted) || 0}e${-dp}`);
}

// ─── Tokenizer ───────────────────────────────────────────────────────────────────

type Operator = '+' | '-' | '*' | '/' | '%' | '(' | ')';

type Token =
    | { kind: 'num'; value: number }
    | { kind: 'op'; value: Operator };

const OPERATORS: readonly Operator[] = ['+', '-', '*', '/', '%', '(', ')'];

function asOperator(ch: string): Operator | null {
    return (OPERATORS as readonly string[]).includes(ch) ? (ch as Operator) : null;
}

function tokenize(input: string): Token[] | string {
    // Drop digit-grouping commas first (`21,865` -> `21865`), so a comma between two
    // digits is absorbed into its number rather than splitting it in two. A comma
    // anywhere else survives to be reported as an error.
    const src = input.replace(/(\d),(?=\d)/g, '$1');

    const tokens: Token[] = [];
    let i = 0;

    while (i < src.length) {
        const ch = src[i];

        if (ch === ' ' || ch === '\t') {
            i++;
            continue;
        }

        const op = asOperator(ch);
        if (op) {
            tokens.push({ kind: 'op', value: op });
            i++;
            continue;
        }

        // A number: digits with at most one decimal point. No exponent form — nothing in
        // the sheet uses it, and rejecting it keeps a typo like `1e5` a visible error.
        if (/[0-9.]/.test(ch)) {
            const start = i;
            let seenDot = false;
            while (i < src.length && /[0-9.]/.test(src[i])) {
                if (src[i] === '.') {
                    if (seenDot) return `"${src.slice(start, i + 1)}" has two decimal points`;
                    seenDot = true;
                }
                i++;
            }
            const text = src.slice(start, i);
            const value = Number(text);
            if (!Number.isFinite(value)) return `"${text}" is not a number`;
            tokens.push({ kind: 'num', value });
            continue;
        }

        return `unexpected character "${ch}"`;
    }

    return tokens;
}

// ─── Parser ──────────────────────────────────────────────────────────────────────

class Parser {
    private pos = 0;
    constructor(private readonly tokens: Token[]) {}

    private peek(): Token | undefined {
        return this.tokens[this.pos];
    }

    private eatOp(...values: string[]): string | null {
        const t = this.peek();
        if (t && t.kind === 'op' && values.includes(t.value)) {
            this.pos++;
            return t.value;
        }
        return null;
    }

    parse(): number {
        const value = this.expr();
        if (this.pos < this.tokens.length) {
            const t = this.tokens[this.pos];
            throw new Error(
                t.kind === 'op' ? `unexpected "${t.value}"` : `unexpected number ${t.value}`,
            );
        }
        return value;
    }

    private expr(): number {
        let left = this.term();
        for (;;) {
            const op = this.eatOp('+', '-');
            if (!op) return left;
            const right = this.term();
            left = op === '+' ? left + right : left - right;
        }
    }

    private term(): number {
        let left = this.factor();
        for (;;) {
            const op = this.eatOp('*', '/');
            if (!op) return left;
            const right = this.factor();
            if (op === '/') {
                if (right === 0) throw new Error('division by zero');
                left = left / right;
            } else {
                left = left * right;
            }
        }
    }

    private factor(): number {
        const op = this.eatOp('-', '+');
        if (op) {
            const value = this.factor();
            return op === '-' ? -value : value;
        }
        return this.postfix();
    }

    private postfix(): number {
        let value = this.primary();
        while (this.eatOp('%')) value = value / 100;
        return value;
    }

    private primary(): number {
        const t = this.peek();
        if (!t) throw new Error('the formula ends early');
        if (t.kind === 'num') {
            this.pos++;
            return t.value;
        }
        if (t.value === '(') {
            this.pos++;
            const value = this.expr();
            if (!this.eatOp(')')) throw new Error('a "(" is never closed');
            return value;
        }
        throw new Error(`unexpected "${t.value}"`);
    }
}

// ─── Public evaluation ───────────────────────────────────────────────────────────

/** True when the operator meant this cell as a formula rather than a typed number. */
export function isFormula(input: string): boolean {
    return input.trim().startsWith('=');
}

/**
 * Evaluate a cell's raw text. Accepts a leading `=` (Excel habit) or a bare expression,
 * so `=27045*88%`, `27045*88%` and `21865` all work.
 */
export function evaluateFormula(input: string, dp = WEIGHT_PRECISION): FormulaResult {
    const body = input.trim().replace(/^=/, '').trim();
    if (!body) return { ok: false, error: 'the formula is empty' };

    const tokens = tokenize(body);
    if (typeof tokens === 'string') return { ok: false, error: tokens };
    if (tokens.length === 0) return { ok: false, error: 'the formula is empty' };

    try {
        const value = new Parser(tokens).parse();
        if (!Number.isFinite(value)) return { ok: false, error: 'the result is not a number' };
        return { ok: true, value: roundTo(value, dp) };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'could not be read' };
    }
}

// ─── Weight: gross · deduction · net ─────────────────────────────────────────────

export interface WeightParts {
    /** What the scale said. */
    grossKg: number | null;
    /** Percentage REMOVED — 12 for `*88%`. `null` means no deduction was expressed. */
    deductionPct: number | null;
    /** What gets paid for. */
    netKg: number | null;
    /** The literal text typed, kept only when it was a formula. */
    formula: string | null;
}

/** `27045*88%` — a keep-rate. The deduction is the remainder. */
const KEEP_RATE = /^([0-9]*\.?[0-9]+)\*([0-9]*\.?[0-9]+)%$/;
/** `27045-(27045*12%)` — the same haircut written out longhand. */
const SUBTRACT_RATE = /^([0-9]*\.?[0-9]+)-\(?([0-9]*\.?[0-9]+)\*([0-9]*\.?[0-9]+)%\)?$/;

/**
 * Decompose a WT cell.
 *
 * Only the two shapes the sheet actually uses are decomposed. Anything else that still
 * evaluates is honoured as a value but reported with `deductionPct: null` and gross ===
 * net — because a deduction cannot be honestly inferred from arbitrary arithmetic, and
 * inventing one would put a wrong number in front of a cheque.
 */
export function parseWeightInput(input: string): WeightParts | { error: string } {
    const raw = input.trim();
    if (!raw) return { grossKg: null, deductionPct: null, netKg: null, formula: null };

    const result = evaluateFormula(raw, WEIGHT_PRECISION);
    if (!result.ok) return { error: result.error };

    const formula = isFormula(raw) ? raw : null;
    const body = raw.replace(/^=/, '').replace(/\s/g, '');

    const keep = KEEP_RATE.exec(body);
    if (keep) {
        const gross = Number(keep[1]);
        const keepPct = Number(keep[2]);
        if (keepPct > 0 && keepPct < 100) {
            return {
                grossKg: roundTo(gross, WEIGHT_PRECISION),
                deductionPct: roundTo(100 - keepPct, 4),
                netKg: result.value,
                formula,
            };
        }
    }

    const sub = SUBTRACT_RATE.exec(body);
    if (sub && sub[1] === sub[2]) {
        const pct = Number(sub[3]);
        if (pct > 0 && pct < 100) {
            return {
                grossKg: roundTo(Number(sub[1]), WEIGHT_PRECISION),
                deductionPct: roundTo(pct, 4),
                netKg: result.value,
                formula,
            };
        }
    }

    return { grossKg: result.value, deductionPct: null, netKg: result.value, formula };
}

// ─── Price: base · adjustment ────────────────────────────────────────────────────

export interface PriceParts {
    basePhpKg: number | null;
    /** The add-on (sundrying, handling). `null` when the price was typed flat. */
    adjustmentPhpKg: number | null;
    effectivePhpKg: number | null;
    formula: string | null;
}

/** `39.5+2.7` — base plus one add-on, the only shape the sheet uses. */
const BASE_PLUS_ADJ = /^([0-9]*\.?[0-9]+)\+([0-9]*\.?[0-9]+)$/;

export function parsePriceInput(input: string): PriceParts | { error: string } {
    const raw = input.trim();
    if (!raw) return { basePhpKg: null, adjustmentPhpKg: null, effectivePhpKg: null, formula: null };

    const result = evaluateFormula(raw, PRICE_PRECISION);
    if (!result.ok) return { error: result.error };

    const formula = isFormula(raw) ? raw : null;
    const body = raw.replace(/^=/, '').replace(/\s/g, '');

    const m = BASE_PLUS_ADJ.exec(body);
    if (m) {
        return {
            basePhpKg: roundTo(Number(m[1]), PRICE_PRECISION),
            adjustmentPhpKg: roundTo(Number(m[2]), PRICE_PRECISION),
            effectivePhpKg: result.value,
            formula,
        };
    }

    return {
        basePhpKg: result.value,
        adjustmentPhpKg: null,
        effectivePhpKg: result.value,
        formula,
    };
}

// ─── Round-tripping the cell ─────────────────────────────────────────────────────

/**
 * What the cell should show when the operator clicks INTO it: the original formula if
 * there was one, otherwise the plain number. This is the half that makes the grid feel
 * like Excel rather than like a form that ate your arithmetic.
 */
export function formulaCellText(formula: string | null, value: number | null): string {
    if (formula) return formula;
    return value === null || value === undefined ? '' : String(value);
}

/**
 * Rebuild the canonical formula text from stored parts, for a row whose numbers were
 * set by the importer rather than typed. Keeps an imported `88%` row indistinguishable
 * from one an operator typed today.
 */
export function weightFormulaFrom(grossKg: number | null, deductionPct: number | null): string | null {
    if (grossKg === null || deductionPct === null || deductionPct <= 0) return null;
    return `=${grossKg}*${roundTo(100 - deductionPct, 4)}%`;
}

export function priceFormulaFrom(base: number | null, adjustment: number | null): string | null {
    if (base === null || adjustment === null || adjustment === 0) return null;
    return `=${base}+${adjustment}`;
}
