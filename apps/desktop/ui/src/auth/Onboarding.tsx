import { useState } from 'react';
import type { FormEvent } from 'react';

import { useAppStore } from '@/store';
import { Field, PrimaryButton, Sparkle } from './parts';

const MAX_NAME_LENGTH = 40;

/**
 * Onboarding posterior al registro.
 *
 * El registro NO pide nombre porque `POST /api/auth/register` solo acepta
 * `email` y `password` (apps/agent/src/auth/routes.ts:45-51). No existe
 * endpoint para guardar un nombre, asi que lo que se recoge aca es un dato
 * LOCAL de este equipo: se persiste en el store de la app y se dice, en la
 * misma pantalla, que todavÃ­a no viaja a la cuenta.
 */
export function Onboarding() {
  const completeOnboarding = useAppStore((s) => s.completeOnboarding);
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);

  const trimmedName = name.trim();
  const isValid = trimmedName.length > 0 && trimmedName.length <= MAX_NAME_LENGTH;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!isValid) return;
    completeOnboarding(trimmedName);
  };

  return (
    <div className="ac">
      <div className="ac-blobs" aria-hidden>
        <i />
        <i />
        <i />
      </div>
      <div className="ac-screen">
        <form className="ac-form" onSubmit={submit} noValidate>
          <div className="ac-welcome-top">
            <Sparkle size={56} />
          </div>
          <h1 className="ac-h">¿Cómo te llamamos?</h1>
          <p className="ac-sub">
            Tu cuenta ya está creada. Falta un detalle para que Apollo te hable
            como vos.
          </p>
          <Field
            label="Tu nombre"
            autoComplete="name"
            autoFocus
            value={name}
            onChange={setName}
            maxLength={MAX_NAME_LENGTH}
            invalid={touched && !isValid}
            hint={
              touched && !isValid
                ? 'Escribí un nombre de hasta 40 caracteres.'
                : undefined
            }
          />
          <p className="ac-hint ac-onboarding-note">
            Este nombre se guarda en este equipo. Tu cuenta en la nube todavía no
            lo almacena: cuando exista esa operación, se sincronizará.
          </p>
          <div className="ac-foot">
            <PrimaryButton busy={false} disabled={touched && !isValid}>
              Empezar
            </PrimaryButton>
          </div>
        </form>
      </div>
    </div>
  );
}