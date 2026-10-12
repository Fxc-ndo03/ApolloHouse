import {
  MOBILE_ALARM_PATTERN,
  MOBILE_CALENDAR_PATTERN,
  MOBILE_MEDIA_PATTERN,
  MOBILE_NOTIFICATION_PATTERN,
  MOBILE_OPEN_APP_PATTERN,
  MOBILE_TARGET_SUFFIX_PATTERN,
  MOBILE_VOLUME_PATTERN,
} from '@/devices/mobile-intent';

export type RouterOutcome =
  | {
      readonly kind: 'pc_command';
      readonly commandType: string;
      readonly args: Record<string, string>;
      readonly responseText: string;
    }
  | {
      readonly kind: 'time_answer';
      readonly responseText: string;
    }
  | {
      readonly kind: 'date_answer';
      readonly responseText: string;
    }
  | {
      readonly kind: 'memory_write';
      readonly fact: string;
      readonly responseText: string;
    }
  | {
      readonly kind: 'ai_needed';
      readonly normalizedText: string;
    }
  // BLOCK 11 §12: intención mobile explícita. El shape es el mismo que
  // `pc_command` a propósito: `devices/intent.ts` traduce las dos familias
  // y el pipeline es uno solo.
  | {
      readonly kind: 'mobile_command';
      readonly commandType: string;
      readonly args: Record<string, string>;
      readonly responseText: string;
    };

const OPEN_APP_PATTERN =
  /^(?:abri|abre|abrí|abré|abrir|lanza|lanzar|inicia|iniciar|ejecuta|ejecutar|start|open|launch)\s+(?:la\s+|el\s+|las\s+|los\s+|un\s+|una\s+)?(.+?)(?:\s+en\s+pc)?$/i;

const CLOSE_APP_PATTERN =
  /^(?:cierra|cerrar|cerra|close|kill|termina|terminar|finaliza|finalizar)\s+(?:la\s+|el\s+|las\s+|los\s+|un\s+|una\s+)?(.+?)(?:\s+en\s+pc)?$/i;

const FOCUS_APP_PATTERN =
  /^(?:enfoca|enfocar|focus|trae|traer|poner|pone|maximiza|maximizar)\s+(?:la\s+|el\s+|las\s+|los\s+|un\s+|una\s+)?(.+?)(?:\s+en\s+pc)?$/i;

const LOCK_SCREEN_PATTERN =
  /^(?:bloquea|bloquear|lock|block|bloqueá|bloqueé)\s*(?:la\s+)?(?:pantalla|screen|pc|computadora|equipo)?$/i;

const SPOTIFY_PLAY_PATTERN =
  /^(?:reproduce|reproducir|play|poner|pone|poné|dale|playear)\s*(?:spotify|musica|música|cancion|canción|albúm)?(?:\s+en\s+spotify)?$/i;

const SPOTIFY_PAUSE_PATTERN =
  /^(?:(?:pon|poné|poner|pone)\s+)?(?:pausa|pausar|pause|para|parar|detener|detén|detene)\s*(?:spotify|musica|música|cancion|canción)?$/i;

const SPOTIFY_NEXT_PATTERN =
  /^(?:siguiente|next|pista\s+siguiente|cancion\s+siguiente|pásale|pasale)\s*(?:cancion|canción|pista)?$/i;

const SPOTIFY_PREVIOUS_PATTERN =
  /^(?:anterior|previous|pista\s+anterior|cancion\s+anterior|vuelve|volver)\s*(?:cancion|canción|pista)?$/i;

const TIME_PATTERN =
  /^(?:que\s+hora|hora\s+(?:es|hay)|hora\s+actual|hora\s+actual|horas?\s+son|que\s+hora\s+es|decime\s+la\s+hora|dime\s+la\s+hora|cuantos?\s+hora|cuántos?\s+hora)/i;

const DATE_PATTERN =
  /^(?:que\s+dia|dia\s+(?:es|hay)|dia\s+actual|fecha\s+(?:es|hay)|fecha\s+actual|que\s+fecha|decime\s+la\s+fecha|dime\s+la\s+fecha|que\s+dia\s+hoy|hoy\s+que\s+dia)/i;

