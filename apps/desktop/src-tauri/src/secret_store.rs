//! Almacenamiento del secreto global en Windows Credential Manager.
//!
//! Antes el secreto vivÃƒ­a en el JSON de preferencias, en texto plano. Eso lo
//! dejaba legible para cualquier proceso del usuario y lo exponÃƒ­a en copias de
//! seguridad, en logs de diagnÃƒ³stico y en un archivo que se sube sin querer.
//!
//! Credential Manager lo cifra con la DPAPI del usuario de Windows: solo este
//! usuario, en esta mÃƒ¡quina, puede leerlo. Es la API nativa del sistema para
//! esto, y ya estaba disponible en la crate `windows` que el proyecto usa: solo
//! faltaba activar el feature `Win32_Security_Credentials`.
//!
//! ## Identidad no es secreto
//!
//! `installation_id` sigue en el JSON de preferencias. Es un identificador
//! pÃƒºblico que el dueÃƒ±o necesita leer para autorizar esta instalaciÃƒ³n, y meterlo
//! en un almacÃƒ©n cifrado harÃƒ­a imposible mostrarlo en la interfaz de vinculaciÃƒ³n.
//!
//! ## MigraciÃƒ³n sin cortar la conexiÃƒ³n
//!
//! Al cargar: si Credential Manager no tiene nada pero el JSON sÃƒ­, se copia el
//! JSON al almacÃƒ©n. El secreto **no se borra del JSON** hasta que se confirme la
//! escritura, y ni siquiera despuÃƒ©s de forma automÃƒ¡tica: se conserva para que un
//! rollback manual sea posible.

/// Nombre de la entrada en Credential Manager.
///
/// Se prefija con el nombre de la app para no colisionar con otras entradas
/// del mismo usuario de Windows.
pub const CREDENTIAL_TARGET_PREFIX: &str = "ApolloDesktop:device-shared-secret";
pub const SESSION_TARGET_PREFIX: &str = "ApolloDesktop:account-session";

/// Sufijo de namespace del almacen seguro, elegido AL COMPILAR.
///
/// Sin `APOLLO_CREDENTIAL_NAMESPACE` el nombre es exactamente el de siempre, asi
/// que una instalacion normal no cambia de comportamiento. Un build de staging
/// compila con `APOLLO_CREDENTIAL_NAMESPACE=":staging"` y entonces sus entradas
/// en Credential Manager son `ApolloDesktop:staging:...`: no lee la sesion de
/// produccion ni escribe sobre ella, y un logout de staging solo borra lo suyo.
pub fn credential_namespace_suffix() -> &'static str {
    match option_env!("APOLLO_CREDENTIAL_NAMESPACE") {
        Some(suffix) if !suffix.trim().is_empty() => suffix,
        _ => "",
    }
}

/// Sufijo de namespace para una variante concreta.
///
/// Es la misma regla que `credential_namespace_suffix`, pero con la variante
/// como parametro: asi la suite puede comprobar el aislamiento de las DOS
/// variantes en una sola corrida, sin depender de con que se compilo.
pub const fn namespace_suffix_for(variant: crate::state::Variant) -> &'static str {
    match variant {
        crate::state::Variant::Staging => ":staging",
        crate::state::Variant::Stable => "",
    }
}

/// Nombre de la entrada de credenciales para una variante concreta.
pub fn credential_target_prefix_for(variant: crate::state::Variant) -> String {
    format!(
        "ApolloDesktop{}:device-shared-secret",
        namespace_suffix_for(variant)
    )
}

/// Nombre de la entrada de sesion para una variante concreta.
pub fn session_target_prefix_for(variant: crate::state::Variant) -> String {
    format!(
        "ApolloDesktop{}:account-session",
        namespace_suffix_for(variant)
    )
}

pub fn credential_target_prefix() -> String {
    format!("ApolloDesktop{}:device-shared-secret", credential_namespace_suffix())
}

pub fn session_target_prefix() -> String {
    format!("ApolloDesktop{}:account-session", credential_namespace_suffix())
}

const CREDENTIAL_USER: &str = "apollo";

/// Resultado de una operaciÃƒ³n sobre el almacÃƒ©n seguro.
///
/// Se distingue "ausente" de "error" porque significan cosas distintas para
/// quien migra: ausente es el caso normal de una instalaciÃƒ³n nueva, y error
/// puede ser que Credential Manager no estÃƒ© disponible.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecretStoreOutcome {
    /// La operaciÃƒ³n terminÃƒ³ bien.
    Ok,
    /// No hay nada guardado todavÃƒ­a.
    Absent,
    /// El almacÃƒ©n no respondiÃƒ³. Se conserva el valor anterior.
    Unavailable(String),
}

