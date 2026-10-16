import {useId, useState, type FormEvent} from 'react';
import {ApiError} from '../api';
import {NAME_MAX_LENGTH, NAME_PROBLEM_TEXT, checkName} from '../../shared/sign-in';
import {nameSignIn, type Account} from './session';

const messageOf = (error: unknown) =>
  error instanceof ApiError || error instanceof Error ? error.message : 'Could not sign in. Try again.';

/** The sign-in: one field for the name, one button. The same name is always the same account (server/accounts.ts). */
export function NameSignInForm({onSignedIn}: {onSignedIn: (account: Account) => void}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fieldId = useId();
  const errorId = useId();
  const hintId = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const checked = checkName(name);
    if (!checked.ok) {
      setError(NAME_PROBLEM_TEXT[checked.problem]);
      return;
    }
    setBusy(true);
    setError('');
    try {
      onSignedIn(await nameSignIn(checked.name));
    } catch (cause) {
      setError(messageOf(cause));
      setBusy(false);
    }
  };

  return (
    <form className="mf-auth-form" onSubmit={submit} noValidate>
      <label className="mf-auth-label" htmlFor={fieldId}>Your name</label>
      <input
        id={fieldId}
        className="mf-auth-input"
        type="text"
        name="name"
        autoComplete="nickname"
        autoFocus
        spellCheck={false}
        maxLength={NAME_MAX_LENGTH * 2}
        value={name}
        onChange={event => setName(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${hintId} ${errorId}` : hintId}
      />
      <p className="mf-auth-hint" id={hintId}>Others in your files see this name. There is no password: the same name always opens the same account.</p>
      <button className="mf-auth-button" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Continue'}</button>
      {error && <p className="mf-auth-error" id={errorId} role="alert">{error}</p>}
    </form>
  );
}
