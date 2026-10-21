// SOLO PARA VISTA PREVIA DEL NAVEGADOR. En Android las respuestas vienen del puente nativo.
// Devuelve una sesion iniciada de ejemplo para poder recorrer las pantallas internas.
export const MOCK_RESPONSES: Record<string, unknown> = {
  account_status: { authenticated: true, account_id: 'acc_demo', email: 'facundo@example.com', session_valid: true },
  check_for_update: { status: { kind: 'none' } },
};
