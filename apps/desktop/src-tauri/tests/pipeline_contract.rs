use apollo_desktop::updates::{audit_manifest, CHANNEL_STABLE};

/// FASE 3.4 (C2) — prueba de contrato entre el generador y la auditoría.
///
/// Lee un `latest.json` REAL producido por `scripts/generate-update-manifest.ts`
/// y lo pasa por la auditoría de Rust. Si el generador publica una forma que la
/// app no sabe leer, o si la auditoría rechaza algo que sí es válido, este test
/// cae. Es el punto donde se juntan "lo que se publica" y "lo que se verifica".
///
/// El fixture se regenera con:
///   bun scripts/generate-update-manifest.ts \
///     --channel stable --version 1.4.1 --android-version-code 10401 \
///     --windows-setup <setup.exe> --android-apk <apk> \
///     --out-latest apps/desktop/src-tauri/tests/fixtures/latest.json \
///     --out-android apps/desktop/src-tauri/tests/fixtures/android.json
///
/// `APOLLO_MANIFEST_FIXTURE` permite apuntar a otro archivo para comprobar un
/// manifiesto recién generado sin tocar el fixture versionado.
#[test]
fn el_manifiesto_real_del_generador_pasa_la_auditoria() {
    let ruta = std::env::var("APOLLO_MANIFEST_FIXTURE").unwrap_or_else(|_| {
        format!(
            "{}/tests/fixtures/latest.json",
            env!("CARGO_MANIFEST_DIR")
        )
    });
    let cuerpo = std::fs::read_to_string(&ruta)
        .unwrap_or_else(|error| panic!("no se pudo leer {ruta}: {error}"));

    // Cliente de escritorio con la versión de fábrica: la actualización se
    // ofrece y trae los datos que la UI necesita.
    let decision = audit_manifest(&cuerpo, CHANNEL_STABLE, "1.4.1", "0.1.1", 0)
        .expect("el manifiesto que publica el pipeline debe auditar bien");
    assert_eq!(decision.version, "1.4.1");
    assert!(decision.download_url.starts_with("https://"));
    assert!(!decision.expected_signature.is_empty());

    // El escritorio no tiene versionCode: su gate de compatibilidad es la
    // versión SemVer, y una versión no más nueva se rechaza.
    let error = audit_manifest(&cuerpo, CHANNEL_STABLE, "1.4.1", "1.4.1", 0)
        .expect_err("instalarse a si mismo no es una actualizacion");
    assert!(
        error.mensaje_para_usuario().contains("no se instala"),
        "{}",
        error.mensaje_para_usuario()
    );

    // Un manifiesto de producción no se acepta en una app de staging.
    let error = audit_manifest(&cuerpo, "staging", "1.4.1", "0.1.1", 0)
        .expect_err("staging no puede tomar un manifiesto de produccion");
    assert!(
        error.mensaje_para_usuario().contains("no se instala"),
        "{}",
        error.mensaje_para_usuario()
    );

    // Y una app de producción tampoco acepta un número de versión que el
    // manifiesto no anuncia.
    let error = audit_manifest(&cuerpo, CHANNEL_STABLE, "9.9.9", "0.1.1", 0)
        .expect_err("no se puede instalar una version que el manifiesto no anuncia");
    assert!(
        error.mensaje_para_usuario().contains("no se instala"),
        "{}",
        error.mensaje_para_usuario()
    );
}