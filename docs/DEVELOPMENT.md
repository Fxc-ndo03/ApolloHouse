# Apollo — DEVELOPMENT

## Requisitos

| Herramienta | Versión | Para |
|---|---|---|
Rust | 1.98.1 | Cliente desktop (Tauri) |
Cargo | 1.98.1 | Build y tests Rust |
Bun | 1.3.14 | Worker, wizard, scripts |
JDK | 21 | Android |
Android SDK | compileSdk 36, minSdk 25 | App Android |
Gradle | 8.13 (wrapper) | Build Android |

## Tests

```bash
# Worker (rápido, ~30s)
cd apps/agent && bun run test

# Typecheck del Worker — 10 errores PREEXISTENTES, no atribuibles a cambios nuevos
cd apps/agent && bun run typecheck

# Paridad de contrato TypeScript <-> Kotlin
bun run test:mobile

# Android
cd apps/mobile && .\gradlew.bat testDebugUnitTest assembleDebug

# Cliente desktop
cd apps/desktop/src-tauri && cargo test --lib
```

### Estado actual verificado

| Suite | Resultado |
|---|---|
Worker | **1329 pass / 0 fail** |
Desktop (Rust) | **31 pass / 0 fail** |
Android | **149 pass / 0 fail** |
Paridad TS↔Kotlin | **75 pass / 0 fail** |
Typecheck Worker | 10 errores, **preexistentes** |

### Los 10 errores de typecheck preexistentes

En `runtime.ts`, `testing.ts`, `dollar.ts`, `gemini.spec.ts`, `workersai.ts`. **Ninguno** está en el camino de la conversación. Se verificaron presentes en `HEAD` antes de cualquier cambio.

## Estructura

```
apps/
  agent/     Worker: 32 dominios, 6 Durable Objects
  mobile/    Android: FGS, Keystore, conversación
  desktop/   Tauri: Rust (lógica) + React (UI)
  console/   Marketing + dashboard
  wizard/    Generador del starter
```

## Configuración local

`apps/agent/.dev.vars` — **nunca se versiona**. Plantilla en `.dev.vars.example`.

| Variable | Para | Sensible |
|---|---|---|
`GEMINI_API_KEY` | Conversación, STT, TTS, embeddings | **Sí** |
`DEVICE_SHARED_SECRET` | Secreto global del cliente legacy | **Sí** |
`DASHBOARD_SHARED_SECRET` | Challenge de enrollment | **Sí** |
`INTERNAL_CORE_TOKEN` | `/api/internal/*` | **Sí** |
`APOLLO_OWNER_EMAIL` | Identifica al dueño | No |
`GEMINI_*_MODEL` | Nombres de modelo | No |

Verificá siempre con `git check-ignore -v <archivo>` antes de stagear.

## Diagnóstico seguro

**Inspeccionar el estado de una sesión** (singleton, requiere rol operador):
```bash
curl "http://127.0.0.1:8799/agents/mobile-bridge/mobile/__inspect" \
     -H "X-Internal-Token: $INTERNAL_CORE_TOKEN"
```

**Nunca** loguees URLs de conexión con `?token=`: el secreto queda en los logs. El cliente nuevo ya no lo hace.

**Si una migración falla:** el secreto anterior nunca se borra antes de confirmar el nuevo. `resolve_migration` documenta esa regla y hay un test que falla si se rompe.

## Añadir una capacidad

1. Definí el contrato en `apps/agent/src/protocol/schema.ts`
2. Replicá la constante en `apps/mobile/.../contract/contract.kt`
3. `bun run test:mobile` falla si solo tocaste un lado
4. Implementá el tool en `apps/agent/src/tools/` con `safety: 'safe' | 'unsafe'`
5. Si es determinista, agregá el patrón en `voice/router.ts` **y su test**
6. Implementá la ejecución en el cliente (Android o `commands.rs`)

## Reglas del proyecto

- **Nombres largos y descriptivos.** Sin abreviaturas, sin variables de una letra.
- **Sin `any`, sin `as unknown as`, sin `!`** sobre datos no confiables.
- **Validá con zod** en el borde. `.strict()` rechaza campos extra.
- **Comentarios sólo para el *por qué*.** Los nombres explican el *qué*.
- **Archivos de una sola palabra.** Si necesita dos, es una carpeta.
- **Imports agrupados**: terceros primero, luego `@/`. Separados por línea en blanco.
- **Un concern por archivo.** Máximo ~300 líneas.

## Antes de commitear

```bash
cd apps/agent && bun run test          # 1329
cd apps/desktop/src-tauri && cargo test --lib  # 31
bun run test:mobile                     # 75
cd apps/mobile && .\gradlew.bat testDebugUnitTest  # 149
git status --porcelain                 # ¿hay artefactos?
```

`.gitignore` cubre `build/`, `target/`, `dist/`, `.gradle/`, `local.properties`, `*.apk`, `.dev.vars`.
