/**
 * FASE 2.7 — registro de conexiones cuya identidad ya fue verificada en
 * `onConnect`. Los tags asíncronos de `getConnectionTags` pueden llegar
 * después del primer mensaje; este registro evita descartar el turno inicial
 * de una conexión legítima.
 *
 * Invariante: una entrada sólo existe mientras la conexión sigue viva. El
 * cierre (`onClose`) la elimina, así que una reconexión pasa SIEMPRE por la
 * autenticación de nuevo — ni una credencial revocada ni una sesión muerta
 * recuperan acceso reutilizando una autorización previa.
 */
export type AuthorizedConnectionRegistry = {
  authorize(connectionId: string): void;
  isAuthorized(connectionId: string): boolean;
  revoke(connectionId: string): void;
  size(): number;
};

export function createAuthorizedConnectionRegistry(): AuthorizedConnectionRegistry {
  const authorizedConnectionIds = new Set<string>();
  return {
    authorize(connectionId: string) {
      authorizedConnectionIds.add(connectionId);
    },
    isAuthorized(connectionId: string): boolean {
      return authorizedConnectionIds.has(connectionId);
    },
    revoke(connectionId: string) {
      authorizedConnectionIds.delete(connectionId);
    },
    size(): number {
      return authorizedConnectionIds.size;
    },
  };
}
