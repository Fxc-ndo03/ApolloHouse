import {
  ANY_TARGET_PREFERENCE,
  desktopTargetPreference,
  mobileTargetPreference,
  type TargetPreference,
} from '@/devices/schema';
import type { CapabilityName } from '@/devices/capability';
import type { RouterOutcome } from '@/voice/router';

// Integración con el router (Block 3) sin tocarlo: el router sigue decidiendo
// intención y el Registry sigue resolviendo target. Esta función sólo traduce
// una intención ya resuelta a un contrato de capability.
//
// No mueve safety: la autorización sigue en authorizeToolExecution.

export type CapabilityIntent = {
  readonly domain: 'pc' | 'desktop' | 'media' | 'mobile';
  readonly capabilityName: CapabilityName;
  readonly targetPreference: TargetPreference;
};

const ROUTER_COMMAND_TO_CAPABILITY_MAP: ReadonlyMap<string, CapabilityIntent> = new Map([
  [
    'apps_open',
    {
      domain: 'pc',
      capabilityName: 'desktop.open_app',
      targetPreference: desktopTargetPreference,
    },
  ],
  [
    'apps_focus',
    {
      domain: 'pc',
      capabilityName: 'desktop.focus_app',
      targetPreference: desktopTargetPreference,
    },
  ],
  [
    'apps_close',
    {
      domain: 'pc',
      capabilityName: 'desktop.close_app',
      targetPreference: desktopTargetPreference,
    },
  ],
  [
    'lock_screen',
    {
      domain: 'pc',
      capabilityName: 'desktop.lock',
      targetPreference: desktopTargetPreference,
    },
  ],
  [
    'spotify_play',
    {
      domain: 'media',
      capabilityName: 'desktop.spotify',
      targetPreference: desktopTargetPreference,
    },
  ],
  [
    'spotify_pause',
    {
      domain: 'media',
      capabilityName: 'desktop.spotify',
      targetPreference: desktopTargetPreference,
    },
  ],
  [
    'spotify_next',
    {
      domain: 'media',
      capabilityName: 'desktop.spotify',
      targetPreference: desktopTargetPreference,
    },
  ],
  [
    'spotify_previous',
    {
      domain: 'media',
      capabilityName: 'desktop.spotify',
      targetPreference: desktopTargetPreference,
    },
  ],
]);

export const GENERIC_SPOTIFY_INTENT: CapabilityIntent = {
  domain: 'media',
  capabilityName: 'desktop.spotify',
  // "poné música" sin decir dónde: cualquier device que sepa hacerlo sirve.
  targetPreference: ANY_TARGET_PREFERENCE,
};

// BLOCK 11 §12: la familia mobile del router determinista. El target SIEMPRE es
// mobile explícito (o `any` cuando el usuario no dijo dónde): nunca hay fallback
// a desktop para una capability mobile, porque la capability ya declara su
// deviceType y el resolver enruta por contrato, no por preferencia de texto.
const ROUTER_MOBILE_COMMAND_TO_CAPABILITY_MAP: ReadonlyMap<string, CapabilityIntent> =
  new Map([
    [
      'notification_post',
      {
        domain: 'mobile',
        capabilityName: 'mobile.notifications',
        targetPreference: mobileTargetPreference,
      },
    ],
    [
      'alarm_set',
      {
        domain: 'mobile',
        capabilityName: 'mobile.alarm',
        targetPreference: mobileTargetPreference,
      },
    ],
    [
      'calendar_create',
      {
        domain: 'mobile',
        capabilityName: 'mobile.calendar',
        targetPreference: mobileTargetPreference,
      },
    ],
    [
      'media_play',
      {
        domain: 'mobile',
        capabilityName: 'mobile.media',
        targetPreference: mobileTargetPreference,
      },
    ],
    [
      'volume_set',
      {
        domain: 'mobile',
        capabilityName: 'mobile.volume',
        targetPreference: mobileTargetPreference,
      },
    ],
    [
      'app_open',
      {
        domain: 'mobile',
        capabilityName: 'mobile.open_app',
        targetPreference: mobileTargetPreference,
      },
    ],
  ]);

export function resolveCapabilityIntent(
  routerOutcome: RouterOutcome,
): CapabilityIntent | null {
  if (routerOutcome.kind === 'mobile_command') {
    return ROUTER_MOBILE_COMMAND_TO_CAPABILITY_MAP.get(routerOutcome.commandType) ?? null;
  }
  if (routerOutcome.kind !== 'pc_command') {
    return null;
  }
  return ROUTER_COMMAND_TO_CAPABILITY_MAP.get(routerOutcome.commandType) ?? null;
}

export function listRouterMobileCommandList(): readonly string[] {
  return [...ROUTER_MOBILE_COMMAND_TO_CAPABILITY_MAP.keys()];
}