/// Resultado de lectura: `Ok(valor)` existe, `Err(Absent)` no hay nada.
pub type SecretStoreOutcomeResult<T> = Result<T, SecretStoreOutcome>;

#[cfg(target_os = "windows")]
fn to_wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
pub fn store_device_secret(secret: &str) -> SecretStoreOutcome {
    write_credential(&credential_target_prefix(), secret)
}

#[cfg(target_os = "windows")]
fn write_credential(target: &str, secret: &str) -> SecretStoreOutcome {
    use windows::Win32::Security::Credentials::{
        CredDeleteW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };

    if secret.is_empty() {
        return remove_credential(target);
    }

    let mut target_wide = to_wide(target);
    let mut user_wide = to_wide(CREDENTIAL_USER);
    let mut secret_bytes: Vec<u8> = secret.as_bytes().to_vec();

    let mut credential: CREDENTIALW = unsafe { std::mem::zeroed() };
    credential.Type = CRED_TYPE_GENERIC;
    credential.TargetName = windows::core::PWSTR(target_wide.as_mut_ptr());
    credential.CredentialBlobSize = secret_bytes.len() as u32;
    credential.CredentialBlob = secret_bytes.as_mut_ptr();
    credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
    credential.UserName = windows::core::PWSTR(user_wide.as_mut_ptr());

    if unsafe { CredWriteW(&credential, 0) }.is_ok() {
        SecretStoreOutcome::Ok
    } else {
        let code = windows::core::HRESULT::from_win32(windows::Win32::Foundation::WIN32_ERROR(0).0).0;
        SecretStoreOutcome::Unavailable(format!("CredWriteW fallo: {code}"))
    }
}

#[cfg(target_os = "windows")]
fn read_credential(target: &str) -> SecretStoreOutcomeResult<String> {
    use windows::Win32::Security::Credentials::{
        CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC,
    };

    let mut target_wide = to_wide(target);
    let mut credential: *mut CREDENTIALW = std::ptr::null_mut();

    let read_result = unsafe {
        CredReadW(
            windows::core::PWSTR(target_wide.as_mut_ptr()),
            CRED_TYPE_GENERIC,
            None,
            &mut credential,
        )
    };
    if read_result.is_err() {
        return Err(SecretStoreOutcome::Absent);
    }

    let blob_size = unsafe { (*credential).CredentialBlobSize } as usize;
    let blob_pointer = unsafe { (*credential).CredentialBlob };
    let secret = if blob_pointer.is_null() {
        String::new()
    } else {
        let bytes = unsafe { std::slice::from_raw_parts(blob_pointer, blob_size) };
        String::from_utf8_lossy(bytes).to_string()
    };
    unsafe {
        CredFree(credential as *const core::ffi::c_void);
    }
    Ok(secret)
}

#[cfg(target_os = "windows")]
fn remove_credential(target: &str) -> SecretStoreOutcome {
    use windows::Win32::Security::Credentials::{CredDeleteW, CRED_TYPE_GENERIC};

    let mut target_wide = to_wide(target);
    let _ = unsafe {
        CredDeleteW(windows::core::PWSTR(target_wide.as_mut_ptr()), CRED_TYPE_GENERIC, None)
    };
    SecretStoreOutcome::Ok
}

#[cfg(target_os = "windows")]
pub fn read_device_secret() -> SecretStoreOutcomeResult<String> {
    read_credential(&credential_target_prefix())
}

#[cfg(target_os = "windows")]
pub fn delete_device_secret() -> SecretStoreOutcome {
    use windows::Win32::Security::Credentials::{CredDeleteW, CRED_TYPE_GENERIC};

    let mut target_wide = to_wide(&credential_target_prefix());
    let _ = unsafe {
        CredDeleteW(windows::core::PWSTR(target_wide.as_mut_ptr()), CRED_TYPE_GENERIC, None)
    };
    // Borrar algo que no existe no es un error que deba molestar al usuario.
    SecretStoreOutcome::Ok
}

/// En plataformas sin Credential Manager no hay almacÃƒ©n seguro.
///
/// No se degrada a texto plano a propÃƒ³sito: si el almacÃƒ©n no existe, el secreto
/// no tiene dÃƒ³nde ir y el cliente debe fallar cerrado en vez de escribirlo en un
/// archivo que nadie eligiÃƒ³ proteger.
#[cfg(not(target_os = "windows"))]
pub fn store_device_secret(_secret: &str) -> SecretStoreOutcome {
    SecretStoreOutcome::Unavailable("Credential Manager solo existe en Windows".to_string())
}

