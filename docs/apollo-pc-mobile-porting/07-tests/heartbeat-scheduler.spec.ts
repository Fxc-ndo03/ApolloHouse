import { describe, expect, it } from 'bun:test';

import {
  HeartbeatScheduler,
  type HeartbeatTimerHandle,
  type HeartbeatTimerPort,
} from '@/devices/heartbeat';
import { HEARTBEAT_INTERVAL_MILLISECONDS } from '@/devices/presence';

type RecordingTimerPort = HeartbeatTimerPort & {
  readonly startCount: number;
  readonly clearCount: number;
  readonly liveCount: number;
  readonly intervalList: readonly number[];
  readonly tick: () => void;
};

function buildRecordingTimerPort(): RecordingTimerPort {
  let startCount = 0;
  let clearCount = 0;
  let liveCount = 0;
  let beatCallback: (() => void) | null = null;
  const intervalList: number[] = [];
  return {
    get startCount() {
      return startCount;
    },
    get clearCount() {
      return clearCount;
    },
    get liveCount() {
      return liveCount;
    },
    get intervalList() {
      return intervalList;
    },
    tick() {
      beatCallback?.();
    },
    setInterval(callback: () => void, milliseconds: number): HeartbeatTimerHandle {
      startCount += 1;
      liveCount += 1;
      beatCallback = callback;
      intervalList.push(milliseconds);
      return startCount;
    },
    clearInterval(): void {
      clearCount += 1;
      liveCount -= 1;
      beatCallback = null;
    },
  };
}

describe('single heartbeat task', () => {
  it('uses the shared interval constant', () => {
    const timerPort = buildRecordingTimerPort();
    new HeartbeatScheduler().start(timerPort, () => {});
    expect(timerPort.intervalList).toEqual([HEARTBEAT_INTERVAL_MILLISECONDS]);
  });

  it('6. never starts a second heartbeat task', () => {
    const timerPort = buildRecordingTimerPort();
    const scheduler = new HeartbeatScheduler();
    expect(scheduler.start(timerPort, () => {})).toBe(true);
    expect(scheduler.start(timerPort, () => {})).toBe(false);
    expect(scheduler.start(timerPort, () => {})).toBe(false);
    expect(timerPort.startCount).toBe(1);
    expect(timerPort.liveCount).toBe(1);
    expect(scheduler.isRunning).toBe(true);
  });

  it('7. stop prevents any further heartbeat', () => {
    const timerPort = buildRecordingTimerPort();
    let beatCount = 0;
    const scheduler = new HeartbeatScheduler();
    scheduler.start(timerPort, () => {
      beatCount += 1;
    });
    timerPort.tick();
    expect(beatCount).toBe(1);

    expect(scheduler.stop(timerPort)).toBe(true);
    timerPort.tick();
    expect(beatCount).toBe(1);
    expect(scheduler.isRunning).toBe(false);
    // Un segundo stop no invoca al timer port otra vez.
    expect(scheduler.stop(timerPort)).toBe(false);
    expect(timerPort.clearCount).toBe(1);
    expect(timerPort.liveCount).toBe(0);
  });

  it('8. reconnect creates exactly one heartbeat task', () => {
    const timerPort = buildRecordingTimerPort();
    const scheduler = new HeartbeatScheduler();
    scheduler.start(timerPort, () => {});
    scheduler.stop(timerPort);
    expect(scheduler.start(timerPort, () => {})).toBe(true);
    expect(scheduler.start(timerPort, () => {})).toBe(false);
    expect(timerPort.startCount).toBe(2);
    expect(timerPort.clearCount).toBe(1);
    expect(timerPort.liveCount).toBe(1);
  });

  it('stays stopped when stop runs before any start', () => {
    const timerPort = buildRecordingTimerPort();
    const scheduler = new HeartbeatScheduler();
    expect(scheduler.stop(timerPort)).toBe(false);
    expect(timerPort.clearCount).toBe(0);
    expect(scheduler.isRunning).toBe(false);
  });

  it('a stopped scheduler can be restarted repeatedly without leaking timers', () => {
    const timerPort = buildRecordingTimerPort();
    const scheduler = new HeartbeatScheduler();
    for (let cycle = 0; cycle < 5; cycle += 1) {
      scheduler.start(timerPort, () => {});
      scheduler.stop(timerPort);
    }
    expect(timerPort.startCount).toBe(5);
    expect(timerPort.clearCount).toBe(5);
    expect(timerPort.liveCount).toBe(0);
  });
});
