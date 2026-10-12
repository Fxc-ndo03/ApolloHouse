import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Cliente mobile real en modo smoke.
 *
 * Es el mismo protocolo, allowlist y validacion que el cliente Kotlin de
 * `apps/mobile/app/src/main/java/com/apollo/mobile/`; lo que cambia es el
 * adapter de plataforma: aca no hay runtime Android, asi que la notificacion
 * nativa se representa con un adapter que registra lo que se habria mostrado.
 *
 * `apps/mobile/__tests__/contract.spec.ts` es el que impide que este puerto y el
 * Kotlin se separen: si el cliente Kotlin cambia una constante del contrato, el
 * gate de paridad falla antes de que este smoke pueda mentir.
 */
export const MOBILE_BRIDGE_PATH = '/agents/mobile-bridge/mobile';

export const MOBILE_DEVICE_TYPE = 'mobile';

export const MOBILE_PROTOCOL_VERSION = 1;

export const ANNOUNCED_CAPABILITY_LIST = ['mobile.notifications'];

export const ALLOWED_COMMAND_MAP = new Map<string, string>([
  ['mobile.notifications', 'notification_post'],
]);

export const NOTIFICATION_TITLE_MAX_LENGTH = 120;

export const NOTIFICATION_BODY_MAX_LENGTH = 500;

export const RECONNECT_BACKOFF_MILLISECOND_LIST = [
  1_000, 2_000, 4_000, 8_000, 16_000, 30_000,
];

export type MobileSessionState =
  | 'disconnected'
  | 'connecting'
  | 'authenticated'
  | 'online'
  | 'reconnecting';

export type PostedNotification = { readonly title: string; readonly body: string };

/** Adapter de plataforma. En produccion esto es NotificationCompat. */
export interface NotificationAdapter {
  requestPermission(): 'granted' | 'denied';
  post(title: string, body: string): boolean;
}

export class RecordingNotificationAdapter implements NotificationAdapter {
  readonly postedNotificationList: PostedNotification[] = [];
  permissionOutcome: 'granted' | 'denied' = 'granted';
  permissionRequestCount = 0;

  requestPermission(): 'granted' | 'denied' {
    this.permissionRequestCount += 1;
    return this.permissionOutcome;
  }

  post(title: string, body: string): boolean {
    if (this.permissionOutcome === 'denied') {
      return false;
    }
    this.postedNotificationList.push({ title, body });
    return true;
  }
}

export type CommandRejectionReason =
  | 'not_authenticated'
  | 'capability_not_allowed'
  | 'target_mismatch'
  | 'duplicate_in_flight'
  | 'unexpected_field'
  | 'invalid_type'
  | 'invalid_title_length'
  | 'invalid_body_length'
  | 'permission_denied'
  | 'post_failed';

export type CommandOutcome =
  | { readonly isPosted: true }
  | { readonly isPosted: false; readonly reason: CommandRejectionReason };

function validateNotificationPayload(
  payload: Record<string, unknown>,
): { title: string; body: string } | { rejectionReason: CommandRejectionReason } {
  const fieldNameList = Object.keys(payload).toSorted();
  if (fieldNameList.join(',') !== 'body,title') {
    return { rejectionReason: 'unexpected_field' };
  }
  const { title, body } = payload as { title: unknown; body: unknown };
  if (typeof title !== 'string' || typeof body !== 'string') {
    return { rejectionReason: 'invalid_type' };
  }
  if (title.length < 1 || title.length > NOTIFICATION_TITLE_MAX_LENGTH) {
    return { rejectionReason: 'invalid_title_length' };
  }
  if (body.length < 1 || body.length > NOTIFICATION_BODY_MAX_LENGTH) {
    return { rejectionReason: 'invalid_body_length' };
  }
  return { title, body };
}

function isCommandRejection(
  value:
    | CommandOutcome
    | { title: string; body: string }
    | { rejectionReason: CommandRejectionReason },
): value is { rejectionReason: CommandRejectionReason } {
  return 'rejectionReason' in value;
}

