/**
 * FASE 2.9 — registro de alarmas de Apollo.
 *
 * Se extrae del cuerpo de `onStart()` por una razón concreta: no se puede
 * testear que `onStart` no duplique alarmas si el registro está incrustado en
 * una clase que requiere workerd. La función sigue llamándose DESDE `onStart()`:
 * esto no mueve la inicialización a otro hook, sólo le da una costura testeable.
 *
 * Idempotencia: en `agents@0.20.1` tanto `scheduleEvery()` como `schedule()` con
 * expresión cron deduplican por defecto (`_idempotent !== false` /
 * `idempotent !== false`), así que un despertar nuevo no agrega filas repetidas.
 * Verificado leyendo el código fuente del SDK (index.js.map), no asumido.
 */

export const APOLLO_ALARM_REGISTRATION_LIST = [
  { kind: 'interval', intervalSeconds: 1800, callback: 'refreshDashboardWeather' },
  { kind: 'cron', when: '0 6 * * *', callback: 'consolidateOwnerMemory' },
  { kind: 'interval', intervalSeconds: 86_400, callback: 'purgeExpiredCommandThreads' },
  // Warmup: tocar storage cada 5 minutos para evitar hibernación.
  { kind: 'interval', intervalSeconds: 300, callback: 'warmupKeepAlive' },
] as const;

export type ApolloAlarmScheduler = {
  scheduleEvery(intervalSeconds: number, callback: string): Promise<unknown>;
  schedule(when: string, callback: string): Promise<unknown>;
};

export async function registerApolloAlarms(
  scheduler: ApolloAlarmScheduler,
): Promise<void> {
  for (const alarm of APOLLO_ALARM_REGISTRATION_LIST) {
    if (alarm.kind === 'interval') {
      await scheduler.scheduleEvery(alarm.intervalSeconds, alarm.callback);
      continue;
    }
    await scheduler.schedule(alarm.when, alarm.callback);
  }
}