import { listBuiltinToolDefinitionList } from '@/tools/catalog';

export type ToolDomainName =
  | 'pc'
  // BLOCK 11 §11: sin este dominio, una tool mobile era inalcanzable por el LLM
  // porque el filtro de dominio sólo conocía las tools de PC.
  | 'mobile'
  | 'memory'
  | 'weather'
  | 'scheduling'
  | 'research'
  | 'coding'
  | 'email'
  | 'general';

export type DomainConfidence = 'high' | 'medium' | 'low';

export type ToolDomainResolution = {
  readonly domain: ToolDomainName;
  readonly confidence: DomainConfidence;
  readonly score: number;
  readonly matchedKeywordList: readonly string[];
};

// Palabras clave por dominio (minúsculas, sin tildes: el texto se normaliza
// antes de matchear). Intencionalmente conservadoras: ante la duda el texto
// va a 'general' con catálogo completo (fallback seguro, nunca se bloquea).
const DOMAIN_KEYWORDS: Record<Exclude<ToolDomainName, 'general'>, readonly string[]> = {
  // Mención explícita de un teléfono. No incluye 'alarma' ni 'notificacion' a
  // propósito: esas palabras ya son de scheduling, y ambigüedad de dominio
  // significa catálogo completo, que es el fallback seguro.
  mobile: ['telefono', 'celular', 'movil', 'celu', 'mi fono'],
  pc: [
    'spotify',
    'musica',
    'cancion',
    'canciones',
    'volumen',
    'brillo',
    'pantalla',
    'computadora',
    'programa',
    'aplicacion',
    'abrir',
    'cerrar',
    'enfocar',
    'bloquear',
    'silenciar',
    'mutear',
    'auricular',
    'pausa',
    'pausar',
  ],
  memory: [
    'recorda',
    'acordate',
    'acordas',
    'recuerda',
    'recuerdas',
    'anota',
    'memoria',
    'olvidaste',
    'conversacion',
    'historial',
    'hablamos',
    'dijiste',
    'anotado',
  ],
  weather: [
    'clima',
    'tiempo',
    'temperatura',
    'lluvia',
    'llover',
    'llueve',
    'pronostico',
    'paraguas',
    'humedad',
    'viento',
    'weather',
  ],
  scheduling: [
    'recordatorio',
    'temporizador',
    'timer',
    'alarma',
    'cronometro',
    'avisame',
    'despertame',
    'lista',
    'listas',
    'pomodoro',
  ],
  research: [
    'busca',
    'buscar',
    'busqueda',
    'investiga',
    'investigar',
    'internet',
    'google',
    'noticias',
    'dolar',
    'cotizacion',
    'navegador',
    'brave',
    'averigua',
  ],
  coding: [
    'codigo',
    'repo',
    'repositorio',
    'github',
    'programar',
    'funcion',
    'script',
    'commit',
    'sandbox',
  ],
  email: ['email', 'mail', 'correo', 'gmail'],
};

// Patrón extra de scheduling: "en 5 minutos/horas" (pedido de timer).
const SCHEDULING_TIME_AMOUNT_PATTERN = /en\s+\d+\s+(minutos?|segundos?|horas?)/;

// Tools builtin por dominio (nombres exactos de catalog.ts; los catálogos
// pueden solaparse). Las tools MCP/dinámicas (nombres fuera de esta lista)
// se conservan SIEMPRE: son opt-in explícito del usuario.
const DOMAIN_TOOL_NAMES: Record<Exclude<ToolDomainName, 'general'>, readonly string[]> = {
  mobile: [
    'send_mobile_notification',
    'set_mobile_alarm',
    'cancel_mobile_alarm',
    'create_mobile_calendar_event',
    'cancel_mobile_calendar_event',
    'play_mobile_media',
    'pause_mobile_media',
    'next_mobile_media',
    'previous_mobile_media',
    'set_mobile_volume',
    'open_mobile_app',
  ],
  pc: [
    'open_pc_app',
    'focus_pc_app',
    'close_pc_app',
    'lock_pc_screen',
    'list_pc_apps',
    'spotify_play',
    'spotify_pause',
    'spotify_next',
    'spotify_previous',
    'spotify_get_state',
    'set_volume',
    'set_brightness',
    'device_status',
    'brave_search',
  ],
  memory: [
    'remember_fact',
    'recall_memory',
    'recall_conversation',
    'resume_conversation',
  ],
  weather: ['weather_now', 'set_weather_location'],
  scheduling: [
    'set_reminder',
    'list_reminders',
    'cancel_reminder',
    'set_timer',
    'set_alarm',
    'start_pomodoro',
    'add_to_list',
    'read_list',
    'remove_from_list',
  ],
  research: ['web_search', 'brave_search', 'start_research', 'dollar_rate'],
  coding: [
    'list_coding_repositories',
    'start_coding_task',
    'sandbox_run_code',
    'sandbox_exec',
  ],
  email: ['send_email'],
};

