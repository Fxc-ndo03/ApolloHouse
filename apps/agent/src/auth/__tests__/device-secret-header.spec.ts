import { describe, expect, it } from 'bun:test';

import { readDeviceSecretFromRequest } from '@/auth/token';

const SECRET = 'un-secreto-global-de-prueba';

/**
 * El secreto global del PC viaja en un header, no en la query string.
 *
 * Un `?token=` aparece en los access logs del servidor, en `Referer`, en
 * cualquier `console.log` de una URL y en los diagnósticos del runtime. Estos
 * tests fijan las tres propiedades del camino nuevo:
 *   1. lee del header;
 *   2. NO acepta el espacio de credenciales individuales;
 *   3. la query string sigue funcionando, para no romper clientes en producción.
 */
describe('secreto del dispositivo en header', () => {
  const buildRequest = (init: RequestInit & { url?: string }): Request =>
    new Request(init.url ?? 'wss://worker.example/agents/apollo/default', init);

  it('lee el secreto del header propio', () => {
    const request = buildRequest({ headers: { 'X-Apollo-Device-Secret': SECRET } });
    expect(readDeviceSecretFromRequest(request)).toBe(SECRET);
  });

  it('el header no es case-sensitive para el nombre', () => {
    const request = buildRequest({ headers: { 'x-apollo-device-secret': SECRET } });
    expect(readDeviceSecretFromRequest(request)).toBe(SECRET);
  });

  it('un header con espacios alrededor se recorta', () => {
    const request = buildRequest({ headers: { 'X-Apollo-Device-Secret': `  ${SECRET}  ` } });
    expect(readDeviceSecretFromRequest(request)).toBe(SECRET);
  });

  it('sin header cae a la query string (clientes viejos siguen funcionando)', () => {
    const request = buildRequest({ url: `wss://worker.example/agents/apollo/default?token=${SECRET}` });
    expect(readDeviceSecretFromRequest(request)).toBe(SECRET);
  });

  it('el header tiene prioridad sobre la query string', () => {
    // Si vinieran los dos con valores distintos, manda el header. Evita que un
    // intermediario pueda inyectar un token en la URL ypisar el del header.
    const request = buildRequest({
      url: 'wss://worker.example/agents/apollo/default?token=token-de-la-url',
      headers: { 'X-Apollo-Device-Secret': SECRET },
    });
    expect(readDeviceSecretFromRequest(request)).toBe(SECRET);
  });

  it('sin header ni query devuelve null', () => {
    expect(readDeviceSecretFromRequest(buildRequest({}))).toBeNull();
  });

  it('un header vacío no cuenta como secreto presented', () => {
    const request = buildRequest({ headers: { 'X-Apollo-Device-Secret': '   ' } });
    expect(readDeviceSecretFromRequest(request)).toBeNull();
  });

  it('NO lee el espacio de credenciales individuales', () => {
    // El aislamiento de ámbitos: `Authorization: Bearer` es de credencial
    // individual y jamás debe interpretarse como secreto global. Si este test
    // falla, una credencial de teléfono podría actuar como llave global.
    const request = buildRequest({
      headers: { Authorization: 'Bearer apollo_dev_credencial-individual' },
    });
    expect(readDeviceSecretFromRequest(request)).toBeNull();
  });

  it('el header propio no aparece en la URL', () => {
    // El motivo del cambio: la URL es lo que se registra. Con el header, no.
    const request = buildRequest({ headers: { 'X-Apollo-Device-Secret': SECRET } });
    expect(request.url).not.toContain(SECRET);
  });
});
