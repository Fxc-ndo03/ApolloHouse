import { describe, expect, test } from 'bun:test';
import { parseSignerSha256 } from './verify-android-apk';

const expected = '1521135c0ccd9453e0ac5f69450e52315ec090f1c9faf086df605137290e673c';

describe('parseSignerSha256', () => {
  test('lee el formato V2 registrado por el workflow', () => {
    const output = [
      'Verifies',
      'V2 Signer: certificate DN: C=US, O=Android, CN=Android Debug V2 Signer',
      `V2 Signer: certificate SHA-256 digest: ${expected}`,
    ].join('\r\n');

    expect(parseSignerSha256(output)).toBe(expected);
  });

  test('tolera saltos de línea, espacios antes de los dos puntos y digest separado', () => {
    const spaced = expected.match(/.{2}/g)!.join(':');
    const output = `Signer #1 certificate SHA - 256 digest  :\n${spaced}`;

    expect(parseSignerSha256(output)).toBe(expected);
  });

  test('no interpreta texto sin digest de certificado como firma', () => {
    expect(parseSignerSha256('apksigner terminó sin información del certificado')).toBeNull();
  });
});
