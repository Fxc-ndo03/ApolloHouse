import { HEARTBEAT_INTERVAL_MILLISECONDS } from '@/devices/presence';

// Un solo timer de heartbeat en todo el proceso. La regla "no duplicar" y "no
// revivir tras stop" vive acá, no en el DO: se puede testear sin workerd.

export type HeartbeatTimerHandle = unknown;

export type HeartbeatTimerPort = {
  readonly setInterval: (
    callback: () => void,
    milliseconds: number,
  ) => HeartbeatTimerHandle;
  readonly clearInterval: (handle: HeartbeatTimerHandle) => void;
};

export const systemHeartbeatTimerPort: HeartbeatTimerPort = {
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (handle) => {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

export class HeartbeatScheduler {
  #handle: HeartbeatTimerHandle | null = null;
  readonly #intervalMilliseconds: number;

  constructor(intervalMilliseconds: number = HEARTBEAT_INTERVAL_MILLISECONDS) {
    this.#intervalMilliseconds = intervalMilliseconds;
  }

  get isRunning(): boolean {
    return this.#handle !== null;
  }

  // Devuelve false si ya había un heartbeat vivo: nunca se crea un segundo.
  start(port: HeartbeatTimerPort, beat: () => void): boolean {
    if (this.#handle !== null) {
      return false;
    }
    this.#handle = port.setInterval(beat, this.#intervalMilliseconds);
    return true;
  }

  // Devuelve false si no había nada que cortar. Tras un stop, un start nuevo
  // crea un único timer nuevo (reconnect), nunca revive el anterior.
  stop(port: HeartbeatTimerPort): boolean {
    if (this.#handle === null) {
      return false;
    }
    port.clearInterval(this.#handle);
    this.#handle = null;
    return true;
  }
}
