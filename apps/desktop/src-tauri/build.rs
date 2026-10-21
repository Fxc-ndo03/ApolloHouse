//! Identidad de variante de la build, resuelta AL COMPILAR.
//!
//! La variante decide dos cosas que no pueden cambiar en runtime:
//! - el destino del Worker (staging vs produccion),
//! - el namespace del almacen seguro de credenciales.
//!
//! Se detect�� por la config de Tauri que el CLI esta usando: el build de
//! staging pasa `--config src-tauri/tauri.staging.conf.json`, cuyo
//! `identifier` es `com.apollo.desktop.staging`. `TAURI_CONFIG` lo inyecta el
//! propio CLI de Tauri, asi que no hay que pasarlo a mano ni acordarse.

/// Configuracion de Tauri del canal estable.
#[cfg(test)]
const STABLE_TAURI_CONFIG: &str = include_str!("tauri.conf.json");
/// Configuracion de Tauri del canal de pruebas.
const STAGING_TAURI_CONFIG: &str = include_str!("tauri.staging.conf.json");

/// `identifier` que identifica la build de staging.
const STAGING_IDENTIFIER: &str = "com.apollo.desktop.staging";

/// Extrae el campo `identifier` de una configuracion de Tauri.
///
/// Se busca a mano en vez de usar `serde_json`: los build scripts no tienen
/// las dependencias del crate, y anadir una seria cambiar el lockfile.
fn identifier_of(tauri_config: &str) -> Option<&str> {
    let needle = "\"identifier\"";
    let found = tauri_config.find(needle)?;
    let after = tauri_config[found + needle.len()..].trim_start();
    let after = after.strip_prefix(':')?.trim_start();
    let after = after.strip_prefix('"')?;
    let end = after.find('"')?;
    Some(&after[..end])
}

/// `true` si la config de Tauri en uso es la de staging.
///
/// Se decide por el `identifier` y no por el nombre del archivo: es el mismo
/// dato que Tauri usa para decidir el directorio de configuracion y el
/// instalador, asi que no puede quedar desincronizado con el resto.
fn is_staging_tauri_config(tauri_config: &str) -> bool {
    identifier_of(tauri_config) == Some(STAGING_IDENTIFIER)
}

/// `true` si esta build es la de staging.
///
/// La config de Tauri embebida decide; `TAURI_CONFIG` (lo que el CLI pasa
/// realmente) es la fuente de verdad y manda sobre la embebida.
fn is_staging_build() -> bool {
    if let Ok(config) = std::env::var("TAURI_CONFIG") {
        if !config.trim().is_empty() {
            return is_staging_tauri_config(&config);
        }
    }
    is_staging_tauri_config(STAGING_TAURI_CONFIG)
}

/// Destino del Worker segun la variante.
///
/// Es una **direccion**, no un secreto. Se compila dentro del binario para que
/// el mismo ejecutable no pueda cambiar de entorno en runtime ni volver a
/// produccion por accidente: un build de staging no tiene forma de apuntar a
/// produccion, y uno estable no tiene forma de apuntar a staging.
pub const PRODUCTION_WORKER_URL: &str =
    "wss://apollo.facupapollo.workers.dev/agents/apollo/default";
pub const STAGING_WORKER_URL: &str =
    "wss://apollo-staging.facupapollo.workers.dev/agents/apollo/default";

fn main() {
    let is_staging = is_staging_build();

    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
    println!("cargo:rerun-if-env-changed=APOLLO_CREDENTIAL_NAMESPACE");
    println!("cargo:rerun-if-env-changed=APOLLO_WORKER_URL");
    println!("cargo:rustc-check-cfg=cfg(apollo_staging)");
    if is_staging {
        println!("cargo:rustc-cfg=apollo_staging");
        // Keep staging credentials isolated even when the build is invoked
        // through Tauri CLI without the caller manually setting this variable.
        println!("cargo:rustc-env=APOLLO_CREDENTIAL_NAMESPACE=:staging");
        // El destino del Worker se congela tambien: una build de staging
        // arranca apuntando a staging, nunca a produccion. Esto es lo que
        // evita que el fallback silencioso de `state.rs` termine en produccion.
        println!("cargo:rustc-env=APOLLO_WORKER_URL={STAGING_WORKER_URL}");
        println!("cargo:warning=Apollo staging build: isolating the WebView2 profile and the Worker destination");
    } else {
        // Una build estable conserva su host de produccion. Se emite igual
        // (y no se deja el default por la rama `None`) para que el valor
        // compilado sea explicito y no dependa de un default implicito.
        println!("cargo:rustc-env=APOLLO_WORKER_URL={PRODUCTION_WORKER_URL}");
    }

    tauri_build::build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_config_embebida_de_staging_se_reconoce() {
        assert_eq!(identifier_of(STAGING_TAURI_CONFIG), Some(STAGING_IDENTIFIER));
        assert!(is_staging_tauri_config(STAGING_TAURI_CONFIG));
        assert!(!is_staging_tauri_config(STABLE_TAURI_CONFIG));
    }

    #[test]
    fn una_config_ilegible_no_se_toma_por_staging() {
        // Ante la duda, se trata como estable: nunca se abre una via a
        // produccion por una config que no se pudo leer.
        assert!(!is_staging_tauri_config("no es json"));
        assert!(!is_staging_tauri_config("{}"));
    }

    #[test]
    fn los_destinos_son_distintos_y_no_se_parecen() {
        assert_ne!(PRODUCTION_WORKER_URL, STAGING_WORKER_URL);
        assert!(PRODUCTION_WORKER_URL.contains("apollo.facupapollo.workers.dev"));
        assert!(!PRODUCTION_WORKER_URL.contains("apollo-staging"));
        assert!(STAGING_WORKER_URL.contains("apollo-staging.facupapollo.workers.dev"));
        assert!(!STAGING_WORKER_URL.contains("wss://apollo.facupapollo"));
    }
}
