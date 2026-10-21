//! FASE 3.1 — Núcleo de actualizaciones de Apollo Desktop.
//!
//! Separa la **decisión** (qué versión instalar, de qué canal, si es segura)
//! del **mecanismo** (el plugin oficial `tauri-plugin-updater`, que valida la
//! firma minisign del artefacto). Así la lógica se testea sin red ni WebView y
//! la app nunca puede instalar algo que no venga del canal correcto.
//!
//! Reglas duras, implementadas abajo:
//!   - Una app de staging jamás instala una versión de producción, ni al revés.
//!   - Una versión más antigua que la instalada nunca se considera.
//!   - La firma la verifica el plugin oficial; el hash NO sustituye la firma.
//!   - Ningún secreto de GitHub o Cloudflare entra en el binario: los
//!     manifiestos son públicos y se leen por HTTPS.

use serde::{Deserialize, Serialize};

/// Canal de distribución compilado en el binario.
///
/// Se resuelve AL COMPILAR, igual que el destino del Worker: una app de
/// staging no puede cambiar de canal en runtime.
pub const fn distribution_channel() -> &'static str {
    match option_env!("APOLLO_UPDATE_CHANNEL") {
        Some(channel) => channel,
        None => "stable",
    }
}

/// `true` sólo si este binario es una build de staging.
pub const fn is_staging_channel() -> bool {
    // `match` en const fn: `==` sobre cadenas no es const en este toolchain.
    let bytes = distribution_channel().as_bytes();
    let expected = b"staging";
    if bytes.len() != expected.len() {
        return false;
    }
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != expected[index] {
            return false;
        }
        index += 1;
    }
    true
}

/// Manifiesto de actualización que consume esta app.
///
/// Es el `latest.json` del plugin oficial de Tauri, más los campos de canal y
/// compatibilidad que el proyecto necesita para separar staging de estable.
///
/// FASE 3.2 — forma de `platforms`: **mapa por target**, no lista. Es lo que
/// deserializa `RemoteReleaseInner::Static` del plugin (HashMap<String,
/// ReleaseManifestPlatform>); con un array el plugin respondería
/// `TargetNotFound` y nunca encontraría su artefacto. La clave es
/// `windows-x86_64` (ver `target()` del plugin: `windows` + `x86_64`).
///
/// El plugin ignora los campos extra (`channel`, `notes`, `versionCode`…), así
/// que las reglas propias viven en el mismo archivo sin romperlo.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct UpdateManifest {
    pub version: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default = "default_channel")]
    pub channel: String,
    #[serde(default)]
    pub pub_date: String,
    /// Target de Tauri -> artefacto. Para este proyecto: `windows-x86_64`.
    #[serde(default)]
    pub platforms: std::collections::BTreeMap<String, PlatformEntry>,
    /// `versionCode` de Android cuando el manifiesto es compartido; 0 si no aplica.
    ///
    /// FASE 3.4: el `rename` importa. Sin él, serde busca `version_code` y el
    /// `versionCode` del JSON se ignoraba en silencio.
    #[serde(rename = "versionCode", alias = "version_code", default)]
    pub version_code: u64,
    /// `versionCode` mínimo del cliente que puede instalar este artefacto.
    #[serde(rename = "minClientVersionCode", alias = "min_client_version_code", default)]
    pub min_client_version_code: u64,
    /// Tamaño en bytes y SHA-256 del artefacto principal, para verificar
    /// integridad de descarga antes de instalar.
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub sha256: String,
}

fn default_channel() -> String {
    "stable".to_string()
}

/// Target oficial del plugin para Windows de 64 bits.
pub const WINDOWS_TARGET: &str = "windows-x86_64";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct PlatformEntry {
    pub signature: String,
    pub url: String,
    /// Lo calcula el pipeline de publicación. El plugin no lo exige (valida la
    /// firma); sirve para que un cliente pueda verificar integridad antes de
    /// instalar y para detectar una release corrupta.
    #[serde(default)]
    pub hash: String,
}

/// Versión `x.y.z` (opcional prefijo `v`), comparable numéricamente.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SemVer {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
}

impl SemVer {
    pub fn parse(text: &str) -> Option<Self> {
        let trimmed = text.trim();
        let without_prefix = trimmed.strip_prefix('v').unwrap_or(trimmed);
        let core = without_prefix
            .split(['-', '+'])
            .next()
            .unwrap_or(without_prefix);
        let mut parts = core.split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next().unwrap_or("0").parse().ok()?;
        let patch = parts.next().unwrap_or("0").parse().ok()?;
        Some(Self {
            major,
            minor,
            patch,
        })
    }
}

impl PartialOrd for SemVer {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for SemVer {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        (self.major, self.minor, self.patch).cmp(&(other.major, other.minor, other.patch))
    }
}

/// Por qué no se instala una actualización.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateRejection {
    /// El manifiesto no se pudo entender.
    ManifestInvalido(String),
    /// Venía del canal equivocado: aquí está el aislamiento entre entornos.
    CanalDistinto { esperado: String, recibido: String },
    /// La versión publicada no es más nueva que la instalada.
    NoEsMasNueva {
        instalada: String,
        publicada: String,
    },
    /// El cliente es demasiado viejo para este artefacto.
    ClienteAntiguo {
        minimo: u64,
        actual: u64,
    },
    /// La URL no es HTTPS: un update firmado sigue necesitándolo.
    UrlInsegura(String),
    /// No hay artefacto para Windows x64 en el manifiesto.
    SinArtefactoWindows,
    /// FASE 3.4 — el manifiesto auditado no describe la MISMA actualización que
    /// obtuvo el plugin oficial. Sin esta comprobación, un manifiesto que
    /// cambia entre la consulta y la instalación podría autorizar una versión
    /// distinta de la que el usuario vio.
    VersionDistinta {
        del_plugin: String,
        del_manifiesto: String,
    },
    /// La entrada de Windows no trae firma. No se ofrece: el plugin la exige y
    /// fallaría después de prometer una descarga.
    FirmaAusente,
}