// Escritura explicita de memoria: verbo al inicio + "que" + hecho.
// Intencionalmente estricto (sin "que" no hay match): "guarda el archivo"
// o "anota leche" son ambiguos y van al LLM. "te acordas que...?" empieza
// con "te", asi que las preguntas no matchean.
const MEMORY_WRITE_PATTERN =
  /^(?:recorda|recordá|acordate|acordáte|recuerda|anota|anotá|guarda|guardá)(?:\s+de)?\s+que\s+(.+?)\s*$/i;

function cleanAppName(raw: string): string {
  return raw
    .replace(/\s+en\s+pc$/i, '')
    .replace(/^(la|el|las|los|un|una)\s+/i, '')
    .replace(/\s+\.exe$/i, '')
    .trim()
    .toLowerCase();
}

// Normaliza minusculas + sin tildes conservando el mapa de indices al texto
// original: los patterns del router son ASCII (el STT emite sin tildes y los
// tests pinean ese comportamiento), pero el chat tipeado SI trae tildes.
// Sin esto, "qué hora es" o "cerrá chrome" caian a ai_needed. El mapa permite
// extraer appName/fact del ORIGINAL (con tildes intactas).
function normalizeWithIndexMap(text: string): { normalized: string; indexMap: number[] } {
  const loweredText = text.toLowerCase();
  let normalized = '';
  const indexMap: number[] = [];
  for (let originalIndex = 0; originalIndex < loweredText.length; originalIndex += 1) {
    const stripped = loweredText[originalIndex]
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    for (let k = 0; k < stripped.length; k += 1) {
      normalized += stripped[k];
      indexMap.push(originalIndex);
    }
  }
  return { normalized, indexMap };
}

function sliceOriginal(
  trimmedText: string,
  indexMap: number[],
  start: number,
  end: number,
): string {
  if (start < 0 || end <= start || start >= indexMap.length) {
    return '';
  }
  const clampedEnd = Math.min(end, indexMap.length);
  return trimmedText.slice(indexMap[start], indexMap[clampedEnd - 1] + 1);
}

// Un appName con expresion de tiempo ("spotify en 5 minutos") no es una app:
// es un pedido diferido/ambiguo que debe resolver el LLM, no abrir ahora.
const TIME_AMOUNT_INFIX_PATTERN = /\b(?:en|de)\s+\d+\s*(?:minutos?|segundos?|horas?)\b/;

// "poner/poné" es ambiguo: puede ser focus ("poné chrome al frente") o una
// intencion de media ("poné pausa", "poné música"). Si el appName capturado
// parece un temporizador o un comando de media, no es una app: al LLM.
const NON_APP_CAPTURE_PATTERN =
  /\b(?:minutos?|segundos?|horas?|pausa|pausar|musica|cancion|spotify|volumen|brillo|recordatorio|alarma|temporizador)\b/;

// "poné una alarma" sin decir dónde es Desktop (set_alarm cloud) o el LLM.
// Sólo se vuelve intención mobile cuando el texto además menciona un
// teléfono: es el mismo criterio anti-false-positive que usa PC.
const MOBILE_MENTION_HINT = /\b(?:telefono|celular|movil|celu|mi\s+fono)\b/;

// "qué hora es en Tokio": la respuesta fija es Buenos Aires, asi que otro lugar
// es ambigüedad y corresponde al LLM.
const FOREIGN_PLACE_SUFFIX_PATTERN = /\ben\s+[a-z]{3,}\s*$/;

function formatTimeInBuenosAires(now: Date): string {
  const timeString = now.toLocaleTimeString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `Son las ${timeString}.`;
}

function formatDateInBuenosAires(now: Date): string {
  const dateString = now.toLocaleDateString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  return `Hoy es ${dateString}.`;
}

