import { describe, expect, it } from 'bun:test';

import {
  buildDeviceContextNote,
  buildEmptyReachableCapabilitySnapshot,
  buildReachableCapabilitySnapshot,
  filterToolByReachableDevice,
  listCapabilityNameForDevice,
} from '@/devices/exposure';
import { listMobileToolDefinitionList } from '@/tools/mobile';
import { listBuiltinToolDefinitionList } from '@/tools/catalog';
import {
  buildExposedToolNameList,
  filterExposedToolDefinitions,
  resolveToolDomain,
} from '@/tools/domain';
import { routeDeterministic } from '@/voice/router';
import { resolveCapabilityIntent } from '@/devices/intent';
import { selectRouterToolRequest } from '@/tools/selection';

// Block 11 §11, §12 y §13: qué ve el modelo, qué matchea el router, y qué
// entra al prompt.

const SNAPSHOT_WITH_PHONE = buildReachableCapabilitySnapshot({
  reachableCapabilityEntryList: [
    {
      capabilityName: 'mobile.notifications',
      deviceId: 'mobile:phone-1',
      presence: 'online',
    },
    { capabilityName: 'mobile.alarm', deviceId: 'mobile:phone-1', presence: 'online' },
  ],
  deviceSummaryList: [
    {
      deviceId: 'mobile:phone-1',
      presence: 'online',
      capabilityNameList: ['mobile.notifications', 'mobile.alarm'],
    },
  ],
});

