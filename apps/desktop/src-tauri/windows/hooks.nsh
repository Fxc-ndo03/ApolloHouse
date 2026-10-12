; Apollo Desktop - NSIS installer hooks (mecanismo estandar de Tauri).
;
; Registro en tauri.conf.json:
;   bundle.windows.nsis.installerHooks = "./windows/hooks.nsh"
;
; Por que existe este archivo:
;   El sidecar de Python (resources\python-runtime\python.exe -m juana_client.client)
;   mantiene abierto resources\python-runtime\Lib\site-packages\_cffi_backend.*.pyd
;   mientras Apollo esta en ejecucion. Sin cerrar el sidecar, NSIS no puede
;   reemplazar ese archivo y la reinstalacion falla.
;
;   NSIS_HOOK_PREINSTALL corre ANTES de copiar archivos (y antes del
;   CheckIfAppIsRunning del template oficial), asi que es el punto correcto
;   para liberar los handles. NSIS_HOOK_PREUNINSTALL hace lo mismo al
;   desinstalar.
;
;   El CheckIfAppIsRunning del template solo conoce al .exe principal
;   (Restart Manager sobre MAINBINARYNAME); el python huerfano del sidecar
;   NO lo detecta, por eso este hook lo cierra de forma especifica.
;
; Reglas de seguridad:
;   - NUNCA `taskkill /IM python.exe`: solo se terminan los procesos
;     python.exe/pythonw.exe cuyo command line contenga `juana_client.client`
;     (modulo exclusivo del sidecar de Apollo; ningun otro Python coincide).
;   - No se toca %APPDATA%\com.apollo.desktop: settings.json, secretos y
;     device_preferences.json sobreviven a la actualizacion (el template solo
;     borra appdata si el usuario marca la casilla Y no es un update).
;
; Notas NSIS:
;   - Dentro de este archivo, cada `$` literal de PowerShell se escribe `$$`.
;   - El script PowerShell usa solo comillas dobles para no chocar con las
;     comillas simples de las cadenas NSIS de FileWrite.
;   - nsExec::ExecToLog deja en la pila el exit code del proceso.
;   - El cuerpo vive en la macro APOLLO_CLOSE_BODY porque NSIS exige que una
;     funcion llamada desde el desinstalador empiece por "un.": existen dos
;     funciones (install y uninstall) que insertan el mismo cuerpo, sin
;     duplicar la logica.

!include "LogicLib.nsh"

Var ApolloCloseAttempts

!macro APOLLO_CLOSE_BODY
  StrCpy $ApolloCloseAttempts 0

  apollo_close_retry:
    IntOp $ApolloCloseAttempts $ApolloCloseAttempts + 1
    DetailPrint "Apollo: cerrando app y sidecar (intento $ApolloCloseAttempts/4)..."

    FileOpen $9 "$TEMP\apollo-close.ps1" w
    FileWrite $9 '$$ErrorActionPreference = "SilentlyContinue"$\r$\n'
    FileWrite $9 '# 1. App principal: CloseMainWindow es cierre limpio; Force solo si persiste.$\r$\n'
    FileWrite $9 '$$app = Get-Process -Name "Apollo Desktop","apollo-desktop" -ErrorAction SilentlyContinue$\r$\n'
    FileWrite $9 'if ($$app) {$\r$\n'
    FileWrite $9 '  $$app | ForEach-Object { $$_.CloseMainWindow() | Out-Null }$\r$\n'
    FileWrite $9 '  Start-Sleep -Seconds 3$\r$\n'
    FileWrite $9 '  $$app = Get-Process -Name "Apollo Desktop","apollo-desktop" -ErrorAction SilentlyContinue$\r$\n'
    FileWrite $9 '  if ($$app) { $$app | Stop-Process -Force -ErrorAction SilentlyContinue }$\r$\n'
    FileWrite $9 '}$\r$\n'
    FileWrite $9 '# 2. Sidecar: SOLO python con el command line de Apollo.$\r$\n'
    FileWrite $9 '$$killList = @()$\r$\n'
    FileWrite $9 '$$qa = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { ($$_.Name -eq "python.exe" -or $$_.Name -eq "pythonw.exe") -and $$_.CommandLine -like "*juana_client.client*" }$\r$\n'
    FileWrite $9 'if ($$qa) { $$killList += @($$qa) }$\r$\n'
    FileWrite $9 'if ($$killList.Count -gt 0) { $$killList | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue } }$\r$\n'
    FileWrite $9 '# 3. Espera a que Windows libere los handles del .pyd.$\r$\n'
    FileWrite $9 'Start-Sleep -Seconds 2$\r$\n'
    FileWrite $9 '$$remainingApp = 0$\r$\n'
    FileWrite $9 '$$checkApp = Get-Process -Name "Apollo Desktop","apollo-desktop" -ErrorAction SilentlyContinue$\r$\n'
    FileWrite $9 'if ($$checkApp) { $$remainingApp = @($$checkApp).Count }$\r$\n'
    FileWrite $9 '$$remainingSidecar = 0$\r$\n'
    FileWrite $9 '$$ra = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { ($$_.Name -eq "python.exe" -or $$_.Name -eq "pythonw.exe") -and $$_.CommandLine -like "*juana_client.client*" }$\r$\n'
    FileWrite $9 'if ($$ra) { $$remainingSidecar = @($$ra).Count }$\r$\n'
    FileWrite $9 'Write-Output ("APOLLO_CLOSE_REMAINING_APP=" + $$remainingApp)$\r$\n'
    FileWrite $9 'Write-Output ("APOLLO_CLOSE_REMAINING_SIDECAR=" + $$remainingSidecar)$\r$\n'
    FileWrite $9 'exit ($$remainingApp + $$remainingSidecar)$\r$\n'
    FileClose $9

    nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$TEMP\apollo-close.ps1"'
    Pop $0
    Delete "$TEMP\apollo-close.ps1"

    ${If} $0 == 0
      DetailPrint "Apollo: app y sidecar cerrados, handles liberados."
      Goto apollo_close_done
    ${EndIf}

    ${If} $ApolloCloseAttempts >= 4
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Apollo Desktop o su sidecar de Python siguen en ejecución y bloquean la instalación.$\n$\nPulse Reintentar para intentarlo de nuevo o Cancelar para salir del instalador." IDRETRY apollo_close_user_retry IDCANCEL apollo_close_abort
      apollo_close_user_retry:
        StrCpy $ApolloCloseAttempts 0
        Goto apollo_close_retry
      apollo_close_abort:
        Abort "Instalación cancelada: Apollo sigue en ejecución."
    ${Else}
      Sleep 2000
      Goto apollo_close_retry
    ${EndIf}

  apollo_close_done:
    Sleep 3000
!macroend

Function ApolloCloseActiveProcesses
  !insertmacro APOLLO_CLOSE_BODY
FunctionEnd

Function un.ApolloCloseActiveProcesses
  !insertmacro APOLLO_CLOSE_BODY
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  Call ApolloCloseActiveProcesses
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Call un.ApolloCloseActiveProcesses
!macroend