export function routeDeterministic(
  userText: string,
  now: Date = new Date(),
): RouterOutcome {
  const trimmed = userText.trim();
  const { normalized: normalizedText, indexMap } = normalizeWithIndexMap(trimmed);

  const memoryMatch = normalizedText.match(MEMORY_WRITE_PATTERN);
  if (memoryMatch !== null && memoryMatch.index !== undefined) {
    const fact = sliceOriginal(
      trimmed,
      indexMap,
      memoryMatch.index + memoryMatch[0].lastIndexOf(memoryMatch[1]),
      memoryMatch.index +
        memoryMatch[0].lastIndexOf(memoryMatch[1]) +
        memoryMatch[1].length,
    ).trim();
    if (fact.length >= 3) {
      return {
        kind: 'memory_write',
        fact,
        responseText: `Anotado: ${fact}.`,
      };
    }
  }

  // BLOCK 11 §12: primero mobile, antes de que un patrón de PC se trague el
  // sufijo "en el teléfono". Un intent mobile NUNCA cae a un intent desktop.
  const mobileOutcome = routeMobileIntent(normalizedText, trimmed);
  if (mobileOutcome !== null) {
    return mobileOutcome;
  }

  const openMatch = normalizedText.match(OPEN_APP_PATTERN);
  if (openMatch !== null && openMatch.index !== undefined && openMatch[1] !== undefined) {
    const rawAppName = sliceOriginal(
      trimmed,
      indexMap,
      openMatch.index + openMatch[0].lastIndexOf(openMatch[1]),
      openMatch.index + openMatch[0].lastIndexOf(openMatch[1]) + openMatch[1].length,
    );
    if (TIME_AMOUNT_INFIX_PATTERN.test(rawAppName)) {
      return aiNeeded(trimmed);
    }
    const appName = cleanAppName(rawAppName);

    return {
      kind: 'pc_command',
      commandType: 'apps_open',
      args: { appName },
      responseText: `Abriendo ${appName}.`,
    };
  }

  const closeMatch = normalizedText.match(CLOSE_APP_PATTERN);
  if (
    closeMatch !== null &&
    closeMatch.index !== undefined &&
    closeMatch[1] !== undefined
  ) {
    const rawAppName = sliceOriginal(
      trimmed,
      indexMap,
      closeMatch.index + closeMatch[0].lastIndexOf(closeMatch[1]),
      closeMatch.index + closeMatch[0].lastIndexOf(closeMatch[1]) + closeMatch[1].length,
    );
    if (TIME_AMOUNT_INFIX_PATTERN.test(rawAppName)) {
      return aiNeeded(trimmed);
    }
    const appName = cleanAppName(rawAppName);

    return {
      kind: 'pc_command',
      commandType: 'apps_close',
      args: { appName },
      responseText: `Cerrando ${appName}.`,
    };
  }

  const focusMatch = normalizedText.match(FOCUS_APP_PATTERN);
  if (
    focusMatch !== null &&
    focusMatch.index !== undefined &&
    focusMatch[1] !== undefined &&
    !NON_APP_CAPTURE_PATTERN.test(normalizedText.slice(focusMatch.index))
  ) {
    const rawAppName = sliceOriginal(
      trimmed,
      indexMap,
      focusMatch.index + focusMatch[0].lastIndexOf(focusMatch[1]),
      focusMatch.index + focusMatch[0].lastIndexOf(focusMatch[1]) + focusMatch[1].length,
    );
    if (TIME_AMOUNT_INFIX_PATTERN.test(rawAppName)) {
      return aiNeeded(trimmed);
    }
    const appName = cleanAppName(rawAppName);

    return {
      kind: 'pc_command',
      commandType: 'apps_focus',
      args: { appName },
      responseText: `Enfocando ${appName}.`,
    };
  }

  if (LOCK_SCREEN_PATTERN.test(normalizedText)) {
    return {
      kind: 'pc_command',
      commandType: 'lock_screen',
      args: {},
      responseText: 'Bloqueando la pantalla.',
    };
  }

  if (SPOTIFY_PLAY_PATTERN.test(normalizedText)) {
    return {
      kind: 'pc_command',
      commandType: 'spotify_play',
      args: {},
      responseText: 'Reproduciendo música.',
    };
  }

  if (SPOTIFY_PAUSE_PATTERN.test(normalizedText)) {
    return {
      kind: 'pc_command',
      commandType: 'spotify_pause',
      args: {},
      responseText: 'Pausando música.',
    };
  }

  if (SPOTIFY_NEXT_PATTERN.test(normalizedText)) {
    return {
      kind: 'pc_command',
      commandType: 'spotify_next',
      args: {},
      responseText: 'Siguiente pista.',
    };
  }

  if (SPOTIFY_PREVIOUS_PATTERN.test(normalizedText)) {
    return {
      kind: 'pc_command',
      commandType: 'spotify_previous',
      args: {},
      responseText: 'Pista anterior.',
    };
  }

  if (TIME_PATTERN.test(normalizedText)) {
    if (FOREIGN_PLACE_SUFFIX_PATTERN.test(normalizedText)) {
      return aiNeeded(trimmed);
    }

    return {
      kind: 'time_answer',
      responseText: formatTimeInBuenosAires(now),
    };
  }

  if (DATE_PATTERN.test(normalizedText)) {
    if (FOREIGN_PLACE_SUFFIX_PATTERN.test(normalizedText)) {
      return aiNeeded(trimmed);
    }

    return {
      kind: 'date_answer',
      responseText: formatDateInBuenosAires(now),
    };
  }

  return {
    kind: 'ai_needed',
    normalizedText: trimmed,
  };
}

