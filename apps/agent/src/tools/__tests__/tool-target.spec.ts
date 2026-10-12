import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { listBuiltinToolDefinitionList } from '@/tools/catalog';
import { listPcToolDefinitionList } from '@/tools/pc';
import { resolveCapabilityForToolName } from '@/tools/capability-index';
import { buildToolDefinitionMap } from '@/tools/router';
import { isImplementedCapability } from '@/devices/capability';
import { listImplementedCapabilityNameList } from '@/devices/capability';

// La clasificación de tools no puede depender de que alguien recuerde
// actualizar un mapa aparte: sale de la metadata de cada definición.
describe('B6.2 structural: every pc tool is classified', () => {
  it('a pc tool without executionTarget metadata fails here', () => {
    const unclassifiedToolNameList = listPcToolDefinitionList()
      .filter((toolDefinition) => toolDefinition.executionTarget === undefined)
      .map((toolDefinition) => toolDefinition.name);
    expect(unclassifiedToolNameList).toEqual([]);
  });

  it('a pc tool pointing at an unimplemented capability fails here', () => {
    const invalidCapabilityList = listPcToolDefinitionList()
      .filter((toolDefinition) => {
        const executionTarget = toolDefinition.executionTarget;
        return (
          executionTarget !== undefined &&
          executionTarget.kind === 'capability' &&
          !isImplementedCapability(executionTarget.capabilityName)
        );
      })
      .map((toolDefinition) => toolDefinition.name);
    expect(invalidCapabilityList).toEqual([]);
  });

  it('the derived lookup covers every pc tool and nothing invented', () => {
    const toolDefinitionMap = buildToolDefinitionMap(listBuiltinToolDefinitionList());
    for (const toolDefinition of listPcToolDefinitionList()) {
      expect(
        resolveCapabilityForToolName(toolDefinitionMap, toolDefinition.name),
      ).toBeDefined();
    }
    // Una tool cloud-only NO se convierte en targeted.
    for (const cloudOnlyToolName of [
      'weather_now',
      'remember_fact',
      'set_reminder',
      'web_search',
      'send_email',
      'recall_memory',
      'start_research',
      'list_coding_repositories',
    ]) {
      expect(
        resolveCapabilityForToolName(toolDefinitionMap, cloudOnlyToolName),
      ).toBeUndefined();
    }
  });

  it('every implemented capability is reachable from at least one tool', () => {
    const builtinToolDefinitionList = listBuiltinToolDefinitionList();
    const toolDefinitionMap = buildToolDefinitionMap(builtinToolDefinitionList);
    // BLOCK 9: ya no es sólo el mundo PC. Se miran todas las tools declaradas
    // con executionTarget, de cualquier deviceType.
    const reachableCapabilityNameSet = new Set(
      builtinToolDefinitionList
        .filter((toolDefinition) => toolDefinition.executionTarget !== undefined)
        .map((toolDefinition) =>
          resolveCapabilityForToolName(toolDefinitionMap, toolDefinition.name),
        ),
    );
    for (const capabilityName of listImplementedCapabilityNameList()) {
      expect(reachableCapabilityNameSet.has(capabilityName)).toBe(true);
    }
  });

  it('BLOCK 9: the mobile tool declares its capability target and nothing physical', () => {
    const sendMobileNotification = listBuiltinToolDefinitionList().find(
      (toolDefinition) => toolDefinition.name === 'send_mobile_notification',
    );
    expect(sendMobileNotification).toBeDefined();
    if (sendMobileNotification === undefined) {
      return;
    }
    expect(sendMobileNotification.executionTarget).toEqual({
      kind: 'capability',
      capabilityName: 'mobile.notifications',
    });
    // La tool expresa intención. Llega al bridge por RPC, igual que las tools
    // de PC llegan a PcBridge: el pipeline ya corrió resolve target → authorize
    // → execute antes de que el handler exista. Lo que NO puede hacer es
    // construir la capa física o saltarse el endpoint.
    // Sin comentarios: lo que importa es el código, no lo que dice describiéndolo.
    const toolSource = readFileSync(
      join(import.meta.dir, '..', 'mobile', 'sender.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(toolSource).toContain('sendMobileCommand');
    expect(toolSource).not.toContain('DeviceSession');
    expect(toolSource).not.toContain('WebSocket');
    expect(toolSource).not.toContain('MobilePeerTransport');
    // No puede despachar comandos por su cuenta: eso es del endpoint.
    expect(toolSource).not.toContain('dispatchCommand');
    expect(toolSource).not.toContain("from '@/devices/endpoint'");
    expect(toolSource).not.toContain("from '@/devices/mobile'");
    // Tampoco invoca handlers niPcBridge.
    expect(toolSource).not.toContain('PcBridge');
  });
});
