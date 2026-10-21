# 07 · Contrato final del puente (lo que Kotlin debe implementar)

El protocolo de sobres no cambia: `window.ApolloNative.postMessage(json)` con `{contractVersion, operation, arguments, requestId}`, y respuesta `{ok, data?, error?, requestId}` por el evento `message`. Ver `docs/05-correcciones.md` del paquete anterior.

## A. Funciones que Kotlin llama en la interfaz

| Función | Qué hace | Cómo llamarla |
|---|---|---|
| `window.__apolloEvent(name, payloadJson)` | Entrega un evento a la interfaz. `payloadJson` es siempre un string JSON | `webView.evaluateJavascript("window.__apolloEvent(" + JSONObject.quote(name) + ", " + JSONObject.quote(payloadJson) + ")", null)`, en el hilo principal |
| `window.__apolloBack()` | La interfaz la llama, y Kotlin la invoca desde el botón atrás. Devuelve `true` si la consumió | `evaluateJavascript("window.__apolloBack()") { result -> ... }`. `result == "true"` → consumido. Si no, comportamiento normal de Android |

## B. Operaciones (argumentos → resultado `data`)

| Operación | Argumentos | Resultado | Estado en Kotlin |
|---|---|---|---|
| `auth.state` | `{}` | `{signedIn: boolean, accountId?: string, email?: string}` | Existe. Confirmar claves |
| `auth.login` | `{email, password}` | `{accountId}` | Existe. Confirmar claves. La contraseña no se registra |
| `auth.register` | `{email, password}` | `{accountId}` | Existe. Solo correo y contraseña (sin nombre) |
| `auth.logout` | `{}` | `{}` | Existe |
| `conversation.send` | `{text}` | `{turnId}`. La respuesta llega después como eventos (sección C) | Existe. Falta emitir eventos |
| `settings.read` | `{}` | 17 campos en snake_case: `worker_url, device_shared_secret, wake_words, use_vosk_wake, wake_model_dir, response_output_target, autostart_enabled, mic_muted, tts_muted, use_local_core, core_lan_url, tts_provider, tts_voice, tts_language, tts_speed, input_device_name, output_device_name`. **`device_shared_secret` siempre `""`** | **No existe** |
| `settings.write` | `{patch: {...}}`. Solo se aceptan `mic_muted, tts_muted, tts_provider, tts_voice, tts_language, tts_speed` | `{}` | **No existe** |
| `updates.check` | `{}` | Sobre del contrato: `{channel, installedVersion, status: {kind}, latestVersion, notes, publishedAt, message}`. `kind`: `idle, checking, upToDate, available, downloading, ready, pendingRestart, deferred, failed` | Existe con otro formato (`{state}`). Cambiar al contrato |
| `updates.install` | `{}` | `{}`. Inicia la instalación. Si falta el permiso, `permission_denied` | **Nueva**. Agregar a `ALLOWED_OPERATIONS` |
| `voice.start` | `{}` | `{}`. Solo por acción del usuario. Pide `RECORD_AUDIO` si falta | **No existe** |
| `voice.stop` | `{}` | `{}` | **No existe** |

Tabla de traducción de estados de actualización (`UpdateOwner` → `kind`):

| Estado interno | `kind` |
|---|---|
| inactivo | `idle` |
| comprobando | `checking` |
| al día (`up_to_date`) | `upToDate` |
| disponible | `available` |
| descargando | `downloading` |
| listo para instalar (`ready_to_install`) | `ready` |
| instalador abierto (`installer_open`) | `pendingRestart` |
| falta permiso (`missing_permission`) | `failed` (con `reason`) |
| error | `failed` (con `reason`) |

## C. Eventos que Kotlin envía a la interfaz (lista cerrada)

| Evento | Payload (JSON) | Cuándo |
|---|---|---|
| `text-response-chunk` | string con el texto completo de la respuesta, por ejemplo `"Hola"` | Al completarse un turno del asistente |
| `text-response-end` | `{}` | Después del chunk |
| `turn-end` | `{"expectsReply": false}` | Al terminar el turno |
| `error` | `{"code": "...", "message": "..."}` | Fallo de conversación. `code` como en `TurnError` |
| `orb-state-change` | string: `"idle"`, `"listening"`, `"thinking"`, `"speaking"`, `"responding"`, `"confirming"`, `"focusing"`, `"alarm"` o `"error"` | Al enviar (`thinking`), al escuchar (`listening`), al terminar (`idle`) |
| `connection-status` | `{"status": "disconnected" \| "connecting" \| "connected" \| "authenticated" \| "error", "error": "texto opcional"}` | Cada cambio de estado de la conexión |
| `update://progress` | número entero de 0 a 100 | Durante la descarga |
| `update://ready` | `{}` | Al terminar la descarga |
| `alarm-ring` | `{"label": "texto"}` | Opcional, fase posterior |

Nombres fuera de esta lista no se emiten.

## D. Reglas de seguridad

- Ningún evento, respuesta ni log contiene `sessionToken`, contraseñas ni `device_shared_secret`.
- El correo sí puede mostrarse en la interfaz (`auth.state`), porque la cuenta lo necesita.
- Las operaciones que no están en la tabla responden `unsupported_operation`.
