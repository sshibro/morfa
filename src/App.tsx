import {lazy, Suspense, useCallback, useEffect, useRef, useState} from 'react';
// The design area is reached only through import(): the app's first load carries the shell and the sign-in, never
// the editor (docs/design-tool.md §Rules "Bundle"). Types come in statically, code does not.
import type {DesignHandle} from './design/DesignRoot';
import {apiAccount, SESSION_CHANGED_EVENT, setApiAccount} from './api';
import {AuthShell} from './auth/AuthShell';
import {SignIn} from './auth/SignIn';
import {isOperatorConfig, setOperator} from './auth/operator';
import {readConfig, readSession, signOut, type Account} from './auth/session';
import {isAdminHash, NAVIGATION_EVENT, navigationFromUrl, navigationUrl, normalizeNavigation, type NavigationRequest, type NavigationTarget} from './navigation';
import {Splash} from './Splash';
import {errorText} from './design/ui/error-text';
import {primeSupportConfig} from './support/support-config';
import {installBigFiles} from '../shared/design/big-files';

// Morfa's shell: the session, the sign-in, and the design area at #designs (the file browser) and #design/<id> (a file,
// its board or its player); for operators also the console at #admin… (src/admin, its own chunk; /api/config says `admin`).
// Leaving a file awaits its last save first (DesignHandle.save); a failed save keeps the file open and offers the same step again.
// A person who has just signed in lands on the file browser, like anyone who opens the app, unless the address names a file.

const DesignRoot = lazy(() => import('./design/DesignRoot'));
// The operator's console: only operators ever load it, so it never weighs on anyone's first load.
const AdminRoot = lazy(() => import('./admin/AdminRoot'));

type Session = {status: 'loading'} | {status: 'unreachable'} | {status: 'signed-out'} | {status: 'signed-in'; account: Account};
type Notice = {text: string; retry: NavigationRequest};

const here = () => location.pathname + location.search + location.hash;
const fileIdOf = (target: NavigationTarget) => (target.kind === 'design' ? target.fileId : null);
const adminOf = (target: NavigationTarget) => target.kind === 'admin';
const apiAccountIs = (id: string) => apiAccount() === id;

/** Every address that is not a file (or, for an operator, the console) is the file browser's. `admin` null: not known yet (the
 *  config is still on its way), so a console address waits for it. */
function settleAddress(admin: boolean | null) {
  if (admin === null && isAdminHash(location.hash)) return;
  const target = navigationFromUrl(location, {admin: admin === true});
  if (target.kind === 'workspace' && location.hash !== '#designs') history.replaceState(history.state, '', navigationUrl(target, location));
}

