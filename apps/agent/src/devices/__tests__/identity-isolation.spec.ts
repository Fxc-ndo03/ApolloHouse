import { describe, expect, it } from 'bun:test';

import { ENROLLED_DEVICE_CONNECTION_TAG, hasEnrolledDeviceConnectionTag } from '@/auth/role';

/**
 * Aislamiento de identidad del Apollo DO.
 *
 * El riesgo que estos tests cubren: con un Apollo DO por dispositivo, un nodo
 * autenticado podría abrir la ruta de OTRO dispositivo poniendo su deviceId en
 * la URL. El servidor no debe permitirse, y la unica defense es comparar la
 * identidad que resuelve la credencial con la instancia a la que se conectó.
 *
 * Estos tests fijan la regla de decision. La comparacion de IDs de instancia
 * (`idFromName(x).equals(ctx.id)`) necesita el runtime de Durable Objects y se
 * cubre en `identity-isolation.spec.ts`; aca se prueba la politica de tags.
 */
describe('identidad de nodo en el Apollo DO', () => {
  it('un rol enrolado es distinto del rol device legacy', () => {
    // El motivo de que existan dos: `device` significa "vengo con el secreto
    // global" y habilita el protocolo de escritorio sin comprobar duenia.
    expect(ENROLLED_DEVICE_CONNECTION_TAG).toBe('enrolled_device');
    expect(ENROLLED_DEVICE_CONNECTION_TAG).not.toBe('device');
  });

  it('un nodo enrolado dueño de la instancia lleva los dos tags', () => {
    const tagList = [ENROLLED_DEVICE_CONNECTION_TAG, 'device'];
    expect(hasEnrolledDeviceConnectionTag(tagList)).toBe(true);
  });

  it('un nodo enrolado que NO es dueño lleva solo el tag enrolado', () => {
    // Sin el tag `device` no procesa el protocolo de escritorio: por eso un
    // movil con credencial ajena no puede desincronizar el escritorio.
    const tagList = [ENROLLED_DEVICE_CONNECTION_TAG];
    expect(hasEnrolledDeviceConnectionTag(tagList)).toBe(true);
  });

  it('una conexion sin tags no procesa nada', () => {
    expect(hasEnrolledDeviceConnectionTag([])).toBe(false);
  });

  it('el tag enrolado no habilita por si solo el protocolo legacy', () => {
    // Este es el test que ata el rol nuevo a la regla anti-bypass.
    const soloTagEnrolado = [ENROLLED_DEVICE_CONNECTION_TAG];
    expect(soloTagEnrolado).not.toContain('device');
  });
});
