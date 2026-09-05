import { Agent, type Connection, type ConnectionContext, type WSMessage } from 'agents';
import {
  parsePcToServerMessage,
  encodeServerToPcMessage,
  type PcToServerMessage,
  type ServerToPcMessage,
} from '@/protocol/schema';

interface PcBridgeState {
  connected: boolean;
  hostname: string | null;
}

export class PcBridge extends Agent<Env, PcBridgeState> {
  initialState: PcBridgeState = { connected: false, hostname: null };

  #connection: Connection | null = null;
  #pending = new Map<
    string,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  #pingInterval: ReturnType<typeof setInterval> | null = null;

  async onConnect(connection: Connection, _ctx: ConnectionContext): Promise<void> {
    this.#connection = connection;
    this.setState({ ...this.state, connected: true });
  }

  async onMessage(connection: Connection, message: WSMessage): Promise<void> {
    if (typeof message !== 'string') return;

    let msg: PcToServerMessage;
    try {
      msg = parsePcToServerMessage(message);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'hello':
        this.setState({ ...this.state, hostname: msg.hostname });
        this.#startPingInterval(connection);
        break;
      case 'command_result':
        this.#resolvePending(msg.id, msg.ok, msg.result, msg.error);
        break;
      case 'pong':
        break;
    }
  }

  onClose(_connection: Connection): void {
    this.setState({ ...this.state, connected: false });
    this.#cleanup();
  }

  // Método RPC público — se llama desde el Worker/tools vía getAgentByName
  async sendCommand(
    type: ServerToPcMessage['type'],
    extra: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (!this.#connection) {
      throw new Error('PC no conectada');
    }

    const id = crypto.randomUUID();
    const message = { type, id, ...extra, ts: Date.now() } as ServerToPcMessage;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error('PC no respondió (timeout 8s)'));
      }, 8000);

      this.#pending.set(id, { resolve, reject, timeout });
      this.#connection!.send(encodeServerToPcMessage(message));
    });
  }

  #resolvePending(id: string, ok: boolean, result?: unknown, error?: string): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.#pending.delete(id);
    if (ok) pending.resolve(result);
    else pending.reject(new Error(error ?? 'PC command failed'));
  }

  #startPingInterval(connection: Connection): void {
    if (this.#pingInterval) clearInterval(this.#pingInterval);
    this.#pingInterval = setInterval(() => {
      connection.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
    }, 30_000);
  }

  #cleanup(): void {
    if (this.#pingInterval) clearInterval(this.#pingInterval);
    this.#pending.forEach(({ reject, timeout }) => {
      clearTimeout(timeout);
      reject(new Error('PC desconectada'));
    });
    this.#pending.clear();
    this.#connection = null;
  }
}
