//! Cuenta multiusuario del cliente PC (FASE 2.3).
//!
//! El token de sesión NO es la credencial del dispositivo y la contraseña no
//! es ninguna de las dos. El token vive en Credential Manager, el `accountId`
//! en el JSON de preferencias (no es secreto: la UI lo muestra).
//! La conexión de conversación sale hacia `Apollo/acct:<accountId>` con
//! `Authorization: Bearer <sessionToken>` — nunca el token en la URL.

use serde::Deserialize;

/// Origen de red deducido de la URL del Worker (wss://host/... → https://host).
pub fn origin_from_worker_url(worker_url: &str) -> Option<String> {
    let without_scheme = worker_url.split("://").nth(1)?;
    let authority = without_scheme.split('/').next()?;
    if authority.is_empty() {
        return None;
    }
    if worker_url.starts_with("wss://") {
        Some(format!("https://{authority}"))
    } else {
        Some(format!("http://{authority}"))
    }
}

/// URL del Apollo de la cuenta: `/agents/apollo/acct:<accountId>`.
pub fn account_conversation_url(worker_url: &str, account_id: &str) -> Option<String> {
    if account_id.trim().is_empty() {
        return None;
    }
    let origin = origin_from_worker_url(worker_url)?;
    let scheme = if origin.starts_with("https") { "wss" } else { "ws" };
    let authority = origin.trim_start_matches("https://").trim_start_matches("http://");
    Some(format!("{scheme}://{authority}/agents/apollo/acct-{account_id}"))
}