/// Verificación de seguridad previa a descargar o instalar.
///
/// Deliberadamente **no** toca el hash: la autenticidad la garantiza la firma
/// minisign que valida el plugin oficial. Aquí se decide si vale la pena
/// siquiera descargar.
pub fn evaluate_update(
    installed_version: &str,
    installed_version_code: u64,
    manifest: &UpdateManifest,
    channel: &str,
) -> Result<UpdateDecision, UpdateRejection> {
    let installed = SemVer::parse(installed_version).ok_or_else(|| {
        UpdateRejection::ManifestInvalido(format!(
            "la version instalada no es semver: {installed_version}"
        ))
    })?;
    let published = SemVer::parse(&manifest.version)
        .ok_or_else(|| UpdateRejection::ManifestInvalido(manifest.version.clone()))?;

    // Aislamiento entre entornos: esto es lo que impide que una app de staging
    // instale producción o al revés, aunque alguien apunte mal el manifiesto.
    if !manifest.channel.eq_ignore_ascii_case(channel) {
        return Err(UpdateRejection::CanalDistinto {
            esperado: channel.to_string(),
            recibido: manifest.channel.clone(),
        });
    }

    if published <= installed {
        return Err(UpdateRejection::NoEsMasNueva {
            instalada: installed_version.to_string(),
            publicada: manifest.version.clone(),
        });
    }

    // `versionCode` es un concepto de ANDROID. El cliente de escritorio no tiene
    // uno, y por eso su llamada pasa 0: "no aplica". Aplicar el gate con 0
    // haría que Windows rechazara su propia actualización en cuanto el
    // manifiesto trajera un `minClientVersionCode`.
    if installed_version_code > 0 && installed_version_code < manifest.min_client_version_code {
        return Err(UpdateRejection::ClienteAntiguo {
            minimo: manifest.min_client_version_code,
            actual: installed_version_code,
        });
    }

    let entry = manifest
        .platforms
        .get(WINDOWS_TARGET)
        .ok_or(UpdateRejection::SinArtefactoWindows)?;

    if !entry.url.starts_with("https://") {
        return Err(UpdateRejection::UrlInsegura(entry.url.clone()));
    }

    Ok(UpdateDecision {
        version: manifest.version.clone(),
        notes: manifest.notes.clone(),
        pub_date: manifest.pub_date.clone(),
        download_url: entry.url.clone(),
        expected_signature: entry.signature.clone(),
        expected_hash: entry.hash.clone(),
        size: manifest.size,
        sha256: manifest.sha256.clone(),
    })
}

/// Un artefacto es el de Windows x64 si el mapa trae ese target.
///
/// Se busca por clave y no por nombre de archivo a propósito: es exactamente
/// como el plugin resuelve su plataforma, así que si esto coincide, coincide el
/// updater real.
pub fn is_windows_x64_artifact(manifest: &UpdateManifest) -> bool {
    manifest.platforms.contains_key(WINDOWS_TARGET)
}

/// Lo que hay que instalar, ya validado.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateDecision {
    pub version: String,
    pub notes: String,
    pub pub_date: String,
    pub download_url: String,
    pub expected_signature: String,
    pub expected_hash: String,
    pub size: u64,
    pub sha256: String,
}

// ---------------------------------------------------------------------------
// FASE 3.4 (C2) — auditoría real del manifiesto del canal.
//
// Antes, `read_manifest_for_audit()` devolvía SIEMPRE `Err` y ese error se
// descartaba (`Err(_) => None`), de modo que la comprobación de canal y de
// versión no llegaba a ejecutarse nunca, y el camino de instalación ni siquiera
// la intentaba. Lo de abajo cierra eso.
//
// IMPORTANTE Y DELIBERADO: leer el manifiesto NO autentica su origen. La
// autenticidad del artefacto sigue siendo exclusivamente la firma minisign que
// valida el plugin oficial de Tauri al descargar. La auditoría sólo responde a
// "¿este manifiesto es del canal que me corresponde y describe la versión que
// el plugin me ofreció?".
// ---------------------------------------------------------------------------

/// Canal estable.
pub const CHANNEL_STABLE: &str = "stable";
/// Canal de pruebas.
pub const CHANNEL_STAGING: &str = "staging";

/// Sufijos que el endpoint DEBE terminar en cada canal. Son la Expectations del
/// test de coherencia: si alguien cambia la URL en `tauri.conf.json` sin querer,
/// la suite cae en vez de publicar a un destino raro.
pub const EXPECTED_STABLE_ENDPOINT_SUFFIX: &str = "releases/latest/download/latest.json";
pub const EXPECTED_STAGING_ENDPOINT_SUFFIX: &str = "releases/download/staging/latest.json";

/// Configuraciones reales de Tauri, embebidas al compilar.
///
/// El endpoint de la auditoría sale de AQUÍ, no de una constante escrita a mano:
/// no puede desviarse de lo que el plugin oficial va a usar, porque es el mismo
/// archivo del que Tauri lee la configuración al empaquetar.
const STABLE_TAURI_CONFIG: &str = include_str!("../tauri.conf.json");
const STAGING_TAURI_CONFIG: &str = include_str!("../tauri.staging.conf.json");

/// Extrae el endpoint del updater de una configuración de Tauri.
pub fn endpoint_from_tauri_config(config_json: &str) -> Result<String, String> {
    let value: serde_json::Value =
        serde_json::from_str(config_json).map_err(|error| format!("configuracion de Tauri ilegible: {error}"))?;
    let endpoint = value
        .get("plugins")
        .and_then(|plugins| plugins.get("updater"))
        .and_then(|updater| updater.get("endpoints"))
        .and_then(|endpoints| endpoints.get(0))
        .and_then(|endpoint| endpoint.as_str())
        .ok_or_else(|| "la configuracion de Tauri no declara endpoints del updater".to_string())?;
    if !endpoint.starts_with("https://") {
        return Err("el endpoint del updater no es HTTPS".to_string());
    }
    Ok(endpoint.to_string())
}

/// Endpoint del canal, leído de la configuración de Tauri de ese canal.
pub fn manifest_endpoint_for(canal: &str) -> Result<String, String> {
    let config = if canal.eq_ignore_ascii_case(CHANNEL_STAGING) {
        STAGING_TAURI_CONFIG
    } else {
        STABLE_TAURI_CONFIG
    };
    endpoint_from_tauri_config(config)
}

