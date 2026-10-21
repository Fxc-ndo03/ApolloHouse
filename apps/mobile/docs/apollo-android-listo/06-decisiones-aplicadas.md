# 06 · Decisiones aplicadas (y cuáles siguen pendientes)

Apliqué por defecto las decisiones que son de estética y de alcance, porque me pediste que yo resolviera lo visual. Todo lo que cambia el código de Windows está marcado. Si alguna no te gusta, se revierte en un paso.

| # | Decisión | Aplicado | Dónde | Estado |
|---|---|---|---|---|
| 1 | Modelo visual: Windows (cian, modo claro u oscuro según el sistema) reemplaza la paleta lavanda | Sí | UI compartida | Pedido por ti |
| 2 | Navegación en teléfono: barra inferior con Inicio, Chat y Configuración | Sí | Capa Android (`android.css`) | Por defecto. Cambiable |
| 3 | Sin controles de ventana (minimizar, maximizar, cerrar). Se conserva el punto de estado | Sí | Capa Android | Por defecto |
| 4 | Funciones de PC ocultas en Android: Worker y dispositivos (incluye el secreto de dispositivo), Sistema (en Android la sección se llama "Aplicación"), campos de dispositivo de audio, palabras de activación y Vosk | Sí | Compartido, con `isAndroidPlatform()`. En escritorio no cambia nada | Por defecto |
| 5 | Tipografía Inter en ambas plataformas, para que el texto se vea igual | Sí | Compartido. **Cambia Windows** | Por defecto. Incluido en el parche |
| 6 | Idioma: hoy se mezclan español (navegación, chat) e inglés (acceso, onboarding) | **No** | — | **Pendiente: decisión tuya** |
| 7 | Defectos: botón secundario de acceso con bajo contraste (ahora 17:1 en oscuro) y contorno de foco rectangular en el campo del chat | Sí | Compartido. **Cambia Windows** | Por defecto. Incluido en el parche |
| 8 | Streaming de respuestas. Windows muestra texto por fragmentos | **No** | — | Pendiente. Hoy la respuesta llega completa, en un solo fragmento |
| 9 | La contraseña viaja de JavaScript a Kotlin en `auth.login` y `auth.register` | Se mantiene | Protocolo | Condición en el prompt: no se registra ni se persiste en JS |
| 10 | Canal de eventos Android → interfaz (`window.__apolloEvent`) | Lado JS hecho | `nativeBridge.ts` | Kotlin debe emitir (prompt, T4) |
| 11 | Ajustes persistidos: solo 6 campos. `device_shared_secret` nunca se lee ni se escribe | Sí en la capa web | `settingsDefaults.ts`, `commandMap.ts` | Kotlin debe persistir (prompt, T3) |
| 12 | Actualizaciones: la capa web traduce los estados internos al contrato compartido con Windows | Traducción hecha | `commandMap.ts` | Kotlin debe devolver el contrato directo (prompt, T3) |
| 13 | Voz: reconocimiento en el dispositivo con `SpeechRecognizer`, iniciado solo por el usuario, sin palabra de activación | Supuesto | Prompt, T3 | **Confirma o cambia** |
| 14 | Retirar la sonda de depuración `DIAG_PROBE` | Pedido | Prompt, T2 | Pendiente en Kotlin |

## Lo que agregué además

- Botón atrás de Android integrado: `window.__apolloBack()` vuelve de Chat a Inicio. Si ya está en Inicio, Android cierra la app.
- Estado de conexión: `connection-status` actualiza el punto de estado de la barra superior.
- Operación nueva `updates.install`, para el botón de instalar actualización.
- Si el puente aún no implementa `settings.read`, la página de ajustes carga con valores por defecto en vez de quedar en "Cargando configuración…".