#[cfg(not(target_os = "windows"))]
pub fn read_device_secret() -> SecretStoreOutcomeResult<String> {
    Err(SecretStoreOutcome::Absent)
}

#[cfg(not(target_os = "windows"))]
pub fn delete_device_secret() -> SecretStoreOutcome {
    SecretStoreOutcome::Ok
}

#[cfg(target_os = "windows")]
pub fn store_session_token(token: &str) -> SecretStoreOutcome {
    write_credential(&session_target_prefix(), token)
}

#[cfg(target_os = "windows")]
pub fn read_session_token() -> SecretStoreOutcomeResult<String> {
    read_credential(&session_target_prefix())
}

#[cfg(target_os = "windows")]
pub fn delete_session_token() -> SecretStoreOutcome {
    remove_credential(&session_target_prefix())
}

#[cfg(not(target_os = "windows"))]
pub fn store_session_token(_token: &str) -> SecretStoreOutcome {
    SecretStoreOutcome::Unavailable("Credential Manager solo existe en Windows".to_string())
}

#[cfg(not(target_os = "windows"))]
pub fn read_session_token() -> SecretStoreOutcomeResult<String> {
    Err(SecretStoreOutcome::Absent)
}

#[cfg(not(target_os = "windows"))]
pub fn delete_session_token() -> SecretStoreOutcome {
    SecretStoreOutcome::Ok
}

/// Traduce un resultado de escritura al valor que queda vigente.
///
/// La regla de migraciÃƒ³n es una sola y no es negociable: **el secreto anterior
/// no se borra hasta que el nuevo estÃƒ© confirmado como escrito**. Si la
/// escritura falla, el valor antiguo sigue siendo la fuente y el cliente puede
/// seguir conectÃƒ¡ndose.
pub fn resolve_migration(json_secret: &str, store_outcome: &SecretStoreOutcome) -> String {
    match store_outcome {
        SecretStoreOutcome::Ok | SecretStoreOutcome::Absent | SecretStoreOutcome::Unavailable(_) => {
            // En los tres casos el valor vigente es el del JSON. Cambiarlo sin
            // confirmar la escritura dejarÃƒ­a al usuario sin conexiÃƒ³n.
            json_secret.to_string()
        }
    }
}

