import { z } from 'zod';

import type { DeviceType } from '@/devices/identity';

// ─────────────────────────────────────────────────────────────────────────────
// Contrato de capacidades.
//
// Una capability es un NOMBRE de contrato, no un permiso y no un comando. El
// catálogo dice qué existe, qué está implementado de verdad y qué comando
// existente lo satisface hoy. Lo que no tiene comando se declara 'unimplemented'
// para que ningún dispositivo pueda anunciarlo como disponible.
// ─────────────────────────────────────────────────────────────────────────────

export const DESKTOP_CAPABILITY_NAME_LIST = [
  'desktop.open_app',
  'desktop.focus_app',
  'desktop.close_app',
  'desktop.list_apps',
  'desktop.lock',
  'desktop.spotify',
  'desktop.brave_search',
  // Declaradas como contrato para futuros comandos de Windows. Hoy el Worker no
  // tiene ningún comando que las satisfaga (set_volume/set_brightness van al
  // device por self.audio_speaker.*, no a la PC), asi que quedan unimplemented.
  'desktop.volume',
  'desktop.brightness',
  'desktop.notifications',
  'desktop.files',
  'desktop.system_status',
] as const;

// Contrato mobile. mobile.notifications está implementada (BLOCK 9); el resto se
// declara para que el modelo sea exhaustivo y sigue unimplemented.
export const MOBILE_CAPABILITY_NAME_LIST = [
  'mobile.open_app',
  'mobile.notifications',
  'mobile.alarm',
  'mobile.calendar',
  'mobile.media',
  'mobile.volume',
] as const;

export type DesktopCapabilityName = (typeof DESKTOP_CAPABILITY_NAME_LIST)[number];
export type MobileCapabilityName = (typeof MOBILE_CAPABILITY_NAME_LIST)[number];

export const CAPABILITY_NAME_LIST = [
  ...DESKTOP_CAPABILITY_NAME_LIST,
  ...MOBILE_CAPABILITY_NAME_LIST,
] as const;

export type CapabilityName = (typeof CAPABILITY_NAME_LIST)[number];

// Comandos reales del protocoloPc -> PcBridge (ver src/protocol/schema.ts). Los
// de transporte/UI (ping, tts_*, turn_end, play_effect, confirm_request) NO son
// capabilities: no ejecutan nada del lado del usuario.
export const PC_BRIDGE_COMMAND_NAME_LIST = [
  'apps_open',
  'apps_focus',
  'apps_close',
  'apps_list',
  'lock_screen',
  'spotify_play',
  'spotify_pause',
  'spotify_next',
  'spotify_previous',
  'spotify_get_state',
] as const;

export type PcBridgeCommandName = (typeof PC_BRIDGE_COMMAND_NAME_LIST)[number];

// Comandos del lado mobile. El bridge mobile no usa nombres de comando como
// PcBridge: el wire lleva la capability y el peer decide. El nombre existe para
// que el contrato sea explícito y testeable, no para abrir un dispatcher.
// Comandos que el peer mobile ejecuta de verdad. El catálogo es el único lugar
// que declara qué comando existe: no se puede dispatchear un nombre que no esté
// acá (BLOCK 11 §4 y §16).
export const MOBILE_COMMAND_NAME_LIST = [
  'notification_post',
  'alarm_set',
  'alarm_cancel',
  'calendar_create',
  'calendar_list',
  'calendar_cancel',
  'media_play',
  'media_pause',
  'media_next',
  'media_previous',
  'volume_set',
  'volume_get',
  'app_open',
] as const;

export type MobileCommandName = (typeof MOBILE_COMMAND_NAME_LIST)[number];

// Nombre de comando agnóstico al transporte: el catálogo sigue siendo el único
// lugar que dice qué comando satisface qué capability.
export type DeviceCommandName = PcBridgeCommandName | MobileCommandName;

export type CapabilityImplementationStatus = 'implemented' | 'unimplemented';

// BLOCK 11 §9: si una operación tiene sentido cuando el device está offline.
// `false` significa realtime only: sin device conectado no hay nada que hacer y
// la operación falla en vez de encolarse. Es una DECLARACIÓN, no una cola: el
// bloque no implementa cola offline genérica porque su semántica no está definida.
export type CapabilityQueueability = 'queueable' | 'realtime_only';

export type CapabilityContract = {
  readonly name: CapabilityName;
  readonly status: CapabilityImplementationStatus;
  // A qué tipo de device pertenece. Es lo que hace derivable el target
  // preference (sin heurísticas de prefijo).
  readonly deviceType: DeviceType;
  // Comando existente que la satisface hoy, si alguno.
  readonly commandList: readonly DeviceCommandName[];
  // Si la operación sobrevive a un device offline (BLOCK 11 §9).
  readonly queueability: CapabilityQueueability;
};

