import '../styles/save-guard.css';
import {useState} from 'react';
import {Button} from '../ui/Button';
import {IconDownload, IconWarning} from '../ui/icons';

// "Saving stopped": autosave met a change the server refuses and could not put it back (or it was refused
// again after that), so it stopped rather than retry in a loop or drop work silently. The banner stays over the
// canvas until the file is reloaded: first a copy of what is on screen (.rdesign), then "Reload file" opens
// the stored version and saving starts again. Editing stays possible; nothing more is saved until then.

export type SaveStoppedBannerProps = {
  /** What was refused (persistence: `SaveStopped.message`). */
  message: string;
  /** Downloads the open document as .rdesign. */
  onDownload: () => Promise<void>;
  /** Opens the stored version; unsaved changes are dropped. */
  onReload: () => Promise<void>;
};

export function SaveStoppedBanner({message, onDownload, onReload}: SaveStoppedBannerProps) {
  const [busy, setBusy] = useState<'download' | 'reload' | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const run = (kind: 'download' | 'reload', action: () => Promise<void>) => async () => {
    if (busy) return;
    setBusy(kind);
    try {
      await action();
      if (kind === 'download') setDownloaded(true);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="dz-save-stopped" role="alert" aria-labelledby="dz-save-stopped-title">
      <span className="dz-save-stopped-icon" aria-hidden="true"><IconWarning /></span>
      <div className="dz-save-stopped-body">
        <p id="dz-save-stopped-title" className="dz-save-stopped-title">Saving stopped</p>
        <p className="dz-save-stopped-text">
          {message} New changes are not being saved. Download a copy, then reload the file: unsaved changes will be lost.
        </p>
        <div className="dz-save-stopped-actions">
          <Button variant={downloaded ? 'secondary' : 'primary'} icon={<IconDownload />} busy={busy === 'download'} disabled={busy === 'reload'}
            onClick={run('download', onDownload)}>Download a copy</Button>
          <Button variant={downloaded ? 'primary' : 'secondary'} busy={busy === 'reload'} disabled={busy === 'download'}
            onClick={run('reload', onReload)}>Reload file</Button>
        </div>
      </div>
    </div>
  );
}
