import {useEffect, useRef, useState, type CSSProperties, type ReactNode} from 'react';
import {Button} from '../ui/Button';
import {Dialog} from '../ui/Dialog';
import {IconCheck, IconCopy} from '../ui/icons';
import {SegmentedControl} from '../ui/Tabs';
import {useToast} from '../ui/Toast';
import {disconnectAssistant, type AssistantConnection, type AssistantsState} from './api';
import {ConnectionPicture} from './Assistants';
import {ChatGptMark, ClaudeMark} from './marks';
import {ASSISTANT_SETTINGS, assistantKind, connectionLine, type AssistantKind} from './model';

// The "Connections" screen: what connecting gives, how to connect Claude, ChatGPT or a coding assistant in three steps, and the
// assistants connected now with "Disconnect". While it is open it looks again every few seconds, so an assistant the person has just
// allowed in another tab appears here on its own.

const POLL_MS = 4000;
type Tab = 'claude' | 'chatgpt' | 'code';
const TABS = [
  {value: 'claude', label: 'Claude'},
  {value: 'chatgpt', label: 'ChatGPT'},
  {value: 'code', label: 'For developers'},
] as const;

type Props = {
  state: AssistantsState;
  refresh: () => Promise<AssistantsState | null>;
  onClose: () => void;
};

export default function AssistantsDialog({state, refresh, onClose}: Props) {
  const [tab, setTab] = useState<Tab>('claude');
  const toast = useToast();
  // The connections seen when the screen opened or since: a new one is announced once and drawn in.
  const known = useRef(new Set(state.connections.map(connection => connection.id)));
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, POLL_MS);
    const back = () => document.visibilityState === 'visible' && void refresh();
    document.addEventListener('visibilitychange', back);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', back);
    };
  }, [refresh]);
  useEffect(() => {
    const added = state.connections.filter(connection => !known.current.has(connection.id));
    if (!added.length) return;
    for (const connection of added) known.current.add(connection.id);
    setFresh(new Set(added.map(connection => connection.id)));
    toast(added.length === 1 ? `${added[0]!.clientName} connected to Morfa` : `Assistants connected: ${added.length}`, {kind: 'success'});
  }, [state.connections, toast]);

  const kinds = new Set(state.connections.map(assistantKind));
  return (
    <Dialog title="Connections" onClose={onClose} width={560} className="dz-assist-dialog">
      <div className="dz-assist-hero">
        <ConnectionPicture size="large" live={{claude: kinds.has('claude'), chatgpt: kinds.has('chatgpt')}} />
        <h2 className="dz-assist-title">Your Claude or ChatGPT works right inside Morfa</h2>
        <p className="dz-assist-lead">
          Connect your assistant and it can build screens in your files, adjust a layout or turn it into code. Changes show up in the
          editor right away.
        </p>
      </div>
      <SegmentedControl options={TABS} value={tab} onChange={setTab} size={32} fill aria-label="Assistant" className="dz-assist-tabs" />
      <div className="dz-assist-steps" key={tab}>
        {tab === 'claude' && (
          <Steps>
            <Step n={1} title="Click the button: the Morfa address is copied and Claude connectors open">
              <AddButton kind="claude" url={state.url} />
            </Step>
            <Step n={2} title="There, click “Add custom connector”, name it Morfa and paste the address">
              <CopyField value={state.url} />
            </Step>
            <Step n={3} title="Click “Connect” and allow access in Morfa">
              <p>Done: ask Claude, for example, “Make a landing page for a coffee shop in Morfa”.</p>
            </Step>
          </Steps>
        )}
        {tab === 'chatgpt' && (
          <Steps>
            <Step n={1} title="Click the button: the Morfa address is copied and the ChatGPT apps open">
              <AddButton kind="chatgpt" url={state.url} />
            </Step>
            <Step n={2} title="There, click “+” → “Add custom MCP server”, name it Morfa, paste the address and choose OAuth sign-in">
              <CopyField value={state.url} />
              <p>If ChatGPT asks, turn on Developer mode in Settings → Apps → Advanced settings.</p>
            </Step>
            <Step n={3} title="Sign in to Morfa and allow access">
              <p>
                ChatGPT asks before every change to a file. To get the Morfa icon in the list, set it in the app menu (Manage):{' '}
                <a href="/logo-512.png" download="morfa.png">download the icon</a>.
              </p>
            </Step>
          </Steps>
        )}
        {tab === 'code' && (
          <Steps>
            <Step n={1} title="Claude Code: run this in a terminal, then /mcp to sign in">
              <CopyField value={`claude mcp add --transport http morfa ${state.url}`} mono />
            </Step>
            <Step n={2} title="Codex: add this to ~/.codex/config.toml, then run codex mcp login morfa">
              <CopyField value={`[mcp_servers.morfa]\nurl = "${state.url}"`} mono />
            </Step>
            <Step n={3} title="Cursor and others: enter the MCP server address">
              <CopyField value={state.url} />
            </Step>
          </Steps>
        )}
      </div>
      <Connected connections={state.connections} fresh={fresh} refresh={refresh} />
    </Dialog>
  );
}