/// Canal que un endpoint declara implícitamente por su forma.
///
/// Es una comprobación independiente: si alguien dejara el endpoint de staging
/// en la configuración de producción, el endpoint y el canal no coincidirían y
/// hay que notarlo en vez de confiar en la bandera de compilación.
pub fn canal_implicito_en_endpoint(endpoint: &str) -> &'static str {
    if endpoint.contains("/releases/download/staging/") {
        CHANNEL_STAGING
    } else {
        CHANNEL_STABLE
    }
}

/// FASE 3.4 — por qué no se puede auditar el manifiesto.
///
/// `Lectura` y `Respuesta` son fallos de transporte o de forma; `Rechazo` es un
/// manifiesto que se leyó bien pero no cumple las reglas. Ninguno se degrada a
/// "auditoría satisfactoria".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuditError {
    /// No se pudo obtener el manifiesto: endpoint inválido, DNS, TLS, timeout,
    /// o respuesta no satisfactoria.
    Lectura(String),
    /// Se obtuvo algo, pero no es un manifiesto utilizable.
    Respuesta(String),
    /// El manifiesto se entendió y viola una regla.
    Rechazo(UpdateRejection),
}

impl AuditError {
    /// Mensaje para la persona. Siempre termina de la forma que la UI
    /// reconoce como reintentable (`isRetryableFailure` busca "Reintenta").
    pub fn mensaje_para_usuario(&self) -> String {
        match self {
            AuditError::Lectura(detalle) | AuditError::Respuesta(detalle) => format!(
                "No se pudo verificar el manifiesto del canal. Reintenta la comprobacion. ({detalle})"
            ),
            AuditError::Rechazo(UpdateRejection::CanalDistinto { esperado, recibido }) => {
                format!("El manifiesto es del canal {recibido} y esta app es {esperado}: no se instala nada.")
            }
            AuditError::Rechazo(UpdateRejection::VersionDistinta { del_plugin, del_manifiesto }) => {
                format!(
                    "El manifiesto anuncia {del_manifiesto} pero la comprobacion dio {del_plugin}: no se instala nada."
                )
            }
            AuditError::Rechazo(otro) => {
                format!("La actualizacion fue rechazada y no se instala nada: {otro}")
            }
        }
    }

    /// Diagnóstico para el log. No incluye el cuerpo del manifiesto ni URLs
    /// firmadas: solo el motivo.
    pub fn diagnostico(&self) -> String {
        match self {
            AuditError::Lectura(detalle) => format!("auditoria: no se pudo leer el manifiesto: {detalle}"),
            AuditError::Respuesta(detalle) => format!("auditoria: respuesta inutilizable: {detalle}"),
            AuditError::Rechazo(rechazo) => format!("auditoria: manifiesto rechazado: {rechazo:?}"),
        }
    }
}

impl std::fmt::Display for UpdateRejection {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{self:?}")
    }
}

/// Audita el cuerpo crudo del manifiesto.
///
/// Pura a propósito: no toca red ni disco, así que los diez escenarios de
/// seguridad se prueban sin servidor real y sin secretos.
///
/// Reglas, en orden:
///  1. El JSON se puede entender y trae los campos obligatorios.
///  2. El canal declarado es exactamente el canal de esta app.
///  3. La versión del manifiesto es exactamente la que obtuvo el plugin.
///  4. Las reglas de `evaluate_update` (más nueva, cliente compatible, HTTPS, artefacto).
pub fn audit_manifest(
    raw_json: &str,
    canal_esperado: &str,
    version_del_plugin: &str,
    version_instalada: &str,
    version_code_instalado: u64,
) -> Result<UpdateDecision, AuditError> {
    let manifest: UpdateManifest = serde_json::from_str(raw_json)
        .map_err(|error| AuditError::Respuesta(format!("el manifiesto no es JSON valido: {error}")))?;

    if manifest.version.trim().is_empty() {
        return Err(AuditError::Respuesta("el manifiesto no declara version".to_string()));
    }
    if manifest.channel.trim().is_empty() {
        return Err(AuditError::Respuesta("el manifiesto no declara canal".to_string()));
    }

    // Canal: comparación exacta (ignorando mayúsculas) contra el canal de ESTE
    // binario. Cualquier ambigüedad — un canal desconocido, un manifiesto de
    // producción en una app de staging — se rechaza.
    if !manifest.channel.eq_ignore_ascii_case(canal_esperado) {
        return Err(AuditError::Rechazo(UpdateRejection::CanalDistinto {
            esperado: canal_esperado.to_string(),
            recibido: manifest.channel,
        }));
    }

    // La versión del manifiesto debe ser exactamente la que obtuvo el plugin.
    // Sin esto, un manifiesto que cambia entre el check y el install podría
    // autorizar algo distinto de lo que el plugin ya descargó y firmó.
    if manifest.version != version_del_plugin {
        return Err(AuditError::Rechazo(UpdateRejection::VersionDistinta {
            del_plugin: version_del_plugin.to_string(),
            del_manifiesto: manifest.version,
        }));
    }

    // Una entrada sin firma no se ofrece. La verificación que decide es la del
    // plugin (`Update::download` → `verify_signature`); esto sólo evita
    // prometer una actualización que el plugin rechazaría un instante después.
    if let Some(entrada) = manifest.platforms.get(WINDOWS_TARGET) {
        if entrada.signature.trim().is_empty() {
            return Err(AuditError::Rechazo(UpdateRejection::FirmaAusente));
        }
    }

    evaluate_update(
        version_instalada,
        version_code_instalado,
        &manifest,
        canal_esperado,
    )
    .map_err(AuditError::Rechazo)
}

/// Fuente del manifiesto. Inyectable para poder probar los fallos de red.
pub trait ManifestSource: Send + Sync {
    /// Devuelve el cuerpo crudo, o un motivo de fallo.
    fn fetch(&self, url: &str) -> Result<String, String>;
}