// Mini-catálogo transversal (todo 'safe'): se suma con confianza media como
// red de seguridad. Nunca sustituye al catálogo completo en confianza baja.
const CORE_TOOL_NAMES: readonly string[] = [
  'device_status',
  'recall_memory',
  'web_search',
];

let cachedBuiltinNameSet: ReadonlySet<string> | null = null;

export function builtinToolNameSet(): ReadonlySet<string> {
  if (cachedBuiltinNameSet === null) {
    cachedBuiltinNameSet = new Set(
      listBuiltinToolDefinitionList().map((toolDefinition) => toolDefinition.name),
    );
  }
  return cachedBuiltinNameSet;
}

export function normalizeDomainText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function matchesKeyword(normalizedText: string, keyword: string): boolean {
  const pattern = new RegExp(`\\b${keyword}\\b`);
  return pattern.test(normalizedText);
}

export function resolveToolDomain(userText: string): ToolDomainResolution {
  const normalizedText = normalizeDomainText(userText);
  let bestDomain: ToolDomainName = 'general';
  let bestScore = 0;
  let bestMatched: readonly string[] = [];
  let tied = false;
  const domainNameList = Object.keys(DOMAIN_KEYWORDS) as ToolDomainName[];
  for (const domainName of domainNameList) {
    if (domainName === 'general') {
      continue;
    }
    const matchedKeywordList = DOMAIN_KEYWORDS[domainName].filter((keyword) =>
      matchesKeyword(normalizedText, keyword),
    );
    let extraScore = 0;
    let extraMatched: string[] = [];
    if (
      domainName === 'scheduling' &&
      SCHEDULING_TIME_AMOUNT_PATTERN.test(normalizedText)
    ) {
      extraScore = 1;
      extraMatched = ['en-N-minutos'];
    }
    const score = matchedKeywordList.length + extraScore;
    if (score > bestScore) {
      bestScore = score;
      bestDomain = domainName;
      bestMatched = [...matchedKeywordList, ...extraMatched];
      tied = false;
    } else if (score === bestScore && score > 0) {
      tied = true;
    }
  }
  // Empate entre dominios = ambiguo por construccion: catalogo completo.
  if (tied) {
    return {
      domain: 'general',
      confidence: 'low',
      score: bestScore,
      matchedKeywordList: bestMatched,
    };
  }
  const confidence: DomainConfidence =
    bestScore >= 2 ? 'high' : bestScore === 1 ? 'medium' : 'low';
  return {
    domain: bestScore === 0 ? 'general' : bestDomain,
    confidence,
    score: bestScore,
    matchedKeywordList: bestMatched,
  };
}

export function buildExposedToolNameList(
  resolution: ToolDomainResolution,
): readonly string[] | null {
  if (resolution.confidence === 'low' || resolution.domain === 'general') {
    return null;
  }
  const domainToolNames = DOMAIN_TOOL_NAMES[resolution.domain] ?? [];
  if (resolution.confidence === 'high') {
    return domainToolNames;
  }
  const exposedNameSet = new Set<string>([...domainToolNames, ...CORE_TOOL_NAMES]);
  return [...exposedNameSet];
}

export function filterExposedToolDefinitions<T extends { readonly name: string }>(
  toolDefinitionList: readonly T[],
  exposedNameList: readonly string[] | null,
): readonly T[] {
  if (exposedNameList === null) {
    return toolDefinitionList;
  }
  const exposedNameSet = new Set(exposedNameList);
  const builtinNames = builtinToolNameSet();
  return toolDefinitionList.filter(
    (toolDefinition) =>
      exposedNameSet.has(toolDefinition.name) || !builtinNames.has(toolDefinition.name),
  );
}