/// Identifica una instancia de cuenta desde una URL de conversación.
pub fn account_id_from_conversation_url(worker_url: &str) -> Option<String> {
    let without_scheme = worker_url.split("://").nth(1)?;
    let path = without_scheme.split_once('/')?.1;
    let segments: Vec<&str> = path.split('/').collect();
    let last = segments.last()?;
    let account_id = last.strip_prefix("acct-").or_else(|| last.strip_prefix("acct:"))?;
    if account_id.is_empty() {
        None
    } else {
        Some(account_id.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssuedSession {
    pub account_id: String,
    pub session_token: String,
    pub expires_at_milliseconds: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccountAuthError {
    /// 401: email o contraseña incorrectos. Mismo mensaje para ambos.
    InvalidCredentials,
    /// 409: el email ya tiene cuenta.
    EmailTaken,
    /// 400: input rechazado por el servidor.
    InvalidInput,
    /// Cualquier otra respuesta: ni pantalla ni log filtran detalles.
    InvalidResponse,
    /// Sin red / Worker inalcanzable.
    Unreachable,
    /// La sesión emitida fue rechazada al enrolar este dispositivo.
    SessionExpired,
    /// El Worker no confirmó el enrolamiento del dispositivo.
    EnrollmentRejected,
}

#[derive(Deserialize)]
struct AuthIssuedBody {
    #[serde(rename = "accountId")]
    account_id: String,
    #[serde(rename = "sessionToken")]
    session_token: String,
    #[serde(rename = "expiresAt", default)]
    expires_at_milliseconds: u64,
}

pub fn parse_issued_session(status: u16, body: &str) -> Result<IssuedSession, AccountAuthError> {
    match status {
        200 => {
            let parsed: AuthIssuedBody =
                serde_json::from_str(body).map_err(|_| AccountAuthError::InvalidResponse)?;
            if parsed.account_id.is_empty() || parsed.session_token.is_empty() {
                return Err(AccountAuthError::InvalidResponse);
            }
            Ok(IssuedSession {
                account_id: parsed.account_id,
                session_token: parsed.session_token,
                expires_at_milliseconds: parsed.expires_at_milliseconds,
            })
        }
        401 => Err(AccountAuthError::InvalidCredentials),
        409 => Err(AccountAuthError::EmailTaken),
        400 => Err(AccountAuthError::InvalidInput),
        _ => Err(AccountAuthError::InvalidResponse),
    }
}

pub fn parse_enrollment_response(
    status: u16,
    body: &str,
) -> Result<bool, AccountAuthError> {
    match status {
        200 => {
            #[derive(Deserialize)]
            struct EnrollmentBody {
                ok: bool,
            }
            let parsed: EnrollmentBody =
                serde_json::from_str(body).map_err(|_| AccountAuthError::InvalidResponse)?;
            if parsed.ok {
                Ok(true)
            } else {
                Err(AccountAuthError::EnrollmentRejected)
            }
        }
        401 => Err(AccountAuthError::SessionExpired),
        _ => Err(AccountAuthError::EnrollmentRejected),
    }
}

/// Cliente HTTP de `/api/auth`. Bloqueante y deliberadamente simple: login,
/// registro y logout son llamadas puntuales, no tráfico continuo.
pub struct AccountAuthClient {
    pub origin: String,
}

impl AccountAuthClient {
    pub fn from_worker_url(worker_url: &str) -> Option<Self> {
        origin_from_worker_url(worker_url).map(|origin| Self { origin })
    }

    fn post(&self, path: &str, json_body: &str, bearer: Option<&str>) -> Result<(u16, String), AccountAuthError> {
        let agent = ureq::AgentBuilder::new().build();
        let mut request = agent
            .post(format!("{}{path}", self.origin).as_str())
            .set("Content-Type", "application/json");
        if let Some(token) = bearer {
            request = request.set("Authorization", &format!("Bearer {token}"));
        }
        let result = request.send_string(json_body);
        match result {
            Ok(response) => Ok((response.status(), response.into_string().unwrap_or_default())),
            Err(ureq::Error::Status(code, response)) => {
                Ok((code, response.into_string().unwrap_or_default()))
            }
            Err(_) => Err(AccountAuthError::Unreachable),
        }
    }

    fn get(&self, path: &str, bearer: &str) -> Result<(u16, String), AccountAuthError> {
        let agent = ureq::AgentBuilder::new().build();
        let result = agent
            .get(format!("{}{path}", self.origin).as_str())
            .set("Authorization", &format!("Bearer {bearer}"))
            .call();
        match result {
            Ok(response) => Ok((response.status(), response.into_string().unwrap_or_default())),
            Err(ureq::Error::Status(code, response)) => {
                Ok((code, response.into_string().unwrap_or_default()))
            }
            Err(_) => Err(AccountAuthError::Unreachable),
        }
    }

    pub fn register(&self, email: &str, password: &str) -> Result<IssuedSession, AccountAuthError> {
        let body = serde_json::json!({ "email": email, "password": password }).to_string();
        let (status, text) = self
            .post("/api/auth/register", &body, None)
            .map_err(|error| match error {
                AccountAuthError::Unreachable => AccountAuthError::Unreachable,
                other => other,
            })?;
        parse_issued_session(status, &text)
    }

    pub fn login(&self, email: &str, password: &str) -> Result<IssuedSession, AccountAuthError> {
        let body = serde_json::json!({ "email": email, "password": password }).to_string();
        let (status, text) = self.post("/api/auth/login", &body, None)?;
        parse_issued_session(status, &text)
    }

    pub fn logout(&self, session_token: &str) -> Result<bool, AccountAuthError> {
        let (status, _) = self.post("/api/auth/logout", "{}", Some(session_token))?;
        Ok(status == 200)
    }

    /// Cuenta viva para este token, o `None` si expiró/revocó.
    pub fn resolve_session_account(&self, session_token: &str) -> Result<Option<String>, AccountAuthError> {
        let (status, text) = self.get("/api/auth/session", session_token)?;
        if status != 200 {
            return Ok(None);
        }
        #[derive(Deserialize)]
        struct SessionBody {
            #[serde(rename = "authenticated")]
            authenticated: bool,
            #[serde(rename = "accountId", default)]
            account_id: String,
        }
        let parsed: SessionBody =
            serde_json::from_str(&text).map_err(|_| AccountAuthError::InvalidResponse)?;
        Ok(if parsed.authenticated && !parsed.account_id.is_empty() {
            Some(parsed.account_id)
        } else {
            None
        })
    }

    pub fn enroll_device(
        &self,
        session_token: &str,
        device_id: &str,
        device_type: &str,
        device_name: &str,
    ) -> Result<bool, AccountAuthError> {
        let body = serde_json::json!({
            "deviceId": device_id,
            "deviceType": device_type,
            "deviceName": device_name,
        })
        .to_string();
        let (status, text) = self.post("/api/auth/devices", &body, Some(session_token))?;
        parse_enrollment_response(status, &text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deriva_el_origen_https_de_una_url_wss() {
        assert_eq!(
            origin_from_worker_url("wss://apollo.example.workers.dev/agents/apollo/default"),
            Some("https://apollo.example.workers.dev".to_string()),
        );
        assert_eq!(
            origin_from_worker_url("ws://127.0.0.1:8799/agents/apollo/default"),
            Some("http://127.0.0.1:8799".to_string()),
        );
        assert_eq!(origin_from_worker_url("no-es-una-url"), None);
    }

    #[test]
    fn la_url_de_cuenta_reemplaza_la_ruta_y_no_expone_el_token() {
        let url = account_conversation_url(
            "wss://apollo.example.workers.dev/agents/apollo/default",
            "acc_abc123def456abc123def456abc12345",
        )
        .unwrap();
        assert_eq!(
            url,
            "wss://apollo.example.workers.dev/agents/apollo/acct-acc_abc123def456abc123def456abc12345",
        );
        assert!(!url.contains("Bearer"));
        // Sin cuenta no hay URL de cuenta: no se cae al `default`.
        assert_eq!(
            account_conversation_url("wss://apollo.example.workers.dev/agents/apollo/default", ""),
            None,
        );
    }

    #[test]
    fn lee_la_cuenta_de_vuelta_desde_la_url_sin_confundir_rutas() {
        let account_url = account_conversation_url(
            "wss://apollo.example.workers.dev/agents/apollo/default",
            "acc_abc123def456abc123def456abc12345",
        )
        .unwrap();
        assert_eq!(
            account_id_from_conversation_url(&account_url),
            Some("acc_abc123def456abc123def456abc12345".to_string()),
        );
        // La ruta legacy `default` NO es una cuenta.
        assert_eq!(
            account_id_from_conversation_url("wss://apollo.example.workers.dev/agents/apollo/default"),
            None,
        );
    }

    #[test]
    fn parsea_la_sesion_emitida_y_distingue_rechazos() {
        let issued = parse_issued_session(
            200,
            r#"{"accountId":"acc_abc123def456abc123def456abc12345","sessionToken":"tok1234567890abcdef","expiresAt":1700000000000}"#,
        )
        .unwrap();
        assert_eq!(issued.account_id, "acc_abc123def456abc123def456abc12345");
        assert_eq!(issued.session_token, "tok1234567890abcdef");
        assert_eq!(
            parse_issued_session(401, r#"{"error":"invalid_credentials"}"#),
            Err(AccountAuthError::InvalidCredentials),
        );
        assert_eq!(
            parse_issued_session(409, r#"{"error":"email_taken"}"#),
            Err(AccountAuthError::EmailTaken),
        );
        assert_eq!(
            parse_issued_session(400, r#"{"error":"invalid_input"}"#),
            Err(AccountAuthError::InvalidInput),
        );
        assert_eq!(parse_issued_session(500, "boom"), Err(AccountAuthError::InvalidResponse));
        assert_eq!(
            parse_issued_session(200, r#"{"accountId":"","sessionToken":""}"#),
            Err(AccountAuthError::InvalidResponse),
        );
    }

    #[test]
    fn el_enrolamiento_solo_pasa_si_el_worker_lo_confirma() {
        assert_eq!(
            parse_enrollment_response(200, r#"{"ok":true,"accountId":"acc_test"}"#),
            Ok(true),
        );
        assert_eq!(
            parse_enrollment_response(200, r#"{"ok":false}"#),
            Err(AccountAuthError::EnrollmentRejected),
        );
        assert_eq!(
            parse_enrollment_response(401, r#"{"error":"unauthorized"}"#),
            Err(AccountAuthError::SessionExpired),
        );
    }
}