/// Fuente real: HTTPS con timeout y con los códigos de estado tratados
/// explícitamente. Un 404 no es "sin actualizaciones": es un fallo que se
/// reporta, porque desde la auditoría no se puede distinguir de una release
/// vacía sin comprobar el cuerpo.
pub struct HttpManifestSource {
    pub connect_timeout: std::time::Duration,
    pub read_timeout: std::time::Duration,
}

impl Default for HttpManifestSource {
    fn default() -> Self {
        Self {
            connect_timeout: std::time::Duration::from_secs(10),
            read_timeout: std::time::Duration::from_secs(15),
        }
    }
}

impl ManifestSource for HttpManifestSource {
    fn fetch(&self, url: &str) -> Result<String, String> {
        if !url.starts_with("https://") {
            return Err("el endpoint del canal no es HTTPS".to_string());
        }
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(self.connect_timeout)
            .timeout_read(self.read_timeout)
            .build();

        match agent.get(url).call() {
            Ok(response) => {
                let status = response.status();
                if status != 200 {
                    return Err(format!("el servidor respondio {status}"));
                }
                response
                    .into_string()
                    .map_err(|_| "la respuesta no es texto legible".to_string())
            }
            Err(ureq::Error::Status(code, _)) => Err(format!("el servidor respondio {code}")),
            Err(ureq::Error::Transport(transporte)) => {
                Err(format!("fallo de red: {transporte}"))
            }
        }
    }
}