/// Decide de dÃƒ³nde leer el secreto al arrancar.
///
/// El almacÃƒ©n seguro es la fuente preferida. Si estÃƒ¡ vacÃƒ­o y el JSON tiene algo,
/// se migra: se escribe en el almacÃƒ©n y se conserva el JSON como respaldo para
/// que un rollback sea posible.
pub fn load_effective_secret(json_secret: &str) -> String {
    match read_device_secret() {
        Ok(stored) if !stored.is_empty() => stored,
        _ => {
            if !json_secret.is_empty() {
                // MigraciÃƒ³n. El resultado se ignora a propÃƒ³sito: si la escritura
                // falla, el JSON sigue siendo vÃƒ¡lido y el cliente conecta igual.
                let _ = store_device_secret(json_secret);
            }
            json_secret.to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::Variant;

    #[test]
    fn el_nombre_de_entrada_no_colisiona_con_otras_apps() {
        assert!(credential_target_prefix().starts_with("Apollo"));
        assert!(credential_target_prefix().contains(':'));
    }

    // FASE 2.12: el namespace del almacen seguro se resuelve al compilar.
    #[test]
    fn el_namespace_es_el_de_la_build_actual() {
        let expected = match option_env!("APOLLO_CREDENTIAL_NAMESPACE") {
            Some(suffix) if !suffix.trim().is_empty() => suffix,
            _ => "",
        };
        assert_eq!(credential_namespace_suffix(), expected);
        if expected.is_empty() {
            // Build normal: los nombres son los de siempre, byte a byte.
            assert_eq!(credential_target_prefix(), CREDENTIAL_TARGET_PREFIX);
            assert_eq!(session_target_prefix(), SESSION_TARGET_PREFIX);
        } else {
            // Build de staging: nunca toca las entradas de produccion.
            assert_ne!(credential_target_prefix(), CREDENTIAL_TARGET_PREFIX);
            assert_ne!(session_target_prefix(), SESSION_TARGET_PREFIX);
            assert!(session_target_prefix().contains("staging"));
        }
    }

    #[test]
    fn los_targets_nunca_llevan_un_secreto() {
        for target in [credential_target_prefix(), session_target_prefix()] {
            let lowered = target.to_lowercase();
            assert!(!lowered.contains("token="));
            assert!(!lowered.contains("bearer"));
        }
    }

    #[test]
    fn una_escritura_fallida_conserva_el_secreto_anterior() {
        // El criterio de aceptaciÃƒ³n: si el almacÃƒ©n no responde, el usuario no
        // debe quedarse sin conexiÃƒ³n por una reparaciÃƒ³n mal hecha.
        let previous = "secreto-que-funcionaba";
        let outcome = SecretStoreOutcome::Unavailable("CredWriteW fallo".to_string());
        assert_eq!(resolve_migration(previous, &outcome), previous);
    }

    #[test]
    fn una_escritura_exitosa_conserva_el_valor_vigente() {
        let previous = "secreto-que-funcionaba";
        assert_eq!(resolve_migration(previous, &SecretStoreOutcome::Ok), previous);
    }

    #[test]
    fn un_secreto_ausente_no_inventa_uno_nuevo() {
        // Nunca se genera un secreto: serÃƒ­a una credencial que el Worker no
        // conoce y dejarÃƒ­a al cliente sin poder conectar.
        assert_eq!(resolve_migration("", &SecretStoreOutcome::Absent), "");
    }

    #[test]
    fn en_plataformas_sin_almacen_se_falla_cerrado() {
        // Fuera de Windows no se cae de vuelta a texto plano.
        #[cfg(not(target_os = "windows"))]
        {
            assert!(matches!(
                store_device_secret("cualquiera"),
                SecretStoreOutcome::Unavailable(_)
            ));
            assert!(matches!(
                read_device_secret(),
                Err(SecretStoreOutcome::Absent)
            ));
        }
    }


    // ----------------------------------------------------------------
    // Aislamiento de credenciales entre variantes.
    //
    // La pregunta que estos tests contestan: staging y produccion
    // comparten la MISMA credencial activa? La respuesta es que no, y
    // estos tests lo fijan para que no se rompa por accidente.
    // ----------------------------------------------------------------

    #[test]
    fn staging_y_produccion_no_comparten_el_secreto_de_dispositivo() {
        let estable = credential_target_prefix_for(Variant::Stable);
        let staging = credential_target_prefix_for(Variant::Staging);
        assert_ne!(estable, staging);
        assert_eq!(estable, CREDENTIAL_TARGET_PREFIX);
        assert!(staging.contains("staging"));
        // La entrada de staging no puede ser la de produccion: si lo fuera,
        // un build de staging escribiria y leeria el secreto de produccion.
        assert_ne!(staging, CREDENTIAL_TARGET_PREFIX);
    }

    #[test]
    fn staging_y_produccion_no_comparten_la_sesion_de_cuenta() {
        let estable = session_target_prefix_for(Variant::Stable);
        let staging = session_target_prefix_for(Variant::Staging);
        assert_ne!(estable, staging);
        assert_eq!(estable, SESSION_TARGET_PREFIX);
        assert_ne!(staging, SESSION_TARGET_PREFIX);
        assert!(staging.contains("staging"));
    }

    #[test]
    fn el_nombre_de_esta_build_coincide_con_su_variante() {
        // El namespace que usa ESTE binario es el de su variante: no hay
        // una bandera independiente que pueda desincronizarse.
        let esperado = namespace_suffix_for(Variant::current());
        assert_eq!(credential_namespace_suffix(), esperado);
        assert_eq!(
            credential_target_prefix(),
            credential_target_prefix_for(Variant::current())
        );
        assert_eq!(
            session_target_prefix(),
            session_target_prefix_for(Variant::current())
        );
    }

    #[test]
    fn una_build_de_staging_nunca_toca_las_entradas_de_produccion() {
        if !crate::state::is_staging_build() {
            return;
        }
        assert_ne!(credential_target_prefix(), CREDENTIAL_TARGET_PREFIX);
        assert_ne!(session_target_prefix(), SESSION_TARGET_PREFIX);
    }

    #[test]
    fn los_targets_aislados_no_llevan_un_secreto() {
        for variant in [Variant::Stable, Variant::Staging] {
            for target in [
                credential_target_prefix_for(variant),
                session_target_prefix_for(variant),
            ] {
                let lowered = target.to_lowercase();
                assert!(!lowered.contains("token="));
                assert!(!lowered.contains("bearer"));
            }
        }
    }

}
