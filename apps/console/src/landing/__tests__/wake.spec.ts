import { describe, expect, it } from 'bun:test';

import {
  advanceWakeWord,
  appendToWakeBuffer,
  isWakePhrasePrefix,
  matchesWakePhrase,
  normalizeWakeCharacter,
} from '@/landing/wake';

function typePhrase(phrase: string): string {
  let buffer = '';
  for (const key of phrase) {
    buffer = appendToWakeBuffer(buffer, key);
  }
  return buffer;
}

function typeWord(keyList: readonly string[]): string {
  let currentWord = '';
  for (const key of keyList) {
    currentWord = advanceWakeWord(currentWord, key);
  }
  return currentWord;
}

describe('normalizeWakeCharacter', () => {
  it('lowercases plain letters', () => {
    expect(normalizeWakeCharacter('H')).toBe('h');
  });

  it('strips diacritics so the accented wake word matches', () => {
    expect(normalizeWakeCharacter('ó')).toBe('o');
  });

  it('rejects digits, punctuation, and named keys', () => {
    expect(normalizeWakeCharacter('4')).toBeNull();
    expect(normalizeWakeCharacter(',')).toBeNull();
    expect(normalizeWakeCharacter('Shift')).toBeNull();
    expect(normalizeWakeCharacter(' ')).toBeNull();
  });
});

describe('matchesWakePhrase', () => {
  it('detects the phrase typed with punctuation', () => {
    expect(matchesWakePhrase(typePhrase('Okey Google!'))).toBe(true);
  });

  it('detects the phrase in lowercase', () => {
    expect(matchesWakePhrase(typePhrase('okeygoogle'))).toBe(true);
  });

  it('detects the phrase buried in earlier typing', () => {
    expect(matchesWakePhrase(typePhrase('lorem ipsum okeygoogle'))).toBe(true);
  });

  it('ignores unrelated typing', () => {
    expect(matchesWakePhrase(typePhrase('okey there google fans, hello'))).toBe(false);
  });

  it('keeps the rolling buffer bounded', () => {
    expect(typePhrase('a'.repeat(200)).length).toBeLessThanOrEqual(24);
  });
});

describe('isWakePhrasePrefix', () => {
  it('holds the space key while the wake word is being typed', () => {
    expect(isWakePhrasePrefix('o')).toBe(true);
    expect(isWakePhrasePrefix('okey')).toBe(true);
    expect(isWakePhrasePrefix('okeygoog')).toBe(true);
  });

  it('lets the space key page the document during ordinary reading', () => {
    expect(isWakePhrasePrefix('')).toBe(false);
    expect(isWakePhrasePrefix('along')).toBe(false);
  });

  it('does not treat a word merely ending in a wake prefix as one', () => {
    for (const ordinaryWord of ['with', 'they', 'each', 'such', 'the']) {
      expect(isWakePhrasePrefix(ordinaryWord)).toBe(false);
    }
  });
});

describe('advanceWakeWord', () => {
  it('keeps the prefix alive across punctuation of the phrase', () => {
    expect(typeWord(['O', 'k', 'e', 'y', '!'])).toBe('okey');
    expect(isWakePhrasePrefix(typeWord(['O', 'k', 'e', 'y', '!']))).toBe(true);
  });

  it('ends the word on every key that is not typed into the phrase', () => {
    for (const breakingKey of [
      'Shift',
      'CapsLock',
      'Backspace',
      'Enter',
      'Tab',
      'Escape',
      'ArrowLeft',
      ' ',
      '4',
    ]) {
      expect(typeWord(['o', 'k', 'e', 'y', breakingKey])).toBe('');
    }
  });

  it('ends the word on punctuation that follows ordinary reading', () => {
    expect(typeWord(['w', 'h', 'i', 'c', 'h', ','])).toBe('');
  });
});
