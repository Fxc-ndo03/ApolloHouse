# 08 · Verificación final

Todo lo de esta lista se ejecutó en este entorno. Las salidas completas están en `verificacion/`.

| Verificación | Resultado | Evidencia |
|---|---|---|
| Pruebas unitarias (bun): 44 de Windows, intactas, y 9 de traducción de Android | **53 de 53** | `verificacion/bt_def.log` |
| Compilación de tipos de la app completa contra los shims de Android | **0 errores** | `verificacion/tsc_def.log` |
| Compilación de tipos de Windows con el parche aplicado (solo los errores de tests que ya existían) | 7, igual que la línea base | `verificacion/tsc_patched.log` |
| Recorrido en navegador (Chromium, teléfono 412×915, modo oscuro): 19 comprobaciones | **19 de 19** | `verificacion/final_test_def.log` |
| Build de producción: sin el puente falso | Limpio (0 referencias) | `build-produccion/` |
| Build de Windows con el parche aplicado: sin el puente falso | Limpio | `verificacion/vb_patched.log` |
| Parche de Windows: 8 archivos, aplica limpio sobre una copia del original | OK | `windows/windows-ui-correcciones.patch` |
| Medidas de la barra inferior: ocupa el ancho y termina en el borde inferior | OK (851 + 64 = 915 px) | `verificacion/` |

## Lo que NO está verificado

- **Kotlin**: no hay Android SDK en este entorno. Nada de lo que debe hacer Kotlin se compiló ni se probó.
- **WebView real**: las pruebas usan Chromium y un puente falso que imita el protocolo.
- **Backend real**: no se hicieron llamadas. Login y chat reales no se probaron.
- **Dispositivo**: no se probó en un Moto G35 ni en ningún otro teléfono.
- **Voz**: no implementada en Kotlin.
- **Rendimiento del orbe WebGL**: no medido en hardware.
- **Modo claro**: las capturas son en oscuro. El modo claro usa las mismas reglas, pero no lo revisé visualmente.
- **Accesibilidad**: solo comprobé el contraste del botón secundario y el foco del campo.