describe('B11 §11: el catálogo se filtra por device disponible', () => {
  it('exposes exactly the mobile tools the connected phone declares', () => {
    const blockedList = listCapabilityNameForDevice(
      listMobileToolDefinitionList(),
      SNAPSHOT_WITH_PHONE,
    );
    expect(blockedList).not.toContain('send_mobile_notification');
    expect(blockedList).not.toContain('set_mobile_alarm');

    const exposedList = filterToolByReachableDevice(
      listMobileToolDefinitionList(),
      SNAPSHOT_WITH_PHONE,
    );
    const exposedNameList = exposedList.map((tool) => tool.name);
    expect(exposedNameList).toContain('send_mobile_notification');
    expect(exposedNameList).toContain('set_mobile_alarm');
    expect(exposedNameList).not.toContain('play_mobile_media');
  });

  it('a phone that declares every capability exposes every mobile tool', () => {
    const fullSnapshot = buildReachableCapabilitySnapshot({
      reachableCapabilityEntryList: [
        {
          capabilityName: 'mobile.notifications',
          deviceId: 'mobile:phone-1',
          presence: 'online',
        },
        {
          capabilityName: 'mobile.alarm',
          deviceId: 'mobile:phone-1',
          presence: 'online',
        },
        {
          capabilityName: 'mobile.calendar',
          deviceId: 'mobile:phone-1',
          presence: 'online',
        },
        {
          capabilityName: 'mobile.media',
          deviceId: 'mobile:phone-1',
          presence: 'online',
        },
        {
          capabilityName: 'mobile.volume',
          deviceId: 'mobile:phone-1',
          presence: 'online',
        },
        {
          capabilityName: 'mobile.open_app',
          deviceId: 'mobile:phone-1',
          presence: 'online',
        },
      ],
      deviceSummaryList: [],
    });
    expect(
      listCapabilityNameForDevice(listMobileToolDefinitionList(), fullSnapshot),
    ).toEqual([]);
    expect(
      filterToolByReachableDevice(listMobileToolDefinitionList(), fullSnapshot),
    ).toHaveLength(listMobileToolDefinitionList().length);
  });

  it('without a phone the mobile tools are NOT exposed', () => {
    const blockedList = listCapabilityNameForDevice(
      listMobileToolDefinitionList(),
      buildEmptyReachableCapabilitySnapshot(),
    );
    expect(blockedList.length).toBeGreaterThan(0);
    expect(blockedList).toContain('send_mobile_notification');
    expect(blockedList).toContain('set_mobile_alarm');

    const exposedList = filterToolByReachableDevice(
      listMobileToolDefinitionList(),
      buildEmptyReachableCapabilitySnapshot(),
    );
    expect(exposedList).toHaveLength(0);
  });

  it('only the tools whose capability is unreachable get blocked', () => {
    // El snapshot tiene notifications y alarm; media, volume, calendar y
    // open_app quedan fuera, así que sus tools se ocultan y las otras no.
    const blockedList = listCapabilityNameForDevice(
      listMobileToolDefinitionList(),
      SNAPSHOT_WITH_PHONE,
    );
    expect(blockedList).toContain('play_mobile_media');
    expect(blockedList).toContain('set_mobile_volume');
    expect(blockedList).toContain('open_mobile_app');
    expect(blockedList).not.toContain('send_mobile_notification');
    expect(blockedList).not.toContain('set_mobile_alarm');
  });

  it('desktop and cloud tools are never blocked by a mobile snapshot', () => {
    const allToolList = listBuiltinToolDefinitionList();
    const blockedList = listCapabilityNameForDevice(
      allToolList,
      buildEmptyReachableCapabilitySnapshot(),
    );
    for (const toolName of blockedList) {
      const toolDefinition = allToolList.find((tool) => tool.name === toolName);
      expect(toolDefinition?.executionTarget).toEqual({
        kind: 'capability',
        capabilityName: expect.stringContaining('mobile.') as never,
      });
    }
    expect(blockedList).not.toContain('open_pc_app');
    expect(blockedList).not.toContain('weather_now');
  });

  it('the Block 3 domain filter composes with the device filter', () => {
    const resolution = resolveToolDomain('mandame una notificación al teléfono');
    expect(resolution.domain).toBe('mobile');
    // Una palabra clave = confianza media: entra el dominio mobile más el
    // core transversal de Block 3.
    expect(resolution.confidence).toBe('medium');
    const domainExposedNameList = buildExposedToolNameList(resolution);
    expect(domainExposedNameList).not.toBeNull();
    // El dominio mobile ya deja fuera las tools de PC.
    expect(domainExposedNameList).not.toContain('open_pc_app');

    const domainFilteredList = filterExposedToolDefinitions(
      listBuiltinToolDefinitionList(),
      domainExposedNameList,
    );
    const deviceFilteredList = filterToolByReachableDevice(
      domainFilteredList,
      SNAPSHOT_WITH_PHONE,
    );
    const nameList = deviceFilteredList.map((tool) => tool.name);
    // Lo que el teléfono declara sobrevive; lo que no, desaparece. El filtro de
    // device es el que recorta sobre el dominio.
    expect(nameList).toContain('send_mobile_notification');
    expect(nameList).toContain('set_mobile_alarm');
    expect(nameList).not.toContain('play_mobile_media');
    expect(nameList).not.toContain('open_pc_app');
  });

  it('an ambiguous phrase between pc and mobile falls back to the full catalog', () => {
    // "abrir whatsapp en el teléfono" matchea 'abrir' (pc) y 'telefono' (mobile):
    // empate = ambigüedad = catálogo completo. Es el anti-false-positive de Block 3
    // y no se toca.
    const resolution = resolveToolDomain('abrir whatsapp en el teléfono');
    expect(resolution.domain).toBe('general');
    expect(buildExposedToolNameList(resolution)).toBeNull();
  });

  it('a phone-less phrase resolves to the pc domain and hides mobile tools', () => {
    // Anti-false-positive: "abrir whatsapp" sin decir dónde NO ofrece la tool
    // mobile; el router determinista tampoco matchea mobile.
    const resolution = resolveToolDomain('abrir whatsapp');
    expect(resolution.domain).toBe('pc');
    const domainFilteredList = filterExposedToolDefinitions(
      listBuiltinToolDefinitionList(),
      buildExposedToolNameList(resolution),
    );
    expect(domainFilteredList.map((tool) => tool.name)).not.toContain('open_mobile_app');
  });
});

