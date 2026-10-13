import { describe, expect, it } from 'bun:test';

import {
  APOLLO_ALARM_REGISTRATION_LIST,
  type ApolloAlarmScheduler,
  registerApolloAlarms,
} from '@/agents/alarms';

type ScheduledRow = {
  readonly callback: string;
  readonly key: string;
};

/**
 * Reproduce la semántica real de `agents@0.20.1`: `scheduleEvery` y
 * `schedule(cron)` deduplican por (callback, intervalo|cron). Leer el SDK, no
 * suponerlo: `_insertIntervalScheduleForOwner` usa `options?._idempotent !== false`
 * y el camino cron usa `options?.idempotent !== false`, o sea idempotentes por
 * defecto.
 */
function createIdempotentSchedulerFake(): {
  readonly scheduler: ApolloAlarmScheduler;
  readonly rowList: ScheduledRow[];
  readonly callList: string[];
} {
  const rowList: ScheduledRow[] = [];
  const callList: string[] = [];
  return {
    rowList,
    callList,
    scheduler: {
      async scheduleEvery(intervalSeconds: number, callback: string) {
        callList.push(`interval:${intervalSeconds}:${callback}`);
        const key = `interval:${intervalSeconds}:${callback}`;
        if (!rowList.some((row) => row.key === key)) {
          rowList.push({ callback, key });
        }
        return { id: key };
      },
      async schedule(when: string, callback: string) {
        callList.push(`cron:${when}:${callback}`);
        const key = `cron:${when}:${callback}`;
        if (!rowList.some((row) => row.key === key)) {
          rowList.push({ callback, key });
        }
        return { id: key };
      },
    },
  };
}

describe('registro de alarmas de Apollo (onStart)', () => {
  it('1. programa exactamente las cuatro alarmas y nada más', async () => {
    const fake = createIdempotentSchedulerFake();
    await registerApolloAlarms(fake.scheduler);

    expect(fake.rowList.map((row) => row.callback).sort()).toEqual([
      'consolidateOwnerMemory',
      'purgeExpiredCommandThreads',
      'refreshDashboardWeather',
      'warmupKeepAlive',
    ]);
  });

  it('2. conserva el propósito y la programación existentes', async () => {
    const fake = createIdempotentSchedulerFake();
    await registerApolloAlarms(fake.scheduler);

    expect(fake.callList).toEqual([
      'interval:1800:refreshDashboardWeather',
      'cron:0 6 * * *:consolidateOwnerMemory',
      'interval:86400:purgeExpiredCommandThreads',
      'interval:300:warmupKeepAlive',
    ]);
  });

  it('3. una nueva vida en memoria no duplica alarmas', async () => {
    const fake = createIdempotentSchedulerFake();
    await registerApolloAlarms(fake.scheduler);
    const afterFirstLife = fake.rowList.length;

    await registerApolloAlarms(fake.scheduler);
    await registerApolloAlarms(fake.scheduler);

    expect(fake.rowList.length).toBe(afterFirstLife);
    expect(fake.callList.length).toBe(APOLLO_ALARM_REGISTRATION_LIST.length * 3);
  });

  it('4. dos registros concurrentes no duplican una inicialización de una sola ejecución', async () => {
    const fake = createIdempotentSchedulerFake();
    await Promise.all([
      registerApolloAlarms(fake.scheduler),
      registerApolloAlarms(fake.scheduler),
      registerApolloAlarms(fake.scheduler),
    ]);

    expect(fake.rowList.length).toBe(APOLLO_ALARM_REGISTRATION_LIST.length);
  });

  it('5. un fallo al programar propaga el error en vez de tragárselo', async () => {
    const failingScheduler: ApolloAlarmScheduler = {
      async scheduleEvery() {
        throw new Error('alarm store unavailable');
      },
      async schedule() {
        return { id: 'nunca' };
      },
    };

    await expect(registerApolloAlarms(failingScheduler)).rejects.toThrow(
      'alarm store unavailable',
    );
  });

  it('6. no toca preferencias ni sesiones: sólo agenda alarmas', async () => {
    const fake = createIdempotentSchedulerFake();
    const touchedPropertyList: string[] = [];
    const schedulerWithTrap = new Proxy(fake.scheduler, {
      get(target, property: string) {
        touchedPropertyList.push(property);
        return target[property as keyof ApolloAlarmScheduler];
      },
    });

    await registerApolloAlarms(schedulerWithTrap);

    expect([...new Set(touchedPropertyList)].sort()).toEqual(['schedule', 'scheduleEvery']);
  });
});