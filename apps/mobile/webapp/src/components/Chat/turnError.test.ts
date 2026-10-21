import { describe, expect, it } from 'bun:test';

import { describeTurnError, resolveTurnErrorCategory } from './turnError';

describe('resolveTurnErrorCategory', () => {
  it('reconoce el limite por minuto del Worker', () => {
    expect(resolveTurnErrorCategory('quota_exceeded', 'Límite de uso alcanzado (requestsPerMinute)')).toBe(
      'quota_per_minute',
    );
  });

  it('reconoce la cuota agotada por otro limite', () => {
    expect(resolveTurnErrorCategory('quota_exceeded', 'Límite de uso alcanzado (dailyTokens)')).toBe(
      'quota_exhausted',
    );
  });

  it('distingue 401 y 403 de un limite de cuota', () => {
    expect(resolveTurnErrorCategory('unauthorized', 'Sesión inválida')).toBe('not_authenticated');
    expect(resolveTurnErrorCategory('forbidden', 'Prohibido')).toBe('not_authorized');
  });

  it('distingue facturacion de cuota', () => {
    expect(resolveTurnErrorCategory('payment_required', 'Sin crédito')).toBe('billing');
  });

  it('no inventa categoria para un error desconocido', () => {
    expect(resolveTurnErrorCategory('lo_que_sea', 'algo raro')).toBe('unknown');
  });
});

describe('describeTurnError', () => {
  it('una cuota NO se presenta como error de conexion', () => {
    const described = describeTurnError('quota_exceeded', 'Límite de uso alcanzado (requestsPerMinute)');
    expect(described.isConnectionFailure).toBe(false);
    expect(described.title).toBe('Esperá un momento');
    expect(described.detail).toContain('turnos por minuto');
  });

  it('la cuota agotada dice que no es problema de conexion', () => {
    const described = describeTurnError('quota_exceeded', 'Límite de uso alcanzado (monthlyTokens)');
    expect(described.isConnectionFailure).toBe(false);
    expect(described.detail).toContain('No es un problema de tu conexión');
  });

  it('un fallo de red SI se presenta como error de conexion', () => {
    expect(describeTurnError('network_error', 'sin red').isConnectionFailure).toBe(true);
  });

  it('un error desconocido conserva el mensaje del servidor', () => {
    expect(describeTurnError('raro', 'detalle real').detail).toBe('detalle real');
  });

  it('no filtra la clave interna del limite en el texto para la persona', () => {
    const described = describeTurnError('quota_exceeded', 'Límite de uso alcanzado (requestsPerMinute)');
    expect(described.detail).not.toContain('requestsPerMinute');
  });
});

describe('el agotamiento del proveedor no se disfraza de cuota de Apollo', () => {
  const REAL = 'Se agoto la asignacion diaria gratuita de Cloudflare Workers AI (10.000 neurons).';

  it('clasifica la asignacion diaria del proveedor como provider_allocation', () => {
    expect(resolveTurnErrorCategory('turn_failed', REAL)).toBe('provider_allocation');
  });

  it('reconoce el codigo 4006 crudo', () => {
    expect(resolveTurnErrorCategory('turn_failed', '4006: you have used up your daily free allocation of 10,000 neurons')).toBe('provider_allocation');
  });

  it('NO lo confunde con la cuota de producto', () => {
    expect(resolveTurnErrorCategory('turn_failed', REAL)).not.toBe('quota_exhausted');
  });

  it('NO es un fallo de conexion: el socket sigue vivo', () => {
    expect(describeTurnError('turn_failed', REAL).isConnectionFailure).toBe(false);
  });

  it('explica que la cuota de Apollo no es el problema', () => {
    expect(describeTurnError('turn_failed', REAL).detail).toContain('Apollo');
  });

  it('distingue modelo no disponible de asignacion agotada', () => {
    expect(resolveTurnErrorCategory('turn_failed', 'El modelo WORKERS_AI_LLM_MODEL configurado no esta disponible')).toBe('provider_unavailable');
  });
});
