import { describe, expect, test } from 'bun:test';

import { routeDeterministic } from '@/voice/router';

const FIXED_NOW = new Date('2026-09-15T14:30:00-03:00');

describe('routeDeterministic', () => {
  describe('PC commands', () => {
    test('opens app by Spanish name', () => {
      const result = routeDeterministic('abri bloc de notas', FIXED_NOW);
      expect(result.kind).toBe('pc_command');
      if (result.kind === 'pc_command') {
        expect(result.commandType).toBe('apps_open');
        expect(result.args.appName).toBe('bloc de notas');
      }
    });

    test('opens app with "en pc" suffix', () => {
      const result = routeDeterministic('abri spotify en pc', FIXED_NOW);
      expect(result.kind).toBe('pc_command');
      if (result.kind === 'pc_command') {
        expect(result.commandType).toBe('apps_open');
        expect(result.args.appName).toBe('spotify');
      }
    });

    test('opens app with accent', () => {
      const result = routeDeterministic('abrí la calculadora', FIXED_NOW);
      expect(result.kind).toBe('pc_command');
      if (result.kind === 'pc_command') {
        expect(result.commandType).toBe('apps_open');
        expect(result.args.appName).toBe('calculadora');
      }
    });

    test('closes app', () => {
      const result = routeDeterministic('cierra chrome', FIXED_NOW);
      expect(result.kind).toBe('pc_command');
      if (result.kind === 'pc_command') {
        expect(result.commandType).toBe('apps_close');
        expect(result.args.appName).toBe('chrome');
      }
    });

    test('focuses app', () => {
      const result = routeDeterministic('enfoca vscode', FIXED_NOW);
      expect(result.kind).toBe('pc_command');
      if (result.kind === 'pc_command') {
        expect(result.commandType).toBe('apps_focus');
        expect(result.args.appName).toBe('vscode');
      }
    });

    test('locks screen', () => {
      const result = routeDeterministic('bloquea la pantalla', FIXED_NOW);
      expect(result.kind).toBe('pc_command');
      if (result.kind === 'pc_command') {
        expect(result.commandType).toBe('lock_screen');
      }
    });

    test('spotify play', () => {
      const result = routeDeterministic('reproduce musica', FIXED_NOW);
      expect(result.kind).toBe('pc_command');
      if (result.kind === 'pc_command') {
        expect(result.commandType).toBe('spotify_play');
      }
    });

    test('spotify pause', () => {
      const result = routeDeterministic('pausa spotify', FIXED_NOW);
      expect(result.kind).toBe('pc_command');
      if (result.kind === 'pc_command') {
        expect(result.commandType).toBe('spotify_pause');
      }
    });

    test('spotify next', () => {
      const result = routeDeterministic('siguiente cancion', FIXED_NOW);
      expect(result.kind).toBe('pc_command');
      if (result.kind === 'pc_command') {
        expect(result.commandType).toBe('spotify_next');
      }
    });

    test('spotify previous', () => {
      const result = routeDeterministic('anterior pista', FIXED_NOW);
      expect(result.kind).toBe('pc_command');
      if (result.kind === 'pc_command') {
        expect(result.commandType).toBe('spotify_previous');
      }
    });
  });

  describe('time queries', () => {
    test('asks for time', () => {
      const result = routeDeterministic('que hora es', FIXED_NOW);
      expect(result.kind).toBe('time_answer');
      if (result.kind === 'time_answer') {
        expect(result.responseText).toContain('14:30');
      }
    });

    test('asks for current time', () => {
      const result = routeDeterministic('hora actual', FIXED_NOW);
      expect(result.kind).toBe('time_answer');
    });
  });

  describe('date queries', () => {
    test('asks for date', () => {
      const result = routeDeterministic('que dia es hoy', FIXED_NOW);
      expect(result.kind).toBe('date_answer');
      if (result.kind === 'date_answer') {
        expect(result.responseText).toContain('15');
        expect(result.responseText).toContain('septiembre');
      }
    });

    test('asks for current date', () => {
      const result = routeDeterministic('fecha actual', FIXED_NOW);
      expect(result.kind).toBe('date_answer');
    });
  });
  describe('memory writes', () => {
    test('remembers an explicit fact', () => {
      const result = routeDeterministic('recordá que mi cumple es en mayo', FIXED_NOW);
      expect(result.kind).toBe('memory_write');
      if (result.kind === 'memory_write') {
        expect(result.fact).toBe('mi cumple es en mayo');
      }
    });

    test('remembers with accent and de que', () => {
      const result = routeDeterministic(
        'acordate de que mañana tengo dentista',
        FIXED_NOW,
      );
      expect(result.kind).toBe('memory_write');
      if (result.kind === 'memory_write') {
        expect(result.fact).toBe('mañana tengo dentista');
      }
    });

    test('rejects fact that is too short', () => {
      const result = routeDeterministic('recordá que sí', FIXED_NOW);
      expect(result.kind).toBe('ai_needed');
    });

    test('save-file without que goes to AI', () => {
      const result = routeDeterministic('guarda el archivo', FIXED_NOW);
      expect(result.kind).toBe('ai_needed');
    });

    test('bare shopping words go to AI', () => {
      const result = routeDeterministic('anotá leche', FIXED_NOW);
      expect(result.kind).toBe('ai_needed');
    });

    test('recall questions go to AI', () => {
      const result = routeDeterministic('te acordás que te dije?', FIXED_NOW);
      expect(result.kind).toBe('ai_needed');
    });
  });

  describe('accented input', () => {
    test('matches time with accents', () => {
      expect(routeDeterministic('qué hora es', FIXED_NOW).kind).toBe('time_answer');
    });

    test('matches date with accents', () => {
      expect(routeDeterministic('qué fecha es hoy', FIXED_NOW).kind).toBe('date_answer');
    });

    test('matches close with accents', () => {
      const result = routeDeterministic('cerrá chrome', FIXED_NOW);
      expect(result.kind).toBe('pc_command');
      if (result.kind === 'pc_command') {
        expect(result.commandType).toBe('apps_close');
        expect(result.args.appName).toBe('chrome');
      }
    });

    test('keeps accents in captured app names', () => {
      const result = routeDeterministic('abrí la música', FIXED_NOW);
      expect(result.kind).toBe('pc_command');
      if (result.kind === 'pc_command') {
        expect(result.args.appName).toBe('música');
      }
    });

    test('matches spotify verbs with accents', () => {
      const result = routeDeterministic('pausá música', FIXED_NOW);
      expect(result.kind).toBe('pc_command');
      if (result.kind === 'pc_command') {
        expect(result.commandType).toBe('spotify_pause');
      }
    });
  });

  describe('deferred time expressions', () => {
    test('open with time amount goes to AI instead of opening now', () => {
      expect(routeDeterministic('abrí spotify en 5 minutos', FIXED_NOW).kind).toBe(
        'ai_needed',
      );
    });

    test('plain open still works', () => {
      expect(routeDeterministic('abrí spotify', FIXED_NOW).kind).toBe('pc_command');
    });
  });

  describe('ambiguous poner', () => {
    test('timer request is not treated as a focus target', () => {
      expect(
        routeDeterministic('poné un temporizador de 5 minutos', FIXED_NOW).kind,
      ).toBe('ai_needed');
    });

    test('music request resolves to spotify play', () => {
      const result = routeDeterministic('poné música en spotify', FIXED_NOW);
      expect(result.kind).toBe('pc_command');
      if (result.kind === 'pc_command') {
        expect(result.commandType).toBe('spotify_play');
      }
    });

    test('pause request resolves to spotify pause', () => {
      const result = routeDeterministic('poné pausa', FIXED_NOW);
      expect(result.kind).toBe('pc_command');
      if (result.kind === 'pc_command') {
        expect(result.commandType).toBe('spotify_pause');
      }
    });

    test('real app after poner still focuses', () => {
      const result = routeDeterministic('poné chrome al frente', FIXED_NOW);
      expect(result.kind).toBe('pc_command');
      if (result.kind === 'pc_command') {
        expect(result.commandType).toBe('apps_focus');
        expect(result.args.appName).toBe('chrome al frente');
      }
    });
  });

  describe('foreign timezone', () => {
    test('time in another place goes to AI', () => {
      expect(routeDeterministic('qué hora es en Tokio', FIXED_NOW).kind).toBe(
        'ai_needed',
      );
    });

    test('local time still answers', () => {
      expect(routeDeterministic('qué hora es', FIXED_NOW).kind).toBe('time_answer');
    });
  });

  describe('AI needed (no match)', () => {
    test('general question goes to AI', () => {
      const result = routeDeterministic('que es la inteligencia artificial', FIXED_NOW);
      expect(result.kind).toBe('ai_needed');
    });

    test('greeting goes to AI', () => {
      const result = routeDeterministic('hola como estas', FIXED_NOW);
      expect(result.kind).toBe('ai_needed');
    });

    test('empty text goes to AI', () => {
      const result = routeDeterministic('', FIXED_NOW);
      expect(result.kind).toBe('ai_needed');
    });
  });
});
