# MIGRATION-APOLLO-DEFAULT

Estado del plan: **diseñado y con el código de destino implementado**. Ejecución sobre datos reales: `NO VERIFICADO`.

## Situación

- Destino ya soportado por el código: `Apollo/acct:<accountId>` (`apolloObjectNameForAccount`).
- Origen: `Apollo/default` — sigue funcionando. Su identidad interna es `LEGACY_ACCOUNT_ID = acc_0000000000000000000000000000ffee`, con namespace de memoria propio (`mem:acc_000...ffee`), **distinto** de cualquier cuenta real: los datos legacy no se mezclan nunca silenciosamente.
- El job `index_memory` viejo (`deviceId: 'default'`) sigue parseando: el schema le asigna la cuenta legacy.

## Procedimiento (cuando se ejecute, en este orden)

1. **Snapshot**: copia del DO `Apollo/default` (exportar todas las tablas: `memories`, `thread_meta`, `session_prefs`, `list_items`, `pending_confirmations`, `mcp_tool_settings`, `pending_device_messages`) + conteos por tabla + hash SHA-256 por tabla. Guardar fuera del repo.
2. **Definir cuenta destino**: crear/identificar la `acc_...` del dueño. **No migrar a ciegas**: la memoria global es del dueño histórico del sistema; esa decisión es de producto.
3. **Copia** (no movimiento) hacia `Apollo/acct:<cuenta>`: reindexar Vectorize de `mem:acc_000...ffee` → `mem:<cuenta>` leyendo el `content` de cada vector; insertar filas SQL preservando ids y timestamps.
4. **Verificación**: conteos origen = destino por tabla; muestreo de memoria (`queryMemoryVectors` con la cuenta destino encuentra lo que la legacy tenía); turno de texto y voz en el DO nuevo; `Apollo/default` intacto (comparar hashes con el snapshot).
5. **Legacy read-only**: eliminar las rutas de escritura hacia `default`; conservar lectura.
6. **Retiro** (sólo tras un ciclo de verificación en producción): borrar `Apollo/default`. Punto de no retorno — requiere decisión explícita del dueño.

## Rollback

Hasta el paso 5 inclusive, rollback = eliminar el DO de cuenta y seguir usando `Apollo/default` (que nunca fue modificado ni borrado). Los vectores originales permanecen en su namespace hasta el retiro.

## Ventana de compatibilidad

Clientes legacy (secreto global) siguen aceptados durante toda la ventana (ya soportado por `readDeviceSecretFromRequest`). Criterio de retiro de compatibilidad: todos los dispositivos con credencial individual + fecha de corte anunciada + error accionable 401 con instrucción de re-enrolamiento.
