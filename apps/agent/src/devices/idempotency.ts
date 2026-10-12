import type { DeviceCommandOutcome } from '@/devices/dispatch';

// Idempotencia por deviceId + requestId con TTL acotado (BLOCK 11 §6).
//
// Semántica EXACTA, que es lo que el bloque pide documentar:
//
//   1. primera request           -> se ejecuta una vez
//   2. duplicada en vuelo        -> `duplicate_request_id` (no se ejecuta dos veces)
//   3. duplicada poco después de completarse -> se REPRODUCE el mismo resultado
//      que ya se devolvió, sin volver a ejecutar el efecto en el device
//   4. duplicada pasado el TTL   -> se vuelve a ejecutar (el resultado cacheado
//      ya no se considera vigente)
//
// El TTL existe para que un requestId no reutilizado para siempre devuelva un
// resultado viejo. El límite de entradas evita que la memoria del bridge crezca
// sin techo cuando muchos comandos distintos pasan por el mismo DO.

export const DEFAULT_COMPLETED_COMMAND_TTL_MILLISECONDS = 5 * 60_000;

export const DEFAULT_COMPLETED_COMMAND_MAX_ENTRY_COUNT = 256;

type CompletedCommandEntry = {
  readonly completedAtMilliseconds: number;
  readonly outcome: DeviceCommandOutcome;
};

export type CompletedCommandRegistryOptions = {
  readonly nowMilliseconds?: () => number;
  readonly ttlMilliseconds?: number;
  readonly maxEntryCount?: number;
};

/** Clave de deduplicación: el device Y el request, nunca el request solo. */
export function buildCompletedCommandKey(deviceId: string, requestId: string): string {
  return `${deviceId}:${requestId}`;
}

export class CompletedCommandRegistry {
  readonly #entryMap = new Map<string, CompletedCommandEntry>();
  readonly #nowMilliseconds: () => number;
  readonly #ttlMilliseconds: number;
  readonly #maxEntryCount: number;

  constructor(options: CompletedCommandRegistryOptions = {}) {
    this.#nowMilliseconds = options.nowMilliseconds ?? (() => Date.now());
    this.#ttlMilliseconds =
      options.ttlMilliseconds ?? DEFAULT_COMPLETED_COMMAND_TTL_MILLISECONDS;
    this.#maxEntryCount =
      options.maxEntryCount ?? DEFAULT_COMPLETED_COMMAND_MAX_ENTRY_COUNT;
  }

  get entryCount(): number {
    this.#pruneExpired();
    return this.#entryMap.size;
  }

  /** Resultado cacheado de un request ya completado y todavía vigente. */
  readOutcome(deviceId: string, requestId: string): DeviceCommandOutcome | null {
    const key = buildCompletedCommandKey(deviceId, requestId);
    const entry = this.#entryMap.get(key);
    if (entry === undefined) {
      return null;
    }
    if (this.#isExpired(entry)) {
      this.#entryMap.delete(key);
      return null;
    }
    return entry.outcome;
  }

  record(deviceId: string, requestId: string, outcome: DeviceCommandOutcome): void {
    this.#pruneExpired();
    this.#entryMap.set(buildCompletedCommandKey(deviceId, requestId), {
      completedAtMilliseconds: this.#nowMilliseconds(),
      outcome,
    });
    // Evicta la entrada más vieja si se pasó el tope. El orden de inserción de
    // un Map es el orden de escritura, así que la primera key es la más vieja.
    while (this.#entryMap.size > this.#maxEntryCount) {
      const oldestKey = this.#entryMap.keys().next();
      if (oldestKey.done === true) {
        break;
      }
      this.#entryMap.delete(oldestKey.value);
    }
  }

  #isExpired(entry: CompletedCommandEntry): boolean {
    return (
      this.#nowMilliseconds() - entry.completedAtMilliseconds >= this.#ttlMilliseconds
    );
  }

  #pruneExpired(): void {
    for (const [key, entry] of this.#entryMap) {
      if (this.#isExpired(entry)) {
        this.#entryMap.delete(key);
      }
    }
  }
}