function aiNeeded(trimmed: string): RouterOutcome {
  return {
    kind: 'ai_needed',
    normalizedText: trimmed,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Intenciones mobile (BLOCK 11 §12).
//
// La capability la implementa el catálogo, no el router: este decide la
// INTENCIÓN y `devices/intent.ts` la traduce a capability + target.
// ───────────────────────────────────────────────────────────────────────────
function routeMobileIntent(
  normalizedText: string,
  trimmed: string,
): RouterOutcome | null {
  const openAppMatch = normalizedText.match(MOBILE_OPEN_APP_PATTERN);
  if (openAppMatch !== null) {
    const appName = (openAppMatch[1] ?? '').trim().toLowerCase();
    if (appName.length < 2) {
      return aiNeeded(trimmed);
    }
    return {
      kind: 'mobile_command',
      commandType: 'app_open',
      args: { appName },
      responseText: `Abriendo ${appName} en el teléfono.`,
    };
  }

  if (MOBILE_TARGET_SUFFIX_PATTERN.test(normalizedText)) {
    // "poné música en el teléfono" / "subí el volumen en el celular".
    if (MOBILE_MEDIA_PATTERN.test(normalizedText)) {
      return {
        kind: 'mobile_command',
        commandType: 'media_play',
        args: {},
        responseText: 'Reproduciendo en el teléfono.',
      };
    }
    if (MOBILE_VOLUME_PATTERN.test(normalizedText)) {
      return {
        kind: 'mobile_command',
        commandType: 'volume_set',
        args: {},
        responseText: 'Ajustando el volumen del teléfono.',
      };
    }
    if (MOBILE_ALARM_PATTERN.test(normalizedText)) {
      return {
        kind: 'mobile_command',
        commandType: 'alarm_set',
        args: {},
        responseText: 'Programando la alarma en el teléfono.',
      };
    }
    if (MOBILE_CALENDAR_PATTERN.test(normalizedText)) {
      return {
        kind: 'mobile_command',
        commandType: 'calendar_create',
        args: {},
        responseText: 'Anotando en el calendario del teléfono.',
      };
    }
    // Sufijo de teléfono con algo que no sabemos hacer: al LLM, nunca a PC.
    return aiNeeded(trimmed);
  }

  if (MOBILE_NOTIFICATION_PATTERN.test(normalizedText)) {
    return {
      kind: 'mobile_command',
      commandType: 'notification_post',
      args: {},
      responseText: 'Mandando la notificación.',
    };
  }

  if (
    MOBILE_ALARM_PATTERN.test(normalizedText) &&
    MOBILE_MENTION_HINT.test(normalizedText)
  ) {
    return {
      kind: 'mobile_command',
      commandType: 'alarm_set',
      args: {},
      responseText: 'Programando la alarma en el teléfono.',
    };
  }

  if (
    MOBILE_CALENDAR_PATTERN.test(normalizedText) &&
    MOBILE_MENTION_HINT.test(normalizedText)
  ) {
    return {
      kind: 'mobile_command',
      commandType: 'calendar_create',
      args: {},
      responseText: 'Anotando en el calendario del teléfono.',
    };
  }

  return null;
}