describe('B11 §13: contexto cross-device mínimo', () => {
  it('lists deviceId, deviceType, presence y resumen de capabilities', () => {
    const note = buildDeviceContextNote('desktop:PC-ESTUDIO', SNAPSHOT_WITH_PHONE);
    expect(note).toContain('mobile:phone-1');
    expect(note).toContain('online');
    expect(note).toContain('mobile.notifications');
    // El registry entero NO va al prompt.
    expect(note).not.toContain('connectionId');
    expect(note).not.toContain('priority');
    expect(note).not.toContain('lastSeenAt');
    expect(note).not.toContain('protocolVersion');
  });

  it('marks the active device', () => {
    const note = buildDeviceContextNote('mobile:phone-1', SNAPSHOT_WITH_PHONE);
    expect(note).toContain('(activo)');
  });

  it('returns an empty string when there is no mobile device, so the prompt does not change', () => {
    expect(
      buildDeviceContextNote(
        'desktop:PC-ESTUDIO',
        buildEmptyReachableCapabilitySnapshot(),
      ),
    ).toBe('');
  });
});

describe('B11 §12: intents mobile deterministas', () => {
  const cases: readonly [string, string][] = [
    ['mandame una notificación', 'notification_post'],
    ['envíame un aviso', 'notification_post'],
    ['abrí whatsapp en el teléfono', 'app_open'],
    ['abrí maps en el celular', 'app_open'],
    ['poné música en el teléfono', 'media_play'],
    ['subí el volumen en el celular', 'volume_set'],
    ['poné una alarma a las 7 en el teléfono', 'alarm_set'],
    ['agendame una cita en el teléfono', 'calendar_create'],
  ];

  for (const [userText, commandType] of cases) {
    it(`"${userText}" -> ${commandType}`, () => {
      const outcome = routeDeterministic(userText);
      expect(outcome.kind).toBe('mobile_command');
      if (outcome.kind === 'mobile_command') {
        expect(outcome.commandType).toBe(commandType);
      }
    });
  }

  it('a mobile intent never resolves to a desktop capability', () => {
    for (const [userText] of cases) {
      const intent = resolveCapabilityIntent(routeDeterministic(userText));
      expect(intent?.capabilityName.startsWith('mobile.')).toBe(true);
      expect(intent?.targetPreference).toEqual({
        kind: 'device_type',
        deviceType: 'mobile',
      });
    }
  });

  it('every mobile intent maps to a real tool', () => {
    for (const [userText] of cases) {
      const outcome = routeDeterministic(userText);
      if (outcome.kind !== 'mobile_command') {
        throw new Error(`${userText} no matcheo`);
      }
      const selected = selectRouterToolRequest(outcome);
      const toolDefinition = listMobileToolDefinitionList().find(
        (tool) => tool.name === selected.toolName,
      );
      expect(toolDefinition).toBeDefined();
    }
  });

  it('a desktop intent without "en el teléfono" stays desktop', () => {
    expect(routeDeterministic('abrir chrome').kind).toBe('pc_command');
    expect(routeDeterministic('abrir chrome en la pc').kind).toBe('pc_command');
    const intent = resolveCapabilityIntent(routeDeterministic('abrir chrome en la pc'));
    expect(intent?.capabilityName).toBe('desktop.open_app');
    expect(intent?.targetPreference).toEqual({
      kind: 'device_type',
      deviceType: 'desktop',
    });
  });

  it('accent normalization is applied to mobile intents too', () => {
    expect(routeDeterministic('abrÍ whatsapp en el telÉfono').kind).toBe(
      'mobile_command',
    );
    expect(routeDeterministic('mandame una notificaciÓn').kind).toBe('mobile_command');
  });

  it('an alarm without a phone mention goes to the cloud tool, not mobile', () => {
    // Anti-false-positive: "poné una alarma" sin decir dónde no es mobile.
    const outcome = routeDeterministic('poné una alarma a las 7');
    expect(outcome.kind === 'mobile_command').toBe(false);
  });

  it('a mobile suffix with an unknown action goes to the LLM, never to desktop', () => {
    const outcome = routeDeterministic('encendé la luz en el teléfono');
    expect(outcome.kind).toBe('ai_needed');
  });
});
