import { beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createInMemoryEnrollmentStore } from '@/devices/credential-store';
import { claimEnrollmentChallenge, type EnrollmentStore } from '@/devices/enrollment';
import {
  authorizeMobileDeviceRequest,
  handleEnrollmentChallengeRequest,
  handleEnrollmentClaimRequest,
  handleEnrollmentRevokeRequest,
  MOBILE_BRIDGE_ROUTE_PREFIX,
} from '@/devices/route';

const DASHBOARD_SECRET = 'block-12-2-1-secreto-del-dueno';
const DEVICE_SECRET = 'block-12-2-1-secreto-de-device';
const PHONE_ID = 'mobile:probe-auth';

const NOW = 1_760_000_000_000;

const ENVIRONMENT = {
  DASHBOARD_SHARED_SECRET: DASHBOARD_SECRET,
  DEVICE_SHARED_SECRET: DEVICE_SECRET,
} as unknown as Env;

type RequestHeaderList = Record<string, string>;

function buildRequest(
  path: string,
  body: unknown,
  headerList: RequestHeaderList = {},
): Request {
  return new Request(`https://apollo.example/agents/mobile-bridge/mobile${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headerList },
    body: JSON.stringify(body),
  });
}

function withOwnerAuthorization(): RequestHeaderList {
  return { Authorization: `Bearer ${DASHBOARD_SECRET}` };
}

describe('B12.2.1: el dueño se autentica con Authorization y sólo con Authorization', () => {
  let store: EnrollmentStore;

  beforeEach(() => {
    store = createInMemoryEnrollmentStore();
  });

  async function requestChallenge(headerList: RequestHeaderList): Promise<Response> {
    return handleEnrollmentChallengeRequest({
      request: buildRequest('/enrollment/challenge', { deviceId: PHONE_ID }, headerList),
      environment: ENVIRONMENT,
      store,
      nowMilliseconds: NOW,
    });
  }

  describe('lo que SÍ autoriza', () => {
    it('Authorization: Bearer con el secreto del dueño', async () => {
      const response = await requestChallenge(withOwnerAuthorization());
      expect(response.status).toBe(200);
      const body = (await response.json()) as { challenge: string };
      expect(body.challenge.length).toBeGreaterThan(0);
    });

    it('el esquema es case-insensitive, como dictamina el esquema de auth', async () => {
      // El valor NO se normaliza: sólo el nombre del esquema. Que el token sea
      // sensible a mayúsculas es lo correcto para un secreto.
      const response = await requestChallenge({
        Authorization: `bearer ${DASHBOARD_SECRET}`,
      });
      expect(response.status).toBe(200);
    });
  });

  describe('lo que NO autoriza', () => {
    it('sin nada', async () => {
      expect((await requestChallenge({})).status).toBe(401);
    });

    it('Authorization: Bearer con un secreto equivocado', async () => {
      expect(
        (await requestChallenge({ Authorization: 'Bearer no-es-el-del-dueno' })).status,
      ).toBe(401);
    });

    it('el secreto de device no administra enrollment', async () => {
      // El ámbito legacy abre sockets, no emite desafíos. Si este caso pasara, un
      // teléfono con el secreto global podría pedir credenciales a nombre de
      // cualquier deviceId.
      expect(
        (await requestChallenge({ Authorization: `Bearer ${DEVICE_SECRET}` })).status,
      ).toBe(401);
    });

    it('?token= por sí solo no autoriza enrollment', async () => {
      // Este es el punto del bloque. El README decía `?token=` y respondía 401.
      const response = await handleEnrollmentChallengeRequest({
        request: buildRequest(`/enrollment/challenge?token=${DASHBOARD_SECRET}`, {
          deviceId: PHONE_ID,
        }),
        environment: ENVIRONMENT,
        store,
        nowMilliseconds: NOW,
      });
      expect(response.status).toBe(401);
    });

    it('?token= con el secreto equivocado tampoco', async () => {
      const response = await handleEnrollmentChallengeRequest({
        request: buildRequest(`/enrollment/challenge?token=${DEVICE_SECRET}`, {
          deviceId: PHONE_ID,
        }),
        environment: ENVIRONMENT,
        store,
        nowMilliseconds: NOW,
      });
      expect(response.status).toBe(401);
    });

    it('otro esquema de autenticación', async () => {
      expect(
        (await requestChallenge({ Authorization: `Basic ${DASHBOARD_SECRET}` })).status,
      ).toBe(401);
    });

    it('el cuerpo no vale como credencial', async () => {
      // Mandar el secreto en el body no es autenticación.
      const response = await handleEnrollmentChallengeRequest({
        request: buildRequest('/enrollment/challenge', {
          deviceId: PHONE_ID,
          dashboardSecret: DASHBOARD_SECRET,
        }),
        environment: ENVIRONMENT,
        store,
        nowMilliseconds: NOW,
      });
      expect(response.status).toBe(401);
    });
  });

  describe('ningún rechazo deja trabajo a medias', () => {
    it('un 401 no emite ningún desafío y no filtra uno', async () => {
      // Si el handler guardara el desafío antes de autorizar, el rechazo dejaría
      // una fila viva que el dueño no pidió. Y si el 401 devolviera el cuerpo del
      // éxito, el atacante leería el desafío del dueño en su propio error.
      const rejected = await requestChallenge({
        Authorization: 'Bearer no-es-el-del-dueno',
      });
      expect(await rejected.text()).toBe('Unauthorized');
      // Y nada se guardó: no existe ninguna credencial, que es lo único que el
      // store in-memory deja contar sin exponer las filas de desafíos.
      expect(await store.listCredentialRecordList()).toEqual([]);

      const alsoRejected = await requestChallenge({});
      expect(alsoRejected.status).toBe(401);

      // Después de los rechazos, el dueño sigue recibiendo un desafío válido.
      const accepted = await requestChallenge(withOwnerAuthorization());
      expect(accepted.status).toBe(200);
      const body = (await accepted.json()) as { challenge: string };
      expect(body.challenge.length).toBeGreaterThan(0);
    });

    it('un 401 no revoca nada', async () => {
      // Se enrola de verdad, después se intenta revocar sin credencial.
      const issued = await handleEnrollmentChallengeRequest({
        request: buildRequest(
          '/enrollment/challenge',
          { deviceId: PHONE_ID },
          withOwnerAuthorization(),
        ),
        environment: ENVIRONMENT,
        store,
        nowMilliseconds: NOW,
      });
      const { challenge } = (await issued.json()) as { challenge: string };
      await handleEnrollmentClaimRequest({
        request: buildRequest('/enrollment/claim', { challenge, deviceId: PHONE_ID }),
        store,
        nowMilliseconds: NOW,
      });

      const rejected = await handleEnrollmentRevokeRequest({
        request: buildRequest('/enrollment/revoke', { deviceId: PHONE_ID }, {}),
        environment: ENVIRONMENT,
        store,
        nowMilliseconds: NOW,
        revoke: async () => 'closed_socket',
      });
      expect(rejected.status).toBe(401);
      // La revocación NO se aplicó: el socket sigue vivo y la fila sigue activa.
      expect((await store.readCredential(PHONE_ID))?.status).toBe('active');
    });

    it('un 401 tampoco consume un desafío ya emitido', async () => {
      // El desafío lo emite el dueño una vez; que un rechazo posterior no lo
      // gaste es lo que impide que un atacante que adivine el deviceId pueda
      // invalidar el enrolamiento de otro teléfono.
      const issued = await handleEnrollmentChallengeRequest({
        request: buildRequest(
          '/enrollment/challenge',
          { deviceId: PHONE_ID },
          withOwnerAuthorization(),
        ),
        environment: ENVIRONMENT,
        store,
        nowMilliseconds: NOW,
      });
      const { challenge } = (await issued.json()) as { challenge: string };

      await handleEnrollmentChallengeRequest({
        request: buildRequest(`/enrollment/challenge?token=${DASHBOARD_SECRET}`, {
          deviceId: PHONE_ID,
        }),
        environment: ENVIRONMENT,
        store,
        nowMilliseconds: NOW,
      });
      await handleEnrollmentRevokeRequest({
        request: buildRequest(`/enrollment/revoke?token=${DASHBOARD_SECRET}`, {
          deviceId: PHONE_ID,
        }),
        environment: ENVIRONMENT,
        store,
        nowMilliseconds: NOW,
        revoke: async () => 'closed_socket',
      });

      // El desafío sigue vivo: el teléfono rightful todavía puede canjearlo.
      const claim = await claimEnrollmentChallenge({
        store,
        challenge,
        deviceId: PHONE_ID,
        nowMilliseconds: NOW,
        isDeviceIdValid: () => true,
      });
      expect(claim.status).toBe('enrolled');
      // El discriminante se estrecha recién acá: si el claim hubiera rechazado,
      // `credential` no existiría y el test no llegaría a leerla.
      expect(claim.status === 'enrolled' && claim.credential.length > 0).toBe(true);
    });
  });
  describe('los cuatro contratos no son intercambiables', () => {
    // El bug de este bloque fue documental, pero la causa de fondo es que los
    // caminos se confundían entre sí. Esta tabla los fija uno por uno.
    async function authorizesSocket(request: Request): Promise<boolean> {
      const decision = await authorizeMobileDeviceRequest({
        request,
        environment: ENVIRONMENT,
      });
      return decision.isAuthorized;
    }

    it('el camino legacy del socket sigue siendo ?token= con el secreto de device', async () => {
      const request = new Request(
        `https://apollo.example${MOBILE_BRIDGE_ROUTE_PREFIX}/mobile?token=${DEVICE_SECRET}`,
      );
      expect(await authorizesSocket(request)).toBe(true);
    });

    it('el secreto del dueño NO abre el socket mobile', async () => {
      // Si esto pasara, el dashboard podría abrir conexiones como si fuera un
      // teléfono, y la revocación dejaría de cerrar las que le importan.
      const request = new Request(
        `https://apollo.example${MOBILE_BRIDGE_ROUTE_PREFIX}/mobile?token=${DASHBOARD_SECRET}`,
      );
      expect(await authorizesSocket(request)).toBe(false);
    });

    it('el secreto de device NO administra enrollment', async () => {
      // La contraparte exacta del caso anterior: los dos secretos van al revés
      // y los dos rechazos son 401.
      const response = await handleEnrollmentChallengeRequest({
        request: buildRequest(`/enrollment/challenge?token=${DEVICE_SECRET}`, {
          deviceId: PHONE_ID,
        }),
        environment: ENVIRONMENT,
        store,
        nowMilliseconds: NOW,
      });
      expect(response.status).toBe(401);
    });

    it('un bearer con Authorization impide caerse al camino legacy', async () => {
      // Si viene Authorization, ése es el ámbito y el `?token=` se ignora. Con un
      // bearer que ni tiene forma de credencial, el resultado es 401 y no una
      // caída silenciosa al secreto global: ese es el bypass a impedir.
      const requestWithUnshapedBearer = new Request(
        `https://apollo.example${MOBILE_BRIDGE_ROUTE_PREFIX}/mobile?token=${DEVICE_SECRET}`,
        { headers: { Authorization: 'Bearer no-es-una-credencial' } },
      );
      expect(await authorizesSocket(requestWithUnshapedBearer)).toBe(false);
    });

    it('el borde acepta la FORMA y el DO verifica contra el store', async () => {
      // Documentado a propósito, porque parece una contradicción del caso
      // anterior: un bearer bien formado pasa el borde y muere en el hello. El
      // borde no tiene el store —consultarlo sería un round-trip por conexión— y
      // la revocación vive en el DO. Por eso el alcance aquí es 'enrolled', y no
      // 'autorizado'.
      const requestWithShapedBearer = new Request(
        `https://apollo.example${MOBILE_BRIDGE_ROUTE_PREFIX}/mobile?token=${DEVICE_SECRET}`,
        { headers: { Authorization: 'Bearer apollo_dev_0000000000000000000000' } },
      );
      const decision = await authorizeMobileDeviceRequest({
        request: requestWithShapedBearer,
        environment: ENVIRONMENT,
      });
      expect(decision.isAuthorized).toBe(true);
      // Y el ámbito es el enrolado, nunca el legacy: el `?token=` no se usó.
      expect(decision.isAuthorized && decision.auth.scope).toBe('enrolled_android');
    });
  });

  describe('la documentacion dice lo que el codigo hace', () => {
    it('isOwnerAuthorized no lee el queryParam', () => {
      // La regresion que casi vuelve: que alguien reintroduzca el fallback "por
      // compatibilidad". Los tests funcionales de arriba lo detectan en
      // comportamiento; este lo detecta en el punto exacto del cambio.
      const routeSource = readFileSync(join(import.meta.dir, '..', 'route.ts'), 'utf8');
      const functionBody = readFunctionBody(routeSource, 'function isOwnerAuthorized(');
      expect(functionBody).toContain('readBearerCredentialFromRequest');
      expect(functionBody).not.toContain('readDeviceTokenFromRequestUrl');
      expect(functionBody).not.toContain('searchParams');
    });

    it('el README de mobile no manda el token del dueno en la URL', async () => {
      const readmeSource = await Bun.file(
        join(import.meta.dir, '..', '..', '..', '..', 'mobile', 'README.md'),
      ).text();
      // El bug real: el README decia /enrollment/challenge?token= y devolvia 401.
      expect(readmeSource).not.toMatch(/enrollment\/(challenge|revoke)\?token=/);
      expect(readmeSource).toContain('Authorization: Bearer <DASHBOARD_SHARED_SECRET>');
    });

    it('el documento de fuente de verdad tampoco', async () => {
      const documentSource = await Bun.file(
        join(
          import.meta.dir,
          '..',
          '..',
          '..',
          '..',
          '..',
          'APOLLO_ANDROID_SOURCE_OF_TRUTH.md',
        ),
      ).text();
      expect(documentSource).not.toMatch(
        /enrollment\/(challenge|revoke)[^|\n]*\|[^|\n]*\?token=/,
      );
    });
  });
});

/** El cuerpo de una funcion de nivel superior, para poder afirmar sobre su interior. */
function readFunctionBody(source: string, signatureFragment: string): string {
  const signatureIndex = source.indexOf(signatureFragment);
  if (signatureIndex === -1) {
    throw new Error('no se encontro la funcion');
  }
  const openBraceIndex = source.indexOf('{', signatureIndex);
  let depth = 0;
  for (let index = openBraceIndex; index < source.length; index += 1) {
    if (source[index] === '{') {
      depth += 1;
      continue;
    }
    if (source[index] !== '}') {
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      return source.slice(openBraceIndex, index + 1);
    }
  }
  throw new Error('el cuerpo no cierra');
}
