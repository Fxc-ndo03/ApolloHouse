/**
 * Traduccion de los errores de TURNO que manda el Worker a una accion concreta.
 *
 * El Worker manda `code` + `message`. El `message` puede traer la clave interna
 * del limite (`requestsPerMinute`), que no le dice nada a la persona. Aqui se
 * convierte en una accion util sin inventar nada: solo se explica que paso y
 * que se puede hacer, y se conserva el codigo para diagnostico.
 */

export type TurnErrorCategory =
  | 'quota_per_minute'
  | 'quota_exhausted'
  | 'provider_allocation'
  | 'provider_unavailable'
  | 'not_authenticated'
  | 'not_authorized'
  | 'billing'
  | 'provider'
  | 'network'
  | 'unknown';

export interface TurnError {
  readonly category: TurnErrorCategory;
  readonly title: string;
  readonly detail: string;
  /** El transporte sigue vivo: un rechazo por cuota no corta la conexion. */
  readonly isConnectionFailure: boolean;
}

const CATEGORY_BY_CODE: Readonly<Record<string, TurnErrorCategory>> = {
  quota_exceeded: 'quota_exhausted',
  rate_limited: 'quota_per_minute',
  requests_per_minute: 'quota_per_minute',
  unauthorized: 'not_authenticated',
  not_authenticated: 'not_authenticated',
  forbidden: 'not_authorized',
  not_authorized: 'not_authorized',
  payment_required: 'billing',
  billing: 'billing',
  provider_unavailable: 'provider',
  provider_error: 'provider',
  network_error: 'network',
};

export function resolveTurnErrorCategory(code: string, message: string): TurnErrorCategory {
  const normalizedCode = code.trim().toLowerCase();
  const normalizedMessage = message.trim().toLowerCase();

  // El limite concreto viaja en el mensaje. Se mira PRIMERO porque `code` solo
  // dice "quota_exceeded" y no distingue "esperar un minuto" de "se agoto el mes".
  if (normalizedMessage.includes('requestsperminute') || normalizedMessage.includes('requests_per_minute')) {
    return 'quota_per_minute';
  }

  const directMatch = CATEGORY_BY_CODE[normalizedCode];
  if (directMatch !== undefined) return directMatch;

  if (normalizedMessage.includes('límite de uso alcanzado') || normalizedMessage.includes('limite de uso alcanzado')) {
    return 'quota_exhausted';
  }
  // FASE 3.22: la asignacion diaria del PROVEEDOR no es cuota de Apollo. El
  // mensaje real de Cloudflare no dice "quota": dice "4006 ... daily free
  // allocation ... neurons".
  if (
    normalizedMessage.includes('4006') ||
    normalizedMessage.includes('asignación diaria') ||
    normalizedMessage.includes('neurons') ||
    (normalizedMessage.includes('allocation') && normalizedMessage.includes('neurons'))
  ) {
    return 'provider_allocation';
  }
  if (
    normalizedMessage.includes('not available') ||
    normalizedMessage.includes('no such model') ||
    normalizedMessage.includes('model_not_found') ||
    normalizedMessage.includes('work ers_ai_llm_model') ||
    normalizedMessage.includes('workers_ai_llm_model')
  ) {
    return 'provider_unavailable';
  }
  if (normalizedMessage.includes('401') || normalizedMessage.includes('no autorizado')) return 'not_authenticated';
  if (normalizedMessage.includes('403') || normalizedMessage.includes('prohibido')) return 'not_authorized';
  if (normalizedMessage.includes('402') || normalizedMessage.includes('pago') || normalizedMessage.includes('billing')) {
    return 'billing';
  }
  return 'unknown';
}

export function describeTurnError(code: string, message: string): TurnError {
  // FASE 3.19: `rate_limited` ya no es una cuota de producto. El Worker lo
  // emite cuando la barrera antiinundacion frena trafico automatizado. Decir
  // "se alcanzó tu cuota" ahi seria falso: la cuenta no tiene tope de turnos.
  if (code.trim().toLowerCase() === 'rate_limited') {
    return {
      category: 'quota_per_minute',
      title: 'Esperá un momento',
      detail:
        'Demasiadas peticiones seguidas. Esperá un segundo y seguí; no se te terminó la cuota.',
      isConnectionFailure: false,
    };
  }
  const category = resolveTurnErrorCategory(code, message);
  switch (category) {
    case 'quota_per_minute':
      return {
        category,
        title: 'Esperá un momento',
        detail: 'Se alcanzó el máximo de turnos por minuto de este entorno. Esperá a que se libere el intervalo de 60 segundos y volvé a intentar.',
        isConnectionFailure: false,
      };
    case 'quota_exhausted':
      return {
        category,
        title: 'Límite de uso alcanzado',
        detail: 'Este entorno tiene un límite de consumo configurado y se agotó. No es un problema de tu conexión.',
        isConnectionFailure: false,
      };
    case 'not_authenticated':
      return {
        category,
        title: 'Sesión no válida',
        detail: 'Iniciá sesión de nuevo para seguir hablando.',
        isConnectionFailure: false,
      };
    case 'not_authorized':
      return {
        category,
        title: 'Sin permiso',
        detail: 'Esta cuenta no tiene permiso para esta acción.',
        isConnectionFailure: false,
      };
    case 'billing':
      return {
        category,
        title: 'Cuenta sin crédito',
        detail: 'El proveedor rechazó la petición por facturación.',
        isConnectionFailure: false,
      };
    case 'provider_allocation':
      return {
        category,
        title: 'Se agotó la cuota diaria del proveedor',
        detail:
          'Cloudflare Workers AI agotó su asignación diaria gratuita. Vuelve mañana o amplía el plan de Cloudflare. Tu cuota de Apollo no es el problema.',
        isConnectionFailure: false,
      };
    case 'provider_unavailable':
      return {
        category,
        title: 'El modelo de IA no está disponible',
        detail: 'Cloudflare no tiene disponible el modelo configurado. No es un problema de tu conexión.',
        isConnectionFailure: false,
      };
    case 'provider':
      return {
        category,
        title: 'El asistente no está disponible',
        detail: 'El proveedor de IA falló al responder. Podés reintentar.',
        isConnectionFailure: false,
      };
    case 'network':
      return {
        category,
        title: 'Sin conexión',
        detail: 'No se pudo contactar al servicio.',
        isConnectionFailure: true,
      };
    default:
      return {
        category: 'unknown',
        title: 'Algo salió mal',
        detail: message.trim().length > 0 ? message.trim() : 'El servicio devolvió un error sin detalle.',
        isConnectionFailure: false,
      };
  }
}
