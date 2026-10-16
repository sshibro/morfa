import {useState} from 'react';
import {AuthShell} from './AuthShell';
import {NameSignInForm} from './NameSignInForm';
import {rememberInvite} from './invite';
import type {Account} from './session';

type SignInProps = {
  onSignedIn: (account: Account) => void;
};

/** The sign-in screen: asks for a display name and nothing else (docs/authentication.md). An invite link opened signed out says
 *  the name leads into the team. */
export function SignIn({onSignedIn}: SignInProps) {
  const [invited] = useState(() => rememberInvite());
  return (
    <AuthShell labelledBy="mf-auth-title">
      <h1 className="mf-auth-title" id="mf-auth-title">Welcome to Morfa</h1>
      {invited && <p className="mf-auth-invite" role="note">You were invited to a team. Enter your name to join it.</p>}
      <p className="mf-auth-note" role="note">What should we call you?</p>
      <NameSignInForm onSignedIn={onSignedIn} />
    </AuthShell>
  );
}
