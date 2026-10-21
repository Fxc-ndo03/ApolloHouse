import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  ALLOWED_POSTPONE_HOURS,
  UPDATE_STATUS_KINDS,
  describeUpdateState,
  isRetryableFailure,
  isStagingApp,
  normalizeUpdateStatus,
  normalizeUpdateStatusKind,
  postponeDeadline,
  readProgressPercent,
  shouldNotifyUser,
  shouldOfferInstall,
  type UpdateStatus,
} from '../../desktop/ui/src/components/Settings/updateState';

/**
 * FASE 3.1 — pruebas de la lógica del panel de actualizaciones de escritorio.
 *
 * Unitarias: verifican qué se le muestra a la persona y cuándo se ofrece
 * instalar. NO simulan una descarga real ni una instalación real; eso no se
 * puede comprobar desde aquí y no se afirma.
 */

function estado(partial: Partial<UpdateStatus['status']> & { kind: UpdateStatus['status']['kind'] }): UpdateStatus['status'] {
  return partial as UpdateStatus['status'];
}

function estadoCompleto(status: UpdateStatus['status']): UpdateStatus {
  return {
    channel: 'stable',
    installedVersion: '0.1.1',
    status,
    latestVersion: '0.2.0',
    notes: null,
    publishedAt: null,
    message: null,
  };
}

describe('estado del actualizador de escritorio', () => {
  it('1. sin actualizacion no molesta: lo dice y no ofrece instalar', () => {
    const status = estado({ kind: 'upToDate' });
    expect(describeUpdateState(estadoCompleto(status))).toContain('al dia');
    expect(shouldOfferInstall(status)).toBe(false);
    expect(shouldNotifyUser(status)).toBe(false);
  });

  it('2. con version nueva ofrece instalar y avisa', () => {
    const status = estado({ kind: 'available' });
    expect(describeUpdateState(estadoCompleto(status))).toContain('0.2.0');
    expect(shouldOfferInstall(status)).toBe(true);
    expect(shouldNotifyUser(status)).toBe(true);
  });

  it('3. un manifiesto invalido se refleja como fallo, no como disponible', () => {
    const status = estado({ kind: 'failed', reason: 'El manifiesto no se pudo interpretar' });
    expect(shouldOfferInstall(status)).toBe(false);
    expect(describeUpdateState(estadoCompleto(status))).toContain('manifiesto');
  });

  it('4. el progreso se normaliza y descarta lo que no es porcentaje', () => {
    expect(readProgressPercent(42.4)).toBe(42);
    expect(readProgressPercent(-5)).toBe(0);
    expect(readProgressPercent(150)).toBe(100);
    expect(readProgressPercent(Number.NaN)).toBeNull();
    expect(readProgressPercent('42')).toBeNull();
    expect(readProgressPercent(null)).toBeNull();
  });

  it('5. un error de red es reintentable; uno de firma, nunca', () => {
    expect(isRetryableFailure('No se pudo contactar al servidor de actualizaciones')).toBe(true);
    expect(isRetryableFailure('La firma de la actualizacion no es valida')).toBe(false);
    expect(isRetryableFailure('La descarga no coincide con el hash esperado')).toBe(false);
  });

  it('7. una version anterior nunca se ofrece instalar', () => {
    // El filtro de version vive en Rust (updates.rs) porque necesita SemVer; acá
    // se verifica que la UI no puede saltarse ese filtro offering instalar.
    expect(shouldOfferInstall(estado({ kind: 'idle' }))).toBe(false);
    expect(shouldOfferInstall(estado({ kind: 'upToDate' }))).toBe(false);
    expect(shouldOfferInstall(estado({ kind: 'failed', reason: 'x' }))).toBe(false);
  });

  it('8. un canal distinto se reconoce y no se mezcla', () => {
    expect(isStagingApp({ ...estadoCompleto(estado({ kind: 'upToDate' })), channel: 'staging' })).toBe(true);
    expect(isStagingApp(estadoCompleto(estado({ kind: 'upToDate' })))).toBe(false);
  });

  it('9. reiniciar solo se ofrece cuando hay algo instalado pendiente', () => {
    expect(shouldNotifyUser(estado({ kind: 'pendingRestart' }))).toBe(true);
    expect(shouldNotifyUser(estado({ kind: 'downloading', percent: 10 }))).toBe(false);
  });

  it('11. posponer acepta las horas acordadas y rechaza el resto', () => {
    for (const hours of ALLOWED_POSTPONE_HOURS) {
      const result = postponeDeadline(1_000, hours);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.untilEpochSeconds).toBe(1_000 + hours * 3600);
      }
    }
    expect(postponeDeadline(1_000, 0).ok).toBe(false);
    expect(postponeDeadline(1_000, 5).ok).toBe(false);
    expect(postponeDeadline(1_000, -3).ok).toBe(false);
  });

  it('el estado de posponer queda registrado para mostrarlo', () => {
    const status = estado({ kind: 'deferred', untilEpochSeconds: 1_800_000_000 });
    expect(describeUpdateState(estadoCompleto(status))).toContain('pospuesta');
  });
});

/**
 * FASE 3.4 — regresión de C1 (contrato Rust ↔ TypeScript).
 *
 * Estos tests no inventan objetos: leen el MISMO fixture que usa la suite de
 * Rust (`fixtures/update-status-contract.json`) y lo pasan por el código de
 * producción. Antes ambas suites construían sus propios objetos, y por eso C1
 * pasó: Rust emitía `"idle"` y TypeScript esperaba `{kind:'idle'}`, sin que
 * ninguna comprobara la frontera entre las dos.
 */
