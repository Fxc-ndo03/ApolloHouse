// SOLO PRUEBAS. Imita el puente de Android (mismo protocolo) para verificar la integracion en el navegador.
// No prueba Kotlin ni WebView real. No se incluye en el build de produccion.
type Req = { operation: string; requestId: string; arguments: unknown };

export function installFakeBridge(scenario: string): { log: { operation: string; arguments: unknown }[] } {
  const listeners = new Set<(ev: { data: unknown }) => void>();
  const log: { operation: string; arguments: unknown }[] = [];
  const w = window as unknown as Window & { ApolloNative?: unknown; __bridgeLog?: typeof log; __apolloEvent?: (n: string, p: string) => void };
  w.__bridgeLog = log;

  // Eventos que Kotlin emitiria tras un turno de conversacion (no hay streaming: un solo fragmento).
  const emitTurnEvents = (text: string) => {
    setTimeout(() => {
      w.__apolloEvent?.('text-response-chunk', JSON.stringify(text));
      w.__apolloEvent?.('text-response-end', '{}');
      w.__apolloEvent?.('turn-end', JSON.stringify({ expectsReply: false }));
    }, 80);
  };

  const respond = (req: Req): Record<string, unknown> => {
    let reply: Record<string, unknown>;
    switch (req.operation) {
      case 'auth.state':
        reply = scenario === 'signedin'
          ? { ok: true, data: { signedIn: true, accountId: 'acc_demo', email: 'facundo@example.com' } }
          : { ok: true, data: { signedIn: false } };
        break;
      case 'auth.login':
        reply = scenario === 'badpass' ? { ok: false, error: 'invalid_credentials' } : { ok: true, data: { accountId: 'acc_demo' } };
        break;
      case 'auth.register':
        reply = { ok: true, data: { accountId: 'acc_new' } };
        break;
      case 'auth.logout':
        reply = { ok: true, data: {} };
        break;
      case 'conversation.send':
        reply = { ok: true, data: { turnId: 't1' } };
        emitTurnEvents('Respuesta de prueba desde el puente falso.');
        break;
      case 'settings.read':
        reply = { ok: true, data: { mic_muted: false, tts_muted: false, tts_provider: 'cloudflare', tts_voice: '', tts_language: 'es', tts_speed: 1 } };
        break;
      case 'settings.write':
        reply = { ok: true, data: {} };
        break;
      case 'updates.check':
        reply = { ok: true, data: { state: 'up_to_date', versionName: '1.0.0', installedVersion: '1.0.0' } };
        break;
      case 'voice.start':
      case 'voice.stop':
        reply = { ok: true, data: {} };
        break;
      default:
        reply = { ok: false, error: 'unsupported_operation' };
    }
    return { ...reply, requestId: req.requestId };
  };

  w.ApolloNative = {
    postMessage(json: string) {
      const req = JSON.parse(json) as Req;
      log.push({ operation: req.operation, arguments: req.arguments });
      setTimeout(() => {
        const out = JSON.stringify(respond(req));
        listeners.forEach((cb) => cb({ data: out }));
      }, 30);
    },
    addEventListener(_t: 'message', cb: (ev: { data: unknown }) => void) { listeners.add(cb); },
    removeEventListener(_t: 'message', cb: (ev: { data: unknown }) => void) { listeners.delete(cb); },
  };
  return { log };
}