export type ReceivedServerMessage = Record<string, unknown> & { type: string };

/** Sesion mobile: handshake, heartbeat, dispatch y reconnect, sin duplicar timers. */
export class MobileClient {
  state: MobileSessionState = 'disconnected';
  rejectionReason: string | null = null;
  availableCapabilityList: readonly string[] = [];
  heartbeatIntervalMilliseconds = 30_000;
  heartbeatSendCount = 0;
  readonly sentMessageList: string[] = [];
  readonly commandResultList: Record<string, unknown>[] = [];

  private socket: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private isAuthenticatedOnce = false;
  private readonly inFlightRequestIdSet = new Set<string>();

  /**
   * BLOCK 12.1 §3: el socket de un dispositivo se abre con la credencial
   * individual en el header `Authorization`. Antes usaba `?token=` con el secreto
   * global, que el servidor ya no acepta para una identidad mobile.
   */
  constructor(
    private readonly workerBaseUrl: string,
    private readonly deviceCredential: string,
    readonly deviceId: string,
    private readonly notificationAdapter: NotificationAdapter,
  ) {}

  get isHeartbeatRunning(): boolean {
    return this.heartbeatTimer !== null;
  }

  buildSocketUrl(): string {
    const socketBaseUrl = this.workerBaseUrl.replace(/^http/, 'ws');
    return `${socketBaseUrl}${MOBILE_BRIDGE_PATH}`;
  }

  buildSocketHeaderMap(): Record<string, string> {
    return { Authorization: `Bearer ${this.deviceCredential}` };
  }

  start(): Promise<void> {
    this.state = 'connecting';
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.buildSocketUrl(), {
        headers: this.buildSocketHeaderMap(),
      });
      this.socket = socket;

      const failBeforeAuthentication = (detail: string) => {
        this.rejectionReason = detail;
        this.stopHeartbeat();
        this.state = 'disconnected';
        reject(new Error(detail));
      };