// Las capacidades desktop son realtime only: la PC está donde está la sesión.
// Una alarma o una notificación sobreviven porque el teléfono las persiste y las
// dispara aunque Apollo no esté; abrir una app no sobrevive porque necesita un
// device vivo en el momento.
const CAPABILITY_QUEUEABILITY_MAP: ReadonlyMap<CapabilityName, CapabilityQueueability> =
  new Map([
    ['mobile.notifications', 'queueable'],
    ['mobile.alarm', 'queueable'],
    ['mobile.calendar', 'queueable'],
    ['mobile.media', 'realtime_only'],
    ['mobile.volume', 'realtime_only'],
    ['mobile.open_app', 'realtime_only'],
  ]);

function describeQueueability(capabilityName: CapabilityName): CapabilityQueueability {
  return CAPABILITY_QUEUEABILITY_MAP.get(capabilityName) ?? 'realtime_only';
}

function buildCapabilityContractMap(): ReadonlyMap<CapabilityName, CapabilityContract> {
  const contractMap = new Map<CapabilityName, CapabilityContract>();
  for (const name of CAPABILITY_NAME_LIST) {
    contractMap.set(name, {
      name,
      status: 'unimplemented',
      deviceType: name.startsWith('mobile.') ? 'mobile' : 'desktop',
      commandList: [],
      queueability: describeQueueability(name),
    });
  }
  const implementedContractMap: ReadonlyMap<
    CapabilityName,
    readonly DeviceCommandName[]
  > = new Map([
    ['desktop.open_app', ['apps_open']],
    ['desktop.focus_app', ['apps_focus']],
    ['desktop.close_app', ['apps_close']],
    ['desktop.list_apps', ['apps_list']],
    ['desktop.lock', ['lock_screen']],
    [
      'desktop.spotify',
      [
        'spotify_play',
        'spotify_pause',
        'spotify_next',
        'spotify_previous',
        'spotify_get_state',
      ],
    ],
    // Abre una URL en el navegador del desktop reusando apps_open, que ya
    // acepta argumentos: mismo comando, otro uso.
    ['desktop.brave_search', ['apps_open']],
    // BLOCK 9: la primera capability mobile real. El peer recibe el envelope de
    // comando y postea la notificación; el resto sigue unimplemented.
    ['mobile.notifications', ['notification_post']],
    // BLOCK 11: las capabilities mobile restantes pasan a implemented SOLO porque
    // el comando existe de punta a punta (catálogo + bridge + peer). Si el peer
    // no implementa el comando, la capability queda unimplemented y el bridge
    // la rechaza antes de tocar el socket.
    ['mobile.alarm', ['alarm_set', 'alarm_cancel']],
    ['mobile.calendar', ['calendar_create', 'calendar_list', 'calendar_cancel']],
    ['mobile.media', ['media_play', 'media_pause', 'media_next', 'media_previous']],
    ['mobile.volume', ['volume_set', 'volume_get']],
    ['mobile.open_app', ['app_open']],
  ]);
  for (const [name, commandList] of implementedContractMap) {
    const existingContract = contractMap.get(name);
    contractMap.set(name, {
      name,
      status: 'implemented',
      deviceType: existingContract?.deviceType ?? 'desktop',
      commandList,
      queueability: describeQueueability(name),
    });
  }
  return contractMap;
}

const capabilityContractMap = buildCapabilityContractMap();

export function describeCapability(capabilityName: CapabilityName): CapabilityContract {
  const contract = capabilityContractMap.get(capabilityName);
  if (contract === undefined) {
    throw new Error(`Capability fuera de catálogo: ${capabilityName}`);
  }
  return contract;
}

export function listCapabilityContractList(): readonly CapabilityContract[] {
  return CAPABILITY_NAME_LIST.map((name) => describeCapability(name));
}

export function listImplementedCapabilityNameList(): readonly CapabilityName[] {
  return listCapabilityContractList()
    .filter((contract) => contract.status === 'implemented')
    .map((contract) => contract.name);
}

export function isImplementedCapability(capabilityName: CapabilityName): boolean {
  return describeCapability(capabilityName).status === 'implemented';
}

export function describeCapabilityDeviceType(capabilityName: CapabilityName): DeviceType {
  return describeCapability(capabilityName).deviceType;
}

export function listCapabilityNameForDeviceType(
  deviceType: DeviceType,
): readonly CapabilityName[] {
  return listCapabilityContractList()
    .filter((contract) => contract.deviceType === deviceType)
    .map((contract) => contract.name);
}

// Ningún comandoPcBridge puede satisfacer una capability mobile: el bridge es
// del desktop por definición.
export function isPcBridgeBackedCapability(capabilityName: CapabilityName): boolean {
  return describeCapability(capabilityName).deviceType === 'desktop';
}

export const capabilityNameSchema = z.enum(CAPABILITY_NAME_LIST);
export const pcBridgeCommandNameSchema = z.enum(PC_BRIDGE_COMMAND_NAME_LIST);

// Un cliente puede anunciar una capability que este Worker todavía no conoce. La
// política es ignorar lo desconocido en vez de tirar la sesión, así que hace
// falta poder preguntar "¿existe en el catálogo?" sin parsear.
export function isKnownCapabilityName(candidate: string): candidate is CapabilityName {
  return (CAPABILITY_NAME_LIST as readonly string[]).includes(candidate);
}
