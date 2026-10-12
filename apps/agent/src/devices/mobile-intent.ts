// Intenciones mobile del router determinista (BLOCK 11 §12).
//
// Los patterns viven acá, junto a los de PC: el bloque prohíbe duplicar regex
// entre archivos, así que `voice/router.ts` importa estas tablas y no las
// re-declara. La normalización de acentos, el anti-false-positive y el fast path
// son los mismos que ya usa PC.

/**
 * Sufijo que manda la intención al teléfono: "en el teléfono", "en el celular",
 * "en el móvil". El router lo detecta ANTES de probar los patterns de PC, porque
 * `OPEN_APP_PATTERN` se tragaría "spotify en el telefono" como un appName.
 */
export const MOBILE_TARGET_SUFFIX_PATTERN =
  /(?:\s+en\s+el\s+(?:telefono|celular|movil|celu))/i;

/** Menciones de un dispositivo mobile en cualquier posición del texto. */
export const MOBILE_MENTION_PATTERN = /\b(?:telefono|celular|movil|celu|mi\s+fono)\b/;

// "mandame/mandame una notificación al teléfono" y variantes.
export const MOBILE_NOTIFICATION_PATTERN =
  /^(?:mandame|mandame\s+una|mandar|enviame|enviar|avisame|avisar|notificame)\s+(?:una\s+|un\s+)?(?:notificacion|aviso|alerta|recordatorio)\b/i;

// "poné una alarma a las 7 en el teléfono" -> el texto completo lo captura el
// patrón; acá sólo se reconoce que HAY una intención de alarma mobile.
export const MOBILE_ALARM_PATTERN = /\b(?:alarma|despertarme|despiertame|despierta)\b/i;

export const MOBILE_CALENDAR_PATTERN = /\b(?:calendario|agendar|agenda|evento|cita)\b/i;

export const MOBILE_MEDIA_PATTERN =
  /\b(?:musica|cancion|cancion|pista|video|reproductor|spotify)\b/i;

export const MOBILE_VOLUME_PATTERN =
  /\b(?:volumen|silenciar|silencio|mutea|mutear|subir\s+el\s+volumen|bajar\s+el\s+volumen)\b/i;

// Un pedido de app que además menciona un teléfono: "abrí whatsapp en el
// celular". El nombre de la app se captura aparte con el grupo del patrón.
export const MOBILE_OPEN_APP_PATTERN =
  /^(?:abri|abre|abrí|abré|abrir|lanzar|lanzá|iniciar|inicia)\s+(?:la\s+|el\s+|las\s+|los\s+|un\s+|una\s+)?(.+?)\s+en\s+el\s+(?:telefono|celular|movil|celu)$/i;