describe('contrato de serializacion compartido con Rust', () => {
  const fixture = readFileSync(
    new URL('./fixtures/update-status-contract.json', import.meta.url),
    'utf8',
  );
  const contrato = JSON.parse(fixture) as {
    statusKind: { variant: string; json: string }[];
    statusEnvelope: { variant: string; json: Record<string, unknown> }[];
  };

  it('el fixture declara las nueve variantes que Rust puede emitir', () => {
    expect(contrato.statusKind.map((entrada) => entrada.variant)).toEqual([
      'Idle',
      'Checking',
      'UpToDate',
      'Available',
      'Downloading',
      'Ready',
      'PendingRestart',
      'Deferred',
      'Failed',
    ]);
    expect(UPDATE_STATUS_KINDS).toHaveLength(contrato.statusKind.length);
  });

  it('cada JSON del fixture se reconoce con el kind que declara', () => {
    for (const entrada of contrato.statusKind) {
      const parsed = JSON.parse(entrada.json) as { kind: string };
      expect(UPDATE_STATUS_KINDS).toContain(parsed.kind as (typeof UPDATE_STATUS_KINDS)[number]);
      // Y el normalizador de producción devuelve ese mismo kind, no otro.
      const normalizado = normalizeUpdateStatusKind(parsed);
      expect(normalizado.kind).toBe(parsed.kind);
    }
  });

  it('la forma que rompia la UI se rechaza en vez de aceptarse en silencio', () => {
    // Estas son las formas que Rust emitia con serde externo, la causa de C1.
    for (const formaRota of ['idle', 'available', 'upToDate', 'pendingRestart']) {
      const normalizado = normalizeUpdateStatusKind(formaRota);
      expect(normalizado.kind).toBe('failed');
      expect(isRetryableFailure((normalizado as { reason: string }).reason)).toBe(true);
    }
    const downloadingRoto = normalizeUpdateStatusKind({ downloading: { percent: 42 } });
    expect(downloadingRoto.kind).toBe('failed');
    expect(shouldOfferInstall(downloadingRoto)).toBe(false);
  });

  it('los sobres del fixture se normalizan con canal y version correctos', () => {
    for (const entrada of contrato.statusEnvelope) {
      const status = normalizeUpdateStatus(entrada.json);
      expect(status.channel).toBe(entrada.json['channel']);
      expect(status.installedVersion).toBe(entrada.json['installedVersion']);
      expect(status.status.kind).toBe((entrada.json['status'] as { kind: string }).kind);
    }
  });

  it('el sobre Available del fixture es el unico que ofrece instalar', () => {
    const disponible = normalizeUpdateStatus(
      contrato.statusEnvelope.find((entrada) => entrada.variant === 'Available')!.json,
    );
    expect(disponible.status.kind).toBe('available');
    expect(shouldOfferInstall(disponible.status)).toBe(true);
    expect(describeUpdateState(disponible)).toContain('1.4.1');
    expect(isStagingApp(disponible)).toBe(true);
  });

  it('el sobre Failed del fixture queda reintentable y sin instalar', () => {
    const fallido = normalizeUpdateStatus(
      contrato.statusEnvelope.find((entrada) => entrada.variant === 'Failed')!.json,
    );
    expect(fallido.status.kind).toBe('failed');
    expect(shouldOfferInstall(fallido.status)).toBe(false);
    const reason = (fallido.status as { reason: string }).reason;
    expect(isRetryableFailure(reason)).toBe(true);
  });

  it('comprobando se describe y no ofrece instalar', () => {
    const comprobando = normalizeUpdateStatus({ status: { kind: 'checking' } });
    expect(comprobando.status.kind).toBe('checking');
    expect(describeUpdateState(comprobando)).toContain('Comprobando');
    expect(shouldOfferInstall(comprobando.status)).toBe(false);
    expect(shouldNotifyUser(comprobando.status)).toBe(false);
  });

  it('entrada corrupta o incompleta no rompe la pantalla', () => {
    for (const basura of [undefined, null, 42, 'idle', [], {}, { status: 7 }]) {
      const status = normalizeUpdateStatus(basura);
      expect(status.channel).toBe('desconocido');
      expect(status.installedVersion).toBe('?');
      expect(status.status.kind).toBe('failed');
      expect(describeUpdateState(status)).toBeTruthy();
      expect(shouldOfferInstall(status.status)).toBe(false);
    }
  });

  it('un downloading sin porcentaje utilizable no inventa uno', () => {
    expect(normalizeUpdateStatusKind({ kind: 'downloading' })).toEqual({ kind: 'ready' });
    expect(normalizeUpdateStatusKind({ kind: 'downloading', percent: 'x' })).toEqual({ kind: 'ready' });
    expect(normalizeUpdateStatusKind({ kind: 'downloading', percent: 150 })).toEqual({
      kind: 'downloading',
      percent: 100,
    });
    expect(normalizeUpdateStatusKind({ kind: 'downloading', percent: 42 })).toEqual({
      kind: 'downloading',
      percent: 42,
    });
  });

  it('un deferred sin fecha no rompe y cae a idle', () => {
    expect(normalizeUpdateStatusKind({ kind: 'deferred' })).toEqual({ kind: 'idle' });
    expect(normalizeUpdateStatusKind({ kind: 'deferred', untilEpochSeconds: 1_800_000_000 })).toEqual({
      kind: 'deferred',
      untilEpochSeconds: 1_800_000_000,
    });
  });
});