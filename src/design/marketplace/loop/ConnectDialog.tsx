import {useState} from 'react';
import {LOOP_MARKETPLACE_NAMES, type LoopConnection, type LoopMarketplace} from '../../../../shared/design/marketplace/loop';
import {ApiError} from '../../../api';
import {Button} from '../../ui/Button';
import {Dialog} from '../../ui/Dialog';
import {TextInput} from '../../ui/TextInput';
import {connectMarketplace, replaceMarketplaceKey} from './api';

// "Connect Wildberries / Ozon" (docs/marketplaces.md §Performance Loop): the seller's API key, checked by the server with one cheap
// read before it is kept (encrypted, never shown again). With `connection` it is "Reconnect": a new key for a connection the
// marketplace refused; its links and numbers stay.

const HELP: Readonly<Record<LoopMarketplace, string>> = {
  wb: 'Create a token in the seller account: Profile → Settings → API access. Select the categories "Content" and "Analytics".',
  ozon: 'In Ozon Seller open Settings → Seller API and create a key with access to products and analytics. The Client-Id is there too.',
};

export function ConnectDialog({marketplace, connection, onClose, onDone}: {
  marketplace: LoopMarketplace;
  connection?: LoopConnection;
  onClose: () => void;
  onDone: (connection: LoopConnection) => void;
}) {
  const [token, setToken] = useState('');
  const [clientId, setClientId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = LOOP_MARKETPLACE_NAMES[marketplace];
  const ready = marketplace === 'wb' ? token.trim().length > 0 : clientId.trim().length > 0 && apiKey.trim().length > 0;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const named = label.trim() ? {label: label.trim()} : {};
      const answer = connection
        ? await replaceMarketplaceKey(connection.id, marketplace === 'wb' ? {token: token.trim()} : {clientId: clientId.trim(), apiKey: apiKey.trim()})
        : await connectMarketplace(
            marketplace === 'wb'
              ? {marketplace, ...named, token: token.trim()}
              : {marketplace, ...named, clientId: clientId.trim(), apiKey: apiKey.trim()},
          );
      onDone(answer.connection);
    } catch (caught) {
      setError(caught instanceof ApiError || caught instanceof Error ? caught.message : 'Could not connect. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={connection ? `Reconnect ${name}` : `Connect ${name}`}
      onClose={onClose}
      dismissible={false}
      width={420}
      className="dz-mp-loop-connect"
      footer={
        <>
          <Button size={32} onClick={onClose}>Cancel</Button>
          <Button size={32} variant="primary" busy={busy} disabled={!ready} onClick={submit}>{connection ? 'Save key' : 'Connect'}</Button>
        </>
      }>
      <form
        className="dz-mp-loop-form"
        onSubmit={event => {
          event.preventDefault();
          void submit();
        }}>
        <p className="dz-mp-loop-help">{HELP[marketplace]}</p>
        {marketplace === 'wb' ? (
          <label className="dz-mp-loop-field">
            <span>API token</span>
            <TextInput size={32} value={token} onChange={setToken} type="password" autoComplete="off" spellCheck={false} aria-invalid={!!error} />
          </label>
        ) : (
          <>
            <label className="dz-mp-loop-field">
              <span>Client-Id</span>
              <TextInput size={32} value={clientId} onChange={setClientId} inputMode="numeric" autoComplete="off" aria-invalid={!!error} />
            </label>
            <label className="dz-mp-loop-field">
              <span>Api-Key</span>
              <TextInput size={32} value={apiKey} onChange={setApiKey} type="password" autoComplete="off" spellCheck={false} aria-invalid={!!error} />
            </label>
          </>
        )}
        {!connection && (
          <label className="dz-mp-loop-field">
            <span>Name <span className="dz-mp-loop-quiet">— optional</span></span>
            <TextInput size={32} value={label} onChange={setLabel} maxLength={80} placeholder={`For example, ${name} - kitchenware`} />
          </label>
        )}
        {error && <p className="dz-mp-loop-error" role="alert">{error}</p>}
        <p className="dz-mp-loop-quiet">Morfa checks the key with one request and keeps it encrypted. It cannot be shown again.</p>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
