export const MAX_TITLE = 200;
export const MAX_LOCATION = 200;
export const MAX_DESCRIPTION = 2000;

const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

export function isValidIso8601(value: string): boolean {
    if (!ISO_8601_RE.test(value)) return false;
    const t = Date.parse(value);
    return !Number.isNaN(t);
}

export function normalizeString(value: unknown): string | null | undefined | 'TYPE_ERROR' | 'MAXLEN_ERROR' {
    // undefined => non fourni, null => explicitement null
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== 'string') return 'TYPE_ERROR';

    const trimmed = value.trim();
    return trimmed;
}

export function validateMaxLen(value: string, max: number): boolean {
    return value.length <= max;
}