function Steps({children}: {children: ReactNode}) {
  return <ol className="dz-assist-step-list">{children}</ol>;
}

function Step({n, title, children}: {n: number; title: string; children: ReactNode}) {
  return (
    <li className="dz-assist-step" style={{'--dz-assist-i': n} as CSSProperties}>
      <span className="dz-assist-step-n" aria-hidden="true">{n}</span>
      <div className="dz-assist-step-body">
        <p className="dz-assist-step-title">{title}</p>
        {children}
      </div>
    </li>
  );
}

const ADD = {
  claude: {label: 'Add to Claude', Mark: ClaudeMark},
  chatgpt: {label: 'Add to ChatGPT', Mark: ChatGptMark},
} as const;

/** "Add to Claude / ChatGPT": neither lets a site add a connector by itself, so the one click copies Morfa's address and opens the
 *  page where it is pasted. The assistant then shows Morfa under its own name and icon. */
function AddButton({kind, url}: {kind: 'claude' | 'chatgpt'; url: string}) {
  const [copied, setCopied] = useState(false);
  const {label, Mark} = ADD[kind];
  return (
    <div className="dz-assist-add">
      <a className={`dz-btn is-primary is-32 dz-assist-out is-${kind}`} href={ASSISTANT_SETTINGS[kind]} target="_blank" rel="noopener noreferrer"
        onClick={() => {
          void navigator.clipboard?.writeText(url).then(() => setCopied(true), () => undefined);
        }}>
        <Mark className="dz-assist-out-mark" />
        {label}
      </a>
      {copied && <span className="dz-assist-add-note" role="status">Address copied, paste it there</span>}
    </div>
  );
}

/** A value to paste elsewhere, with "Copy" that says it worked. */
function CopyField({value, mono = false}: {value: string; mono?: boolean}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className={`dz-assist-copy ${mono ? 'is-mono' : ''}`}>
      <code className="dz-assist-copy-value">{value}</code>
      <Button size={24} icon className={`dz-assist-copy-btn ${copied ? 'is-copied' : ''}`} onClick={copy} aria-label={copied ? 'Copied' : 'Copy'}>
        <span className="dz-assist-copy-icons" aria-hidden="true"><IconCopy /><IconCheck /></span>
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

const MARKS: Record<AssistantKind, (props: {className?: string}) => ReactNode> = {
  claude: ClaudeMark,
  chatgpt: ChatGptMark,
  other: ({className}) => <span className={`${className} is-letter`}>MCP</span>,
};

function Connected({connections, fresh, refresh}: {connections: readonly AssistantConnection[]; fresh: ReadonlySet<string>; refresh: () => Promise<unknown>}) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  if (!connections.length)
    return (
      <div className="dz-assist-connected is-empty">
        <span className="dz-assist-waiting" aria-hidden="true" />
        Waiting for a connection. As soon as you allow access, the assistant appears here.
      </div>
    );
  return (
    <section className="dz-assist-connected" aria-label="Connected assistants">
      <h3 className="dz-assist-connected-title">Connected</h3>
      <ul className="dz-assist-rows">
        {connections.map(connection => {
          const Mark = MARKS[assistantKind(connection)];
          return (
            <li key={connection.id} className={`dz-assist-row ${fresh.has(connection.id) ? 'is-fresh' : ''}`}>
              <span className="dz-assist-row-tile"><Mark className="dz-assist-row-mark" /></span>
              <span className="dz-assist-row-text">
                <span className="dz-assist-row-name">{connection.clientName}</span>
                <span className="dz-assist-row-line">{connectionLine(connection)}</span>
              </span>
              <Button size={24} busy={busy === connection.id} onClick={async () => {
                setBusy(connection.id);
                try {
                  await disconnectAssistant(connection.id);
                  await refresh();
                  toast(`${connection.clientName} disconnected`);
                } catch {
                  toast('Could not disconnect. Try again.', {kind: 'error'});
                } finally {
                  setBusy(null);
                }
              }}>Disconnect</Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
