import { describe, expect, it } from 'bun:test';

import {
  buildExposedToolNameList,
  builtinToolNameSet,
  filterExposedToolDefinitions,
  normalizeDomainText,
  resolveToolDomain,
} from '@/tools/domain';

describe('resolveToolDomain', () => {
  it('routes spotify music requests to pc with high confidence', () => {
    const resolution = resolveToolDomain('poné algo de música en spotify');
    expect(resolution.domain).toBe('pc');
    expect(resolution.confidence).toBe('high');
  });

  it('routes volume requests to pc', () => {
    const resolution = resolveToolDomain('subí el volumen');
    expect(resolution.domain).toBe('pc');
    expect(resolution.confidence).toBe('medium');
  });

  it('routes explicit memory writes to memory', () => {
    const resolution = resolveToolDomain('recordá que mi cumple es en mayo');
    expect(resolution.domain).toBe('memory');
  });

  it('routes recall questions to memory', () => {
    const resolution = resolveToolDomain('qué te acordás de mi cumpleaños');
    expect(resolution.domain).toBe('memory');
  });

  it('routes weather questions to weather', () => {
    const resolution = resolveToolDomain('va a llover mañana? hace falta paraguas');
    expect(resolution.domain).toBe('weather');
    expect(resolution.confidence).toBe('high');
  });

  it('routes timers and reminders to scheduling', () => {
    expect(resolveToolDomain('poné un temporizador de 5 minutos').domain).toBe(
      'scheduling',
    );
    expect(resolveToolDomain('avisame en 10 minutos').domain).toBe('scheduling');
    expect(resolveToolDomain('agregá leche a la lista').domain).toBe('scheduling');
  });

  it('routes web questions to research', () => {
    const resolution = resolveToolDomain('buscá en internet quién ganó el mundial');
    expect(resolution.domain).toBe('research');
    expect(resolution.confidence).toBe('high');
  });

  it('routes code questions to coding', () => {
    const resolution = resolveToolDomain('revisá el código del repo en github');
    expect(resolution.domain).toBe('coding');
    expect(resolution.confidence).toBe('high');
  });

  it('routes mail requests to email', () => {
    const resolution = resolveToolDomain('mandame un mail con el resumen');
    expect(resolution.domain).toBe('email');
  });

  it('falls back to general on ambiguous text', () => {
    const resolution = resolveToolDomain('hola, cómo estás?');
    expect(resolution.domain).toBe('general');
    expect(resolution.confidence).toBe('low');
  });

  it('falls back to general on domain ties', () => {
    const resolution = resolveToolDomain('poné música en 5 minutos');
    expect(resolution.domain).toBe('general');
    expect(resolution.confidence).toBe('low');
  });

  it('normalizes accents before matching', () => {
    expect(normalizeDomainText('MÚSICA Clásica')).toBe('musica clasica');
    expect(resolveToolDomain('qué música está sonando?').domain).toBe('pc');
  });
});

describe('buildExposedToolNameList', () => {
  it('returns only the domain catalog on high confidence', () => {
    const names = buildExposedToolNameList({
      domain: 'weather',
      confidence: 'high',
      score: 3,
      matchedKeywordList: ['clima', 'lluvia'],
    });
    expect(names).not.toBeNull();
    expect(names ?? []).toContain('weather_now');
    expect(names ?? []).toContain('set_weather_location');
    expect(names ?? []).not.toContain('spotify_play');
    expect(names ?? []).not.toContain('start_coding_task');
  });

  it('adds the safe core set on medium confidence', () => {
    const names = buildExposedToolNameList({
      domain: 'pc',
      confidence: 'medium',
      score: 1,
      matchedKeywordList: ['volumen'],
    });
    expect(names ?? []).toContain('set_volume');
    expect(names ?? []).toContain('device_status');
    expect(names ?? []).toContain('recall_memory');
    expect(names ?? []).toContain('web_search');
    expect(names ?? []).not.toContain('start_coding_task');
  });

  it('returns null (full catalog) on low confidence', () => {
    expect(
      buildExposedToolNameList({
        domain: 'general',
        confidence: 'low',
        score: 0,
        matchedKeywordList: [],
      }),
    ).toBeNull();
  });
});

describe('filterExposedToolDefinitions', () => {
  const fakeDefinitionList = [
    { name: 'weather_now' },
    { name: 'spotify_play' },
    { name: 'mcp__server__custom_tool' },
  ];

  it('keeps non-builtin (MCP/dynamic) tools always', () => {
    const filtered = filterExposedToolDefinitions(fakeDefinitionList, ['weather_now']);
    expect(filtered.map((tool) => tool.name)).toEqual([
      'weather_now',
      'mcp__server__custom_tool',
    ]);
  });

  it('returns everything when the list is null', () => {
    expect(filterExposedToolDefinitions(fakeDefinitionList, null)).toEqual(
      fakeDefinitionList,
    );
  });

  it('exposes real builtin names', () => {
    expect(builtinToolNameSet().has('weather_now')).toBe(true);
    expect(builtinToolNameSet().has('open_pc_app')).toBe(true);
    expect(builtinToolNameSet().has('remember_fact')).toBe(true);
  });
});
