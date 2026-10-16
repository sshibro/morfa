import {useState} from 'react';
import {Button} from '../ui/Button';
import {Dialog} from '../ui/Dialog';
import {IconImport} from '../ui/icons';

/** "Delete permanently": the only irreversible action in the browser asks first. */
export function EraseDialog({name, onClose, onConfirm}: {name: string; onClose: () => void; onConfirm: () => Promise<void>}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title="Delete permanently?" onClose={onClose} width={380} footer={
      <>
        <Button size={32} onClick={onClose}>Cancel</Button>
        <Button size={32} variant="danger" busy={busy} data-autofocus onClick={async () => {
          setBusy(true);
          try {
            await onConfirm();
          } finally {
            setBusy(false);
          }
        }}>Delete</Button>
      </>
    }>
      <p>The file "{name}" and its version history will be deleted. This cannot be undone.</p>
    </Dialog>
  );
}

/** "Delete permanently" for several files of the trash at once. */
export function EraseManyDialog({count, onClose, onConfirm}: {count: number; onClose: () => void; onConfirm: () => Promise<void>}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title="Delete permanently?" onClose={onClose} width={380} footer={
      <>
        <Button size={32} onClick={onClose}>Cancel</Button>
        <Button size={32} variant="danger" busy={busy} data-autofocus onClick={async () => {
          setBusy(true);
          try {
            await onConfirm();
          } finally {
            setBusy(false);
          }
        }}>Delete</Button>
      </>
    }>
      <p>The selected files ({count}) and their version history will be deleted. This cannot be undone.</p>
    </Dialog>
  );
}

/** "Import from Figma" before the importer module is wired: says so instead of pretending. */
export function FigmaImportUnavailable({onClose}: {onClose: () => void}) {
  return (
    <Dialog title="Import from Figma" onClose={onClose} width={400} footer={<Button size={32} variant="primary" onClick={onClose}>Got it</Button>}>
      <div className="dz-notice">
        <span className="dz-notice-icon" aria-hidden="true"><IconImport /></span>
        <div>
          <p>Importing Figma files is being prepared and will appear here in an upcoming update.</p>
          <p>For now you can open an .rdesign file saved from Design.</p>
        </div>
      </div>
    </Dialog>
  );
}