export function App() {
  const [session, setSession] = useState<Session>({status: 'loading'});
  const [fileId, setFileId] = useState<string | null>(() => fileIdOf(navigationFromUrl(location)));
  // The console is open (#admin…): only while the account is an operator, which `operator` follows (the config read for it).
  const [inAdmin, setInAdmin] = useState(false);
  const [operator, setOperatorState] = useState(false);
  const operatorRef = useRef(false);
  // The account the config was read for: another account (a sign-in, a switch) reads it again, `admin` is per account.
  const configFor = useRef<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const designRef = useRef<DesignHandle>(null);
  const committed = useRef('');

  const becomeOperator = useCallback((next: boolean) => {
    operatorRef.current = next;
    setOperatorState(next);
    setOperator(next);
  }, []);

  const show = useCallback((target: NavigationTarget) => {
    setFileId(fileIdOf(target));
    setInAdmin(adminOf(target));
  }, []);

  const enter = useCallback((account: Account | null) => {
    setApiAccount(account?.id ?? null);
    if (!account || configFor.current !== account.id) becomeOperator(false);
    if (account) {
      // The address may have changed while nobody was signed in (no listener follows it then): read what opens again.
      show(navigationFromUrl(location, {admin: operatorRef.current}));
      committed.current = here();
      // Signed in here (not at boot) or another account: its config may say more (`admin`).
      if (configFor.current !== account.id) {
        readConfig().then(next => {
          if (apiAccountIs(account.id)) {
            configFor.current = account.id;
            becomeOperator(isOperatorConfig(next));
          }
        }, () => undefined);
      }
    } else {
      configFor.current = null;
    }
    setSession(account ? {status: 'signed-in', account} : {status: 'signed-out'});
  }, [becomeOperator, show]);

  const boot = useCallback((signal: AbortSignal) => {
    setSession({status: 'loading'});
    Promise.all([readSession(signal), readConfig(signal)]).then(([account, next]) => {
      primeSupportConfig(next);
      installBigFiles(next.bigFiles as boolean | undefined);
      configFor.current = account?.id ?? null;
      becomeOperator(!!account && isOperatorConfig(next));
      // A console address stays only for an operator; anyone else lands on the file browser, as on any other address.
      settleAddress(operatorRef.current);
      enter(account);
    }, () => {
      if (!signal.aborted) setSession({status: 'unreachable'});
    });
  }, [enter, becomeOperator]);

  useEffect(() => {
    settleAddress(null);
    committed.current = here();
    const controller = new AbortController();
    boot(controller.signal);
    return () => controller.abort();
  }, [boot]);

  const go = useCallback(async (request: NavigationRequest, fromHistory = false) => {
    const asked = normalizeNavigation(request);
    const target: NavigationTarget = asked.kind === 'admin' && !operatorRef.current ? {kind: 'workspace', view: 'designs'} : asked;
    setNotice(null);
    try {
      await designRef.current?.save();
      if (target.kind === 'sign-out') await signOut();
    } catch (error) {
      if (fromHistory) history.pushState(history.state, '', committed.current);
      setNotice({text: errorText(error, target.kind === 'sign-out' ? 'Could not sign out. Try again.' : 'Could not save the changes.'), retry: request});
      return;
    }
    if (target.kind === 'sign-out') {
      history.pushState(history.state, '', navigationUrl({view: 'designs'}, location));
      committed.current = here();
      show({kind: 'workspace', view: 'designs'});
      enter(null);
      return;
    }
    if (!fromHistory) {
      const url = navigationUrl(target, location);
      if (url !== here()) history.pushState(history.state, '', url);
    }
    committed.current = here();
    show(target);
  }, [enter, show]);

  // In-app requests (the file browser, the editor's menus) and the browser's own back and forward.
  useEffect(() => {
    if (session.status !== 'signed-in') return;
    const requested = (event: Event) => {
      const detail = (event as CustomEvent<NavigationRequest>).detail;
      if (detail) void go(detail);
    };
    // popstate and hashchange both arrive for one step back: follow each address once.
    let following = '';
    const followHistory = () => {
      if (here() === committed.current || here() === following) return;
      settleAddress(operatorRef.current);
      following = here();
      void go(navigationFromUrl(location, {admin: operatorRef.current}), true).finally(() => {
        following = '';
      });
    };
    window.addEventListener(NAVIGATION_EVENT, requested);
    window.addEventListener('popstate', followHistory);
    window.addEventListener('hashchange', followHistory);
    // An address that changed while the session was still loading (a pasted link, a script's goto) had no listener yet.
    followHistory();
    return () => {
      window.removeEventListener(NAVIGATION_EVENT, requested);
      window.removeEventListener('popstate', followHistory);
      window.removeEventListener('hashchange', followHistory);
    };
  }, [session.status, go]);

  // The server ended the session or the cookie now belongs to another account: read it again.
  useEffect(() => {
    const changed = () => {
      readSession().then(account => {
        if (account?.id !== (session.status === 'signed-in' ? session.account.id : undefined)) enter(account);
      }, () => undefined);
    };
    window.addEventListener(SESSION_CHANGED_EVENT, changed);
    return () => window.removeEventListener(SESSION_CHANGED_EVENT, changed);
  }, [session, enter]);

  // The account stopped being an operator (another account's config) while the console was open: back to the file browser.
  useEffect(() => {
    if (!inAdmin || operator) return;
    settleAddress(false);
    committed.current = here();
    show({kind: 'workspace', view: 'designs'});
  }, [inAdmin, operator, show]);

  if (session.status === 'loading') return <Splash />;
  if (session.status === 'unreachable') return <Unreachable onRetry={() => boot(new AbortController().signal)} />;
  if (session.status === 'signed-out')
    return <SignIn onSignedIn={enter} />;
  return (
    <>
      <Suspense fallback={<Splash />}>
        {inAdmin && operator
          ? <AdminRoot key={session.account.id} account={session.account} />
          : <DesignRoot key={session.account.id} ref={designRef} fileId={fileId} />}
      </Suspense>
      {notice && (
        <div className="mf-notice" role="alert">
          <span className="mf-notice-text">{notice.text}</span>
          <button type="button" onClick={() => void go(notice.retry)}>Retry</button>
        </div>
      )}
    </>
  );
}

function Unreachable({onRetry}: {onRetry: () => void}) {
  return (
    <AuthShell labelledBy="mf-unreachable-title">
      <h1 className="mf-auth-title" id="mf-unreachable-title">The server did not respond</h1>
      <p className="mf-auth-note">Check your connection and try again.</p>
      <div className="mf-auth-form">
        <button className="mf-auth-button" type="button" onClick={onRetry}>Retry</button>
      </div>
    </AuthShell>
  );
}
