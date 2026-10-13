import { describe, expect, it } from 'bun:test';

import { createAuthorizedConnectionRegistry } from '@/agents/connection-authorization';

describe('ciclo de vida de conexiones autorizadas (FASE 2.7)', () => {
  it('una conexión autorizada funciona mientras está activa', () => {
    const registry = createAuthorizedConnectionRegistry();
    registry.authorize('conn-1');
    expect(registry.isAuthorized('conn-1')).toBe(true);
  });

  it('una conexión cerrada deja de estar autorizada', () => {
    const registry = createAuthorizedConnectionRegistry();
    registry.authorize('conn-1');
    registry.revoke('conn-1');
    expect(registry.isAuthorized('conn-1')).toBe(false);
  });

  it('una conexión rechazada nunca queda autorizada', () => {
    const registry = createAuthorizedConnectionRegistry();
    // La conexión rechazada JAMÁS pasa por authorize(): sólo se comprueba.
    expect(registry.isAuthorized('conn-rechazada')).toBe(false);
  });

  it('la reconexión de un dispositivo revocado no recupera el acceso', () => {
    const registry = createAuthorizedConnectionRegistry();
    registry.authorize('conn-pc-a');
    registry.revoke('conn-pc-a');
    // El dispositivo reconecta: el runtime genera OTRA conexión (otro id) que
    // sólo se autoriza si la autenticación vuelve a pasar (en onConnect).
    const reconexionId = 'conn-pc-a-reconectada';
    expect(registry.isAuthorized(reconexionId)).toBe(false);
    // Y la autorización anterior ya no existe: no es reutilizable.
    expect(registry.isAuthorized('conn-pc-a')).toBe(false);
  });

  it('el cierre de una conexión no afecta a otras válidas de la misma cuenta', () => {
    const registry = createAuthorizedConnectionRegistry();
    registry.authorize('conn-pc');
    registry.authorize('conn-phone');
    registry.revoke('conn-pc');
    expect(registry.isAuthorized('conn-phone')).toBe(true);
    expect(registry.isAuthorized('conn-pc')).toBe(false);
  });

  it('revocar dos veces es idempotente y el tamaño refleja las vivas', () => {
    const registry = createAuthorizedConnectionRegistry();
    registry.authorize('a');
    registry.authorize('b');
    registry.revoke('a');
    registry.revoke('a');
    expect(registry.size()).toBe(1);
  });
});