/// Auditoría completa: resuelve el endpoint del canal, lee el manifiesto y lo
/// valida contra la versión que el plugin ofrece.
pub fn auditar_con_fuente<S: ManifestSource>(
    fuente: &S,
    canal_esperado: &str,
    version_del_plugin: &str,
    version_instalada: &str,
    version_code_instalado: u64,
) -> Result<UpdateDecision, AuditError> {
    let endpoint =
        manifest_endpoint_for(canal_esperado).map_err(AuditError::Lectura)?;

    // Coherencia endpoint ↔ canal. Si la configuración del canal estable
    // apuntara a la URL de staging, esto corta aquí.
    if canal_implicito_en_endpoint(&endpoint) != canal_esperado.to_ascii_lowercase().as_str() {
        return Err(AuditError::Lectura(format!(
            "el endpoint del canal {canal_esperado} no corresponde a ese canal"
        )));
    }

    let raw = fuente.fetch(&endpoint).map_err(AuditError::Lectura)?;
    audit_manifest(
        &raw,
        canal_esperado,
        version_del_plugin,
        version_instalada,
        version_code_instalado,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(version: &str, channel: &str) -> UpdateManifest {
        UpdateManifest {
            version: version.to_string(),
            notes: "notas".to_string(),
            channel: channel.to_string(),
            pub_date: "2026-01-01T00:00:00Z".to_string(),
            platforms: std::collections::BTreeMap::from([(
                WINDOWS_TARGET.to_string(),
                PlatformEntry {
                    signature: "sig".to_string(),
                    url: "https://github.com/o/r/releases/download/v1/Apollo_1.2.3_x64-setup.exe".to_string(),
                    hash: "abc".to_string(),
                },
            )]),
            version_code: 12,
            min_client_version_code: 3,
            size: 100,
            sha256: "deadbeef".to_string(),
        }
    }

    #[test]
    fn no_hay_actualizacion_si_la_version_es_igual() {
        let result = evaluate_update("0.1.1", 11, &manifest("0.1.1", "stable"), "stable");
        assert!(matches!(
            result,
            Err(UpdateRejection::NoEsMasNueva { .. })
        ));
    }

    #[test]
    fn hay_actualizacion_si_la_version_es_mayor() {
        let decision = evaluate_update("0.1.1", 11, &manifest("0.2.0", "stable"), "stable")
            .expect("deberia ofrecer Actualizar");
        assert_eq!(decision.version, "0.2.0");
        assert!(decision.download_url.starts_with("https://"));
        assert_eq!(decision.expected_signature, "sig");
    }

    #[test]
    fn una_version_anterior_nunca_se_instala() {
        let result = evaluate_update("0.2.0", 20, &manifest("0.1.9", "stable"), "stable");
        assert!(matches!(
            result,
            Err(UpdateRejection::NoEsMasNueva { .. })
        ));
    }

    #[test]
    fn staging_no_acepta_un_manifiesto_de_produccion() {
        let result = evaluate_update("0.1.1", 11, &manifest("9.9.9", "stable"), "staging");
        assert_eq!(
            result,
            Err(UpdateRejection::CanalDistinto {
                esperado: "staging".to_string(),
                recibido: "stable".to_string(),
            })
        );
    }

    #[test]
    fn produccion_no_acepta_un_manifiesto_de_staging() {
        let result = evaluate_update("0.1.1", 11, &manifest("9.9.9", "staging"), "stable");
        assert!(matches!(
            result,
            Err(UpdateRejection::CanalDistinto { .. })
        ));
    }

    #[test]
    fn un_claveviejo_no_puede_instalar_un_artefacto_que_lo_requiere() {
        let mut incompatible = manifest("0.2.0", "stable");
        incompatible.min_client_version_code = 50;
        let result = evaluate_update("0.1.1", 11, &incompatible, "stable");
        assert_eq!(
            result,
            Err(UpdateRejection::ClienteAntiguo {
                minimo: 50,
                actual: 11,
            })
        );
    }

    #[test]
    fn un_manifiesto_incompleto_o_invalido_se_rechaza() {
        let mut sin_artefacto = manifest("0.2.0", "stable");
        sin_artefacto.platforms.clear();
        assert_eq!(
            evaluate_update("0.1.1", 11, &sin_artefacto, "stable"),
            Err(UpdateRejection::SinArtefactoWindows)
        );

        let version_rota = manifest("no-es-version", "stable");
        assert!(matches!(
            evaluate_update("0.1.1", 11, &version_rota, "stable"),
            Err(UpdateRejection::ManifestInvalido(_))
        ));
    }

    #[test]
    fn un_artefacto_sin_https_se_rechaza_aunque_venga_firmado() {
        let mut inseguro = manifest("0.2.0", "stable");
        inseguro.platforms.insert(
            WINDOWS_TARGET.to_string(),
            PlatformEntry {
                signature: "sig".to_string(),
                url: "http://example.invalid/Apollo_1.2.3_x64-setup.exe".to_string(),
                hash: "abc".to_string(),
            },
        );
        assert!(matches!(
            evaluate_update("0.1.1", 11, &inseguro, "stable"),
            Err(UpdateRejection::UrlInsegura(_))
        ));
    }

    #[test]
    fn un_artefacto_de_otra_plataforma_no_se_te_toma() {
        let mut solo_android = manifest("0.2.0", "stable");
        solo_android.platforms = std::collections::BTreeMap::from([(
            "android-arm64".to_string(),
            PlatformEntry {
                signature: "sig".to_string(),
                url: "https://example.invalid/apollo-1.2.3.apk".to_string(),
                hash: "h".to_string(),
            },
        )]);
        assert_eq!(
            evaluate_update("0.1.1", 11, &solo_android, "stable"),
            Err(UpdateRejection::SinArtefactoWindows)
        );
    }

    #[test]
    fn el_json_del_manifiesto_se_interpreta_como_debe() {
        let raw = r#"{
          "version": "1.2.3",
          "notes": "arregla cosas",
          "channel": "staging",
          "pub_date": "2026-02-02T10:00:00Z",
          "version_code": 120,
          "min_client_version_code": 100,
          "size": 42,
          "sha256": "cafe",
          "platforms": {
            "windows-x86_64": {"signature": "sig-windows", "url": "https://example.invalid/Apollo_Setup_1.2.3_x64-setup.exe", "hash": "h1"},
            "android-arm64": {"signature": "sig-android", "url": "https://example.invalid/apollo-1.2.3.apk", "hash": "h2"}
          }
        }"#;
        let parsed: UpdateManifest = serde_json::from_str(raw).expect("manifiesto valido");
        assert_eq!(parsed.version, "1.2.3");
        assert_eq!(parsed.channel, "staging");
        assert_eq!(parsed.version_code, 120);
        assert_eq!(parsed.platforms.len(), 2);

        let decision = evaluate_update("1.2.2", 119, &parsed, "staging").expect("hay update");
        assert_eq!(decision.expected_signature, "sig-windows");
        assert_eq!(decision.sha256, "cafe");
    }

    #[test]
    fn el_canal_se_resuelve_al_compilar_y_no_en_runtime() {
        // En el binario de tests el canal no esta definido: debe ser stable.
        assert!(!is_staging_channel());
        assert_eq!(distribution_channel(), "stable");
    }

    #[test]
    fn las_versiones_se_comparan_numericamente() {
        assert!(SemVer::parse("0.10.0") > SemVer::parse("0.9.9"));
        assert!(SemVer::parse("v1.0.0") == SemVer::parse("1.0.0"));
        assert!(SemVer::parse("1.2") == SemVer::parse("1.2.0"));
        assert!(SemVer::parse("no-es") .is_none());
    }

    /// FASE 3.2 — compatibilidad REAL con el plugin: deserializamos un
    /// `latest.json` con los tipos públicos de `tauri_plugin_updater`, que son
    /// los que el updater real deserializa en tiempo de ejecucion.
    ///
    /// Esto importa porque el plugin acepta `platforms` como mapa por target: un
    /// manifiesto con lista habria parseado aqui y habria fallado en la app con
    /// TargetNotFound. El test falla si alguna vez se cambia la forma.
    #[test]
    fn el_manifiesto_es_compatible_con_el_plugin_real() {
        let raw = r#"{
          "version": "1.2.3",
          "notes": "notas",
          "pub_date": "2026-02-02T10:00:00Z",
          "channel": "staging",
          "versionCode": 120,
          "platforms": {
            "windows-x86_64": {
              "signature": "sig-de-prueba",
              "url": "https://github.com/o/r/releases/download/staging/Apollo_1.2.3_x64-setup.exe",
              "hash": "h1"
            }
          }
        }"#;

        let release: tauri_plugin_updater::RemoteRelease =
            serde_json::from_str(raw).expect("el plugin debe poder leer este manifiesto");

        // El target que este proyecto publica tiene que existir en el manifiesto.
        assert_eq!(release.download_url(WINDOWS_TARGET).unwrap().to_string().trim_end_matches('/'), "https://github.com/o/r/releases/download/staging/Apollo_1.2.3_x64-setup.exe".to_string());
        assert_eq!(release.signature(WINDOWS_TARGET).unwrap(), "sig-de-prueba");
        assert!(release.download_url("darwin-aarch64").is_err());

        // Y nuestro propio lector tiene que ver lo mismo.
        let propio: UpdateManifest = serde_json::from_str(raw).expect("lector propio");
        assert!(is_windows_x64_artifact(&propio));
        assert_eq!(propio.channel, "staging");
    }

    // =======================================================================
    // FASE 3.4 (C2) — seguridad y regresión de la auditoría del manifiesto.
    // =======================================================================

    /// Fuente de prueba: devuelve un cuerpo fijo o un fallo, y registra a qué
    /// URL se le pidió. Es el límite de red inyectable, así que los escenarios
    /// se prueban sin releases reales ni secretos.
    struct FuenteFalsa {
        cuerpo: Result<String, String>,
        url_pedida: std::sync::Mutex<Vec<String>>,
    }

    impl FuenteFalsa {
        fn con_cuerpo(cuerpo: &str) -> Self {
            Self {
                cuerpo: Ok(cuerpo.to_string()),
                url_pedida: std::sync::Mutex::new(Vec::new()),
            }
        }
        fn con_fallo(motivo: &str) -> Self {
            Self {
                cuerpo: Err(motivo.to_string()),
                url_pedida: std::sync::Mutex::new(Vec::new()),
            }
        }
    }

    impl ManifestSource for FuenteFalsa {
        fn fetch(&self, url: &str) -> Result<String, String> {
            self.url_pedida
                .lock()
                .expect("lock")
                .push(url.to_string());
            self.cuerpo.clone()
        }
    }

    /// Manifiesto válido y coherente, con el canal y la versión que se le piden.
    fn manifiesto_valido(canal: &str, version: &str) -> String {
        format!(
            r#"{{
              "version": "{version}",
              "notes": "notas",
              "channel": "{canal}",
              "pub_date": "2026-10-14T00:00:00Z",
              "platforms": {{
                "{WINDOWS_TARGET}": {{
                  "signature": "firma-valida",
                  "url": "https://github.com/o/r/releases/download/v1.4.1/Apollo_1.4.1_x64-setup.exe",
                  "hash": "abc123"
                }}
              }}
            }}"#
        )
    }

    const CANAL: &str = CHANNEL_STABLE;
    const VERSION: &str = "1.4.1";
    const INSTALADA: &str = "0.1.1";

    fn auditar(cuerpo: &str) -> Result<UpdateDecision, AuditError> {
        audit_manifest(cuerpo, CANAL, VERSION, INSTALADA, 0)
    }

    // --- 1. Manifiesto válido del canal correcto: se acepta ---------------

    #[test]
    fn uno_un_manifiesto_valido_del_canal_correcto_se_acepta() {
        let decision = auditar(&manifiesto_valido(CANAL, VERSION)).expect("deberia auditar bien");
        assert_eq!(decision.version, VERSION);
        assert_eq!(decision.expected_signature, "firma-valida");
        assert!(decision.download_url.starts_with("https://"));
    }

    #[test]
    fn dos_lo_mismo_funciona_para_staging() {
        let decision = audit_manifest(
            &manifiesto_valido(CHANNEL_STAGING, VERSION),
            CHANNEL_STAGING,
            VERSION,
            INSTALADA,
            0,
        )
        .expect("staging valido deberia auditar bien");
        assert_eq!(decision.version, VERSION);
    }

    // --- 2. Otro canal: se rechaza ---------------------------------------

    #[test]
    fn tres_un_manifiesto_de_otro_canal_se_rechaza() {
        let error = auditar(&manifiesto_valido(CHANNEL_STAGING, VERSION)).expect_err("no debe pasar");
        assert_eq!(
            error,
            AuditError::Rechazo(UpdateRejection::CanalDistinto {
                esperado: CANAL.to_string(),
                recibido: CHANNEL_STAGING.to_string(),
            })
        );
        assert!(error.mensaje_para_usuario().contains("no se instala nada"));
    }

    #[test]
    fn cuatro_un_canal_desconocido_tambien_se_rechaza() {
        for canal in ["beta", "", "STABLE ", "produccion"] {
            let cuerpo = manifiesto_valido(canal, VERSION);
            assert!(
                auditar(&cuerpo).is_err(),
                "el canal {canal:?} deberia rechazarse, no aceptarse"
            );
        }
    }

    #[test]
    fn cinco_staging_nunca_acepta_una_oferta_de_produccion() {
        let oferta_de_produccion = manifiesto_valido(CHANNEL_STABLE, VERSION);
        let error = audit_manifest(
            &oferta_de_produccion,
            CHANNEL_STAGING,
            VERSION,
            INSTALADA,
            0,
        )
        .expect_err("staging no puede aceptar una oferta de produccion");
        assert!(matches!(
            error,
            AuditError::Rechazo(UpdateRejection::CanalDistinto { .. })
        ));
    }

    // --- 3. Malformado ----------------------------------------------------

    #[test]
    fn seis_un_manifiesto_malformado_se_rechaza() {
        for cuerpo in [
            "",
            "{",
            "[]",
            "null",
            "no es json",
            r#"{"version":"1.4.1"}"#,
            r#"{"version":"","channel":"stable","platforms":{}}"#,
            r#"{"channel":"stable","platforms":{}}"#,
            r#"{"version":"1.4.1","channel":"","platforms":{}}"#,
            r#"{"version":"1.4.1","channel":"stable"}"#,
        ] {
            let error = auditar(cuerpo).expect_err("deberia rechazarse");
            assert!(
                matches!(error, AuditError::Respuesta(_) | AuditError::Rechazo(_)),
                "cuerpo {cuerpo:?} produjo un error inesperado: {error:?}"
            );
            // Nunca debe terminar siendo una actualización aceptable.
            assert!(error.mensaje_para_usuario().contains("Reintenta")
                || error.mensaje_para_usuario().contains("no se instala"));
        }
    }

    #[test]
    fn siete_sin_artefacto_windows_se_rechaza() {
        let cuerpo = r#"{"version":"1.4.1","channel":"stable","platforms":{}}"#;
        let error = auditar(cuerpo).expect_err("sin instalador no hay actualizacion");
        assert_eq!(error, AuditError::Rechazo(UpdateRejection::SinArtefactoWindows));
    }

    #[test]
    fn ocho_una_url_no_https_se_rechaza_aunque_firma() {
        let cuerpo = r#"{
          "version":"1.4.1","channel":"stable",
          "platforms":{"windows-x86_64":{
            "signature":"firma","url":"http://ejemplo.invalid/Apollo.exe","hash":"h"}}
        }"#;
        let error = auditar(cuerpo).expect_err("http no se descarga");
        assert!(matches!(
            error,
            AuditError::Rechazo(UpdateRejection::UrlInsegura(_))
        ));
    }

    // --- 4. Fallo de red o HTTP -------------------------------------------

    #[test]
    fn nueve_un_fallo_de_red_es_error_explicito_y_no_una_oferta() {
        for motivo in [
            "el servidor respondio 404",
            "el servidor respondio 500",
            "fallo de red: timeout",
            "fallo de red: dns",
        ] {
            let fuente = FuenteFalsa::con_fallo(motivo);
            let error = auditar_con_fuente(&fuente, CANAL, VERSION, INSTALADA, 0)
                .expect_err("un fallo de red no puede ser una oferta valida");
            assert!(matches!(error, AuditError::Lectura(_)), "{motivo} -> {error:?}");
            let mensaje = error.mensaje_para_usuario();
            assert!(mensaje.contains("Reintenta"), "debe ser recuperable: {mensaje}");
        }
    }

    #[test]
    fn diez_un_cuerpo_ilegible_es_error_y_no_una_oferta() {
        let fuente = FuenteFalsa::con_cuerpo("esto no es un manifiesto");
        let error = auditar_con_fuente(&fuente, CANAL, VERSION, INSTALADA, 0)
            .expect_err("cuerpo basura no puede ser una oferta valida");
        assert!(matches!(error, AuditError::Respuesta(_)));
    }

    #[test]
    fn once_la_fuente_real_rechaza_un_endpoint_que_no_es_https() {
        let error = HttpManifestSource::default()
            .fetch("http://ejemplo.invalid/latest.json")
            .expect_err("el endpoint tiene que ser https");
        assert!(error.contains("HTTPS"), "{error}");
    }

    #[test]
    fn doce_la_fuente_real_reporta_el_fallo_de_conexion() {
        // Puerto cerrado en localhost: exercise del camino de red de verdad, sin
        // tocar releases reales ni depender de internet.
        let error = HttpManifestSource {
            connect_timeout: std::time::Duration::from_millis(800),
            read_timeout: std::time::Duration::from_millis(800),
        }
        .fetch("https://127.0.0.1:1/latest.json")
        .expect_err("no deberia poder conectar");
        assert!(!error.is_empty(), "el fallo debe describirse");
    }

    // --- 5. Versión distinta de la del plugin ----------------------------

    #[test]
    fn trece_una_version_distinta_de_la_del_plugin_se_rechaza() {
        let error = auditar(&manifiesto_valido(CANAL, "9.9.9"))
            .expect_err("el manifiesto no describe la version que trajo el plugin");
        assert_eq!(
            error,
            AuditError::Rechazo(UpdateRejection::VersionDistinta {
                del_plugin: VERSION.to_string(),
                del_manifiesto: "9.9.9".to_string(),
            })
        );
        assert!(error.mensaje_para_usuario().contains("no se instala nada"));
    }

    // --- 6. Versión incompatible o inválida -------------------------------

    #[test]
    fn catorce_una_version_no_mas_nueva_se_rechaza() {
        // El plugin trae la misma versión que el manifiesto: la igualdad se
        // cumple y entonces decide `evaluate_update`.
        let error = audit_manifest(
            &manifiesto_valido(CANAL, INSTALADA),
            CANAL,
            INSTALADA,
            INSTALADA,
            0,
        )
        .expect_err("la misma version no es una actualizacion");
        assert!(
            matches!(error, AuditError::Rechazo(UpdateRejection::NoEsMasNueva { .. })),
            "{error:?}"
        );

        // Y una versión anterior, con el plugin de acuerdo.
        let error = audit_manifest(
            &manifiesto_valido(CANAL, "0.0.1"),
            CANAL,
            "0.0.1",
            INSTALADA,
            0,
        )
        .expect_err("una version anterior no se instala");
        assert!(
            matches!(error, AuditError::Rechazo(UpdateRejection::NoEsMasNueva { .. })),
            "{error:?}"
        );
    }

    #[test]
    fn quince_un_cliente_demasiado_viejo_se_rechaza() {
        let cuerpo = r#"{
          "version":"1.4.1","channel":"stable","minClientVersionCode":500,
          "platforms":{"windows-x86_64":{
            "signature":"firma","url":"https://ejemplo.invalid/Apollo.exe","hash":"h"}}
        }"#;
        let error = audit_manifest(cuerpo, CANAL, VERSION, INSTALADA, 1)
            .expect_err("un cliente viejo no puede instalar eso");
        assert_eq!(
            error,
            AuditError::Rechazo(UpdateRejection::ClienteAntiguo {
                minimo: 500,
                actual: 1
            })
        );
    }

    #[test]
    fn dieciseis_una_version_instalada_ilegible_se_rechaza() {
        let error = audit_manifest(
            &manifiesto_valido(CANAL, VERSION),
            CANAL,
            VERSION,
            "no-es-semver",
            0,
        )
        .expect_err("sin version instalada comparable no hay decision");
        assert!(matches!(
            error,
            AuditError::Rechazo(UpdateRejection::ManifestInvalido(_))
        ));
    }

    // --- 7 y 8. La puerta del camino de instalación -----------------------

    /// 7: si la auditoría falla, no hay permiso de instalar. Esta es la misma
    /// llamada que hace `download_and_install_update` antes de descargar, así
    /// que un fallo aquí significa que no se descarga nada.
    #[test]
    fn diecisiete_la_instalacion_no_continua_si_la_auditoria_falla() {
        let fuente = FuenteFalsa::con_fallo("el servidor respondio 404");
        assert!(
            auditar_con_fuente(&fuente, CANAL, VERSION, INSTALADA, 0).is_err(),
            "sin auditoria no hay instalacion"
        );

        let cuerpo_ajeno = manifiesto_valido(CHANNEL_STAGING, VERSION);
        assert!(
            auditar(&cuerpo_ajeno).is_err(),
            "una oferta de otro canal no puede pasar la puerta"
        );
    }

    /// 8: el control de canal no depende de la interfaz. Se simula a alguien
    /// que invoca el comando de instalación sin haber pasado por la UI: el
    /// único dato que el comando toma del mundo exterior es la versión que
    /// devolvió el plugin, y contra eso se audita el manifiesto.
    #[test]
    fn dieciocho_el_control_de_canal_no_depende_de_la_interfaz() {
        // Una app de staging a la que le llega un manifiesto de producción.
        let manifesto_de_produccion = FuenteFalsa::con_cuerpo(&manifiesto_valido(CHANNEL_STABLE, VERSION));
        assert!(
            auditar_con_fuente(
                &manifesto_de_produccion,
                CHANNEL_STAGING,
                VERSION,
                INSTALADA,
                0
            )
            .is_err(),
            "sin haber pasado por la UI, staging no puede instalar produccion"
        );

        // Y el caso inverso: una app de producción con manifiesto de staging.
        let manifesto_de_staging = FuenteFalsa::con_cuerpo(&manifiesto_valido(CHANNEL_STAGING, VERSION));
        assert!(
            auditar_con_fuente(&manifesto_de_staging, CANAL, VERSION, INSTALADA, 0).is_err(),
            "sin haber pasado por la UI, produccion no puede instalar staging"
        );
    }

    #[test]
    fn diecinueve_si_el_manifiesto_cambia_entre_puertas_la_segunda_lo_ve() {
        // Primera puerta: todo bien.
        let primera = FuenteFalsa::con_cuerpo(&manifiesto_valido(CANAL, VERSION));
        assert!(auditar_con_fuente(&primera, CANAL, VERSION, INSTALADA, 0).is_ok());

        // Segunda puerta, con el manifiesto ya movido a otra version.
        let segunda = FuenteFalsa::con_cuerpo(&manifiesto_valido(CANAL, "2.0.0"));
        assert!(
            auditar_con_fuente(&segunda, CANAL, VERSION, INSTALADA, 0).is_err(),
            "un manifiesto que se movio debe abortar la instalacion"
        );
    }

    // --- 9. La firma de Tauri sigue siendo obligatoria -------------------

    /// La auditoría NO reemplaza la firma: la sigue haciendo `Update::download`.
    /// Lo que este test fija es que la auditoría exige que el manifiesto traiga
    /// una firma no vacía, de modo que nunca se ofrezca algo que el plugin
    /// rechazaría después. Y que la firma que el plugin usará viaje en la
    /// decisión, para poder contrastarla.
    #[test]
    fn veinte_la_firma_no_se_puede_omitir_en_el_manifiesto() {
        let sin_firma = r#"{
          "version":"1.4.1","channel":"stable",
          "platforms":{"windows-x86_64":{
            "signature":"","url":"https://ejemplo.invalid/Apollo.exe","hash":"h"}}
        }"#;
        let error = auditar(sin_firma).expect_err("una entrada sin firma no debe ofrecerse");
        assert!(
            matches!(error, AuditError::Rechazo(_) | AuditError::Respuesta(_)),
            "{error:?}"
        );

        // Y la firma que el plugin va a verificar viaja en la decisión, sin
        // que nosotros la reimplementemos.
        let con_firma = manifiesto_valido(CANAL, VERSION);
        let decision = auditar(&con_firma).expect("audita");
        assert_eq!(decision.expected_signature, "firma-valida");
    }

    // --- 10. Los endpoints de cada canal ----------------------------------

    #[test]
    fn veintiuno_las_configuraciones_apuntan_a_sus_endpoints_previstos() {
        let estable = manifest_endpoint_for(CHANNEL_STABLE).expect("endpoint de produccion");
        let staging = manifest_endpoint_for(CHANNEL_STAGING).expect("endpoint de staging");

        assert!(
            estable.ends_with(EXPECTED_STABLE_ENDPOINT_SUFFIX),
            "produccion apunto a {estable}"
        );
        assert!(
            staging.ends_with(EXPECTED_STAGING_ENDPOINT_SUFFIX),
            "staging apunto a {staging}"
        );
        assert!(estable.starts_with("https://"));
        assert!(staging.starts_with("https://"));
        assert_ne!(estable, staging, "los canales no pueden compartir endpoint");
    }

    #[test]
    fn veintidos_el_canal_implicito_en_el_endpoint_coincide_con_el_canal() {
        let estable = manifest_endpoint_for(CHANNEL_STABLE).expect("estable");
        let staging = manifest_endpoint_for(CHANNEL_STAGING).expect("staging");
        assert_eq!(canal_implicito_en_endpoint(&estable), CHANNEL_STABLE);
        assert_eq!(canal_implicito_en_endpoint(&staging), CHANNEL_STAGING);
    }

    #[test]
    fn veintitres_la_auditoria_pide_el_manifesto_del_canal_correcto() {
        let fuente = FuenteFalsa::con_cuerpo(&manifiesto_valido(CHANNEL_STAGING, VERSION));
        auditar_con_fuente(&fuente, CHANNEL_STAGING, VERSION, INSTALADA, 0)
            .expect("staging valido");
        let pedidas = fuente.url_pedida.lock().expect("lock").clone();
        assert_eq!(pedidas.len(), 1);
        assert!(
            pedidas[0].ends_with(EXPECTED_STAGING_ENDPOINT_SUFFIX),
            "pidio {pedidas:?}"
        );

        let fuente = FuenteFalsa::con_cuerpo(&manifiesto_valido(CHANNEL_STABLE, VERSION));
        auditar_con_fuente(&fuente, CHANNEL_STABLE, VERSION, INSTALADA, 0).expect("estable valido");
        let pedidas = fuente.url_pedida.lock().expect("lock").clone();
        assert!(
            pedidas[0].ends_with(EXPECTED_STABLE_ENDPOINT_SUFFIX),
            "pidio {pedidas:?}"
        );
    }

    #[test]
    fn veinticuatro_un_endpoint_del_canal_contrario_se_detecta() {
        // Configuración de "staging" que en realidad apunta a producción: la
        // coherencia endpoint/canal tiene que cortar esto.
        assert_eq!(
            canal_implicito_en_endpoint(
                "https://github.com/o/r/releases/latest/download/latest.json"
            ),
            CHANNEL_STABLE
        );
        assert_eq!(
            canal_implicito_en_endpoint(
                "https://github.com/o/r/releases/download/staging/latest.json"
            ),
            CHANNEL_STAGING
        );
    }

    // --- Robustez del contrato de errores ---------------------------------

    #[test]
    fn veinticinco_el_diagnostico_no_incluye_el_cuerpo_del_manifiesto() {
        let error = auditar("{ \"secreto\": \"no-deberia-aparecer\" }").expect_err("malformado");
        let diagnostico = error.diagnostico();
        assert!(!diagnostico.contains("no-deberia-aparecer"), "{diagnostico}");
        assert!(diagnostico.starts_with("auditoria:"));
    }

    #[test]
    fn veintiseis_todo_fallo_auditado_es_reintentable_para_la_ui() {
        // La UI decide si reintenta buscando "Reintenta" en el motivo; un
        // rechazo por firma NO debe offering reintento, y todos los fallos de
        // transporte SÍ.
        let casos = [
            FuenteFalsa::con_fallo("el servidor respondio 503"),
            FuenteFalsa::con_cuerpo("no es json"),
        ];
        for fuente in casos {
            let error = auditar_con_fuente(&fuente, CANAL, VERSION, INSTALADA, 0).expect_err("falla");
            assert!(
                error.mensaje_para_usuario().contains("Reintenta"),
                "{} no es reintentable",
                error.mensaje_para_usuario()
            );
        }
    }
}