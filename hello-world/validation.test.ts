import { describe, expect, it } from 'vitest';
import {
    isValidIso8601,
    MAX_DESCRIPTION,
    MAX_LOCATION,
    MAX_TITLE,
    normalizeString,
    validateMaxLen,
} from './validation';

describe('validation', () => {
    it('accepts ISO date YYYY-MM-DD', () => {
        expect(isValidIso8601('2026-01-27')).toBe(true);
    });

    it('rejects non-ISO date', () => {
        expect(isValidIso8601('27/01/2026')).toBe(false);
    });

    it('normalizeString returns TYPE_ERROR for non-string', () => {
        expect(normalizeString(123)).toBe('TYPE_ERROR');
    });

    it('validateMaxLen rejects too long title', () => {
        const tooLong = 'a'.repeat(MAX_TITLE + 1);
        expect(validateMaxLen(tooLong, MAX_TITLE)).toBe(false);
    });

    it('validateMaxLen accepts max lengths for optional fields', () => {
        expect(validateMaxLen('a'.repeat(MAX_LOCATION), MAX_LOCATION)).toBe(true);
        expect(validateMaxLen('a'.repeat(MAX_DESCRIPTION), MAX_DESCRIPTION)).toBe(true);
    });
});