      socket.addEventListener('open', () => {
        this.sendHello();
      });
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data)) as ReceivedServerMessage;
        if (message['type'] === 'hello_accepted') {
          this.handleHelloAccepted(message);
          resolve();
        }
        if (message['type'] === 'hello_rejected') {
          failBeforeAuthentication(`hello_rejected:${String(message['reason'])}`);
        }
        if (message['type'] === 'heartbeat_probe') {
          this.sendHeartbeat();
        }
        if (message['type'] === 'command') {
          this.handleCommand(message);
        }
      });
      socket.addEventListener('error', () => {
        if (this.state !== 'online') {
          failBeforeAuthentication('unauthorized');
        }
      });
      socket.addEventListener('close', () => {
        this.stopHeartbeat();
        if (this.state !== 'online') {
          this.state = 'disconnected';
        }
      });
    });
  }

  sendHello(): void {
    this.send({
      type: 'hello',
      deviceId: this.deviceId,
      deviceType: MOBILE_DEVICE_TYPE,
      protocolVersion: MOBILE_PROTOCOL_VERSION,
      capabilities: ANNOUNCED_CAPABILITY_LIST,
      ts: Date.now(),
    });
  }

  sendHeartbeat(): void {
    this.heartbeatSendCount += 1;
    this.send({ type: 'heartbeat', ts: Date.now() });
  }

  disconnect(): void {
    this.stopHeartbeat();
    this.socket?.close();
    this.socket = null;
    this.state = 'disconnected';
  }

  private handleHelloAccepted(message: ReceivedServerMessage): void {
    this.availableCapabilityList = message['availableCapabilities'] as string[];
    this.heartbeatIntervalMilliseconds = Number(message['heartbeatIntervalMilliseconds']);
    this.state = 'authenticated';
    this.isAuthenticatedOnce = true;
    this.startHeartbeat();
    this.state = 'online';
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      return;
    }
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, this.heartbeatIntervalMilliseconds);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer === null) {
      return;
    }
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private handleCommand(message: ReceivedServerMessage): void {
    const requestId = String(message['requestId']);
    const capabilityName = String(message['capability']);
    const payload = (message['payload'] ?? {}) as Record<string, unknown>;
    const outcome = this.dispatch({ requestId, capabilityName, payload });

    const commandResult: Record<string, unknown> = {
      type: 'command_result',
      requestId,
      capability: capabilityName,
      ok: outcome.isPosted,
      ...(outcome.isPosted ? { result: { posted: true } } : { error: outcome.reason }),
      ts: Date.now(),
    };
    this.commandResultList.push(commandResult);
    this.send(commandResult);
  }

  dispatch(input: {
    requestId: string;
    capabilityName: string;
    payload: Record<string, unknown>;
    targetDeviceId?: string;
  }): CommandOutcome {
    if (this.state !== 'online') {
      return { isPosted: false, reason: 'not_authenticated' };
    }
    if (!ALLOWED_COMMAND_MAP.has(input.capabilityName)) {
      return { isPosted: false, reason: 'capability_not_allowed' };
    }
    if (input.targetDeviceId !== undefined && input.targetDeviceId !== this.deviceId) {
      return { isPosted: false, reason: 'target_mismatch' };
    }
    if (this.inFlightRequestIdSet.has(input.requestId)) {
      return { isPosted: false, reason: 'duplicate_in_flight' };
    }
    this.inFlightRequestIdSet.add(input.requestId);
    try {
      const validated = validateNotificationPayload(input.payload);
      if (isCommandRejection(validated)) {
        return { isPosted: false, reason: validated.rejectionReason };
      }
      if (this.notificationAdapter.requestPermission() !== 'granted') {
        return { isPosted: false, reason: 'permission_denied' };
      }
      return this.notificationAdapter.post(validated.title, validated.body)
        ? { isPosted: true }
        : { isPosted: false, reason: 'post_failed' };
    } finally {
      this.inFlightRequestIdSet.delete(input.requestId);
    }
  }

  private send(message: Record<string, unknown>): void {
    const rawMessageText = JSON.stringify(message);
    this.sentMessageList.push(rawMessageText);
    this.socket?.send(rawMessageText);
  }
}

export function buildReconnectSchedule(): number[] {
  return [...RECONNECT_BACKOFF_MILLISECOND_LIST];
}

/**
 * Estas invariantes son la compensacion de que el cliente real sea Kotlin y no se
 * pueda compilar aca: el smoke corre este puerto, asi que el gate tiene que
 * garantizar que no se puede aflojar en silencio.
 */
export const MOBILE_CLIENT_INVARIANT_LIST = [
  'state_is_online_before_command',
  'capability_in_allowlist',
  'target_matches_device',
  'request_id_preserved',
  'payload_field_set_is_exact',
  'single_heartbeat_timer',
] as const;

export type MobileClientInvariant = (typeof MOBILE_CLIENT_INVARIANT_LIST)[number];

export const MOBILE_CLIENT_INVARIANT_ANCHOR_MAP: ReadonlyMap<
  MobileClientInvariant,
  string
> = new Map([
  [
    'state_is_online_before_command',
    "if (this.state !== 'online') {\n      return { isPosted: false, reason: 'not_authenticated' };\n    }",
  ],
  ['capability_in_allowlist', 'if (!ALLOWED_COMMAND_MAP.has(input.capabilityName)) {'],
  ['target_matches_device', 'input.targetDeviceId !== this.deviceId'],
  ['request_id_preserved', 'requestId,\n      capability: capabilityName,'],
  ['payload_field_set_is_exact', "if (fieldNameList.join(',') !== 'body,title') {"],
  ['single_heartbeat_timer', 'if (this.heartbeatTimer !== null) {'],
]);

export function kotlinClientSourceExists(): boolean {
  return existsSync(
    join(
      import.meta.dir,
      '..',
      '..',
      'mobile',
      'app',
      'src',
      'main',
      'java',
      'com',
      'apollo',
      'mobile',
      'contract',
      'contract.kt',
    ),
  );
}
