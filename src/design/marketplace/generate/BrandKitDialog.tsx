// "Brand kit" (docs/marketplaces.md §Brand kit): one of the account's brand kits edited in a dialog — its name, five colours, the fonts of
// headings and texts from the editor's font list, the brand's and the store's logos, icons. A
// picture is uploaded into the open file as a design picture (not placed in the document) and kept in the kit by its address, so the
// kit shows it in every file of the account; applying the kit copies it into a file of another place (pictures.ts on the server). A
// picture whose file was erased can no longer be read: the dialog marks it and asks for it again.

import {useMemo, useRef, useState, type ReactNode} from 'react';
import {uploadDesignImage} from '../../api';
import {
  BRAND_KIT_ICONS,
  BRAND_KIT_NAME_CHARS,
  newBrandKit,
  type BrandColors,
  type BrandKit,
  type BrandKitRecord,
} from '../../../../shared/design/marketplace/brand-kit';
import type {ImageAsset, SolidPaint} from '../../../../shared/design/types';
import {hexToRgb} from '../../../../shared/design/board/palette';
import {useEditorServices} from '../../editor/services';
import {Button} from '../../ui/Button';
import {besidePanel, ColorPicker} from '../../ui/ColorPicker';
import {ColorSwatch} from '../../ui/ColorSwatch';
import {Dialog} from '../../ui/Dialog';
import {FontPicker} from '../../ui/FontPicker';
import {IconChevronDown, IconClose, IconPlus} from '../../ui/icons';
import {TextInput} from '../../ui/TextInput';
import {deleteBrandKit, storeBrandKit} from './brand-kits-client';

const COLOR_LABELS: readonly {key: keyof BrandColors; label: string}[] = [
  {key: 'primary', label: 'Primary'},
  {key: 'secondary', label: 'Secondary'},
  {key: 'accent', label: 'Accent'},
  {key: 'background', label: 'Background'},
  {key: 'text', label: 'Text'},
];

const HEX = /^#?([0-9a-f]{6})$/i;
const toHex = ({r, g, b}: {r: number; g: number; b: number}) => '#' + [r, g, b].map(value => Math.round(value * 255).toString(16).padStart(2, '0')).join('');
const errorText = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

export type BrandKitDialogProps = {
  /** The kit to edit; null makes a new one. */
  record: BrandKitRecord | null;
  onClose: () => void;
  /** The kit as the server stored it. */
  onSaved?: (record: BrandKitRecord) => void;
  /** "Apply to card" after saving (shown when a card is selected). */
  onApply?: (record: BrandKitRecord) => void;
};

export function BrandKitDialog({record, onClose, onSaved, onApply}: BrandKitDialogProps) {
  const {fileId, fonts, readOnly} = useEditorServices();
  const [kit, setKit] = useState<BrandKit>(() => record?.kit ?? newBrandKit(''));
  const [busy, setBusy] = useState<'save' | 'apply' | 'delete' | 'upload' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [fontPicker, setFontPicker] = useState<{which: 'heading' | 'body'; anchor: Element} | null>(null);
  const change = (patch: Partial<BrandKit>) => setKit(current => ({...current, ...patch}));

  const save = async (then?: 'apply') => {
    if (busy) return;
    setBusy(then ?? 'save');
    setError(null);
    try {
      const saved = await storeBrandKit(record?.id ?? null, {...kit, name: kit.name.trim() || 'Brand kit'});
      onSaved?.(saved);
      if (then === 'apply') onApply?.(saved);
      onClose();
    } catch (failure) {
      setError(errorText(failure, 'Could not save the brand kit. Try again.'));
      setBusy(null);
    }
  };
  const remove = async () => {
    if (!record || busy) return;
    setBusy('delete');
    try {
      await deleteBrandKit(record.id);
      onClose();
    } catch (failure) {
      setError(errorText(failure, 'Could not delete the brand kit.'));
      setBusy(null);
    }
  };
  /** Uploads pictures into the open file (not into its document) and returns them as the kit keeps them. */
  const upload = async (files: readonly File[]): Promise<ImageAsset[]> => {
    setBusy('upload');
    setError(null);
    const out: ImageAsset[] = [];
    try {
      for (const file of files) {
        const {asset} = await uploadDesignImage(fileId, file, file.name);
        out.push({url: asset.url, width: asset.width, height: asset.height, ...(file.name ? {name: file.name.slice(0, 200)} : {})});
      }
    } catch (failure) {
      setError(errorText(failure, 'Could not upload the picture.'));
    } finally {
      setBusy(null);
    }
    return out;
  };

  const footer = (
    <>
      {record && !readOnly && (
        confirmDelete
          ? <Button variant="danger" busy={busy === 'delete'} disabled={!!busy && busy !== 'delete'} onClick={() => void remove()}>Delete brand kit</Button>
          : <Button variant="ghost" disabled={!!busy} onClick={() => setConfirmDelete(true)}>Delete</Button>
      )}
      <span className="dz-mp-gen-kit-spacer" />
      <Button onClick={onClose} disabled={busy === 'save' || busy === 'apply'}>Cancel</Button>
      {onApply && <Button busy={busy === 'apply'} disabled={!!busy || readOnly} onClick={() => void save('apply')}>Save and apply</Button>}
      <Button variant="primary" busy={busy === 'save'} disabled={!!busy} onClick={() => void save()}>Save</Button>
    </>
  );
  return (
    <Dialog title={record ? 'Brand kit' : 'New brand kit'} onClose={onClose} width={440} footer={footer} dismissible={!busy} className="dz-mp-gen-kit-dialog">
      <div className="dz-mp-gen-kit">
        <div className="dz-mp-gen-kit-field">
          <span className="dz-mp-gen-kit-label">Name</span>
          <TextInput value={kit.name} onChange={name => change({name: name.slice(0, BRAND_KIT_NAME_CHARS)})} placeholder="For example, Primary" maxLength={BRAND_KIT_NAME_CHARS} data-autofocus aria-label="Brand kit name" />
        </div>

        <fieldset className="dz-mp-gen-kit-set">
          <legend className="dz-mp-gen-kit-label">Colours</legend>
          <div className="dz-mp-gen-kit-colors">
            {COLOR_LABELS.map(({key, label}) => (
              <KitColor key={key} label={label} value={kit.colors[key]} onChange={hex => change({colors: {...kit.colors, [key]: hex}})} />
            ))}
          </div>
        </fieldset>

        <fieldset className="dz-mp-gen-kit-set">
          <legend className="dz-mp-gen-kit-label">Fonts</legend>
          {(['heading', 'body'] as const).map(which => (
            <div key={which} className="dz-mp-gen-kit-row">
              <span className="dz-mp-gen-kit-sub">{which === 'heading' ? 'Headings' : 'Text'}</span>
              <button type="button" className="dz-select is-24 is-field dz-mp-gen-kit-font" aria-label={which === 'heading' ? 'Heading font' : 'Text font'} aria-haspopup="dialog"
                aria-expanded={fontPicker?.which === which} onClick={event => setFontPicker(fontPicker?.which === which ? null : {which, anchor: event.currentTarget})}>
                <span className="dz-select-value" style={{fontFamily: `"${kit.fonts[which]}", var(--dz-font)`}}>{kit.fonts[which]}</span>
                <span className="dz-select-chevron"><IconChevronDown size={12} /></span>
              </button>
            </div>
          ))}
          {fontPicker && (
            <FontPicker anchor={fontPicker.anchor} value={kit.fonts[fontPicker.which]} fonts={fonts} placement="bottom-start" aria-label="Brand kit font"
              onPick={family => {
                change({fonts: {...kit.fonts, [fontPicker.which]: family}});
                setFontPicker(null);
              }}
              onClose={() => setFontPicker(null)} />
          )}
        </fieldset>

        <fieldset className="dz-mp-gen-kit-set">
          <legend className="dz-mp-gen-kit-label">Logos</legend>
          <KitPicture label="Brand" value={kit.logo} busy={busy === 'upload'} onUpload={files => void upload(files.slice(0, 1)).then(([asset]) => asset && change({logo: asset}))} onRemove={() => change({logo: null})} />
          <KitPicture label="Store" value={kit.storeLogo} busy={busy === 'upload'} onUpload={files => void upload(files.slice(0, 1)).then(([asset]) => asset && change({storeLogo: asset}))} onRemove={() => change({storeLogo: null})} />
          <p className="dz-mp-gen-note">WB does not accept logos on the cover, Ozon only as a watermark, Yandex Market only the brand logo.</p>
        </fieldset>

        <fieldset className="dz-mp-gen-kit-set">
          <legend className="dz-mp-gen-kit-label">Icons · {kit.icons.length} of {BRAND_KIT_ICONS}</legend>
          <KitIcons icons={kit.icons} busy={busy === 'upload'}
            onAdd={files => void upload(files.slice(0, BRAND_KIT_ICONS - kit.icons.length)).then(added => added.length && setKit(current => ({...current, icons: [...current.icons, ...added].slice(0, BRAND_KIT_ICONS)})))}
            onRemove={index => change({icons: kit.icons.filter((_, i) => i !== index)})} />
        </fieldset>

        {error && <p className="dz-mp-gen-note is-error" role="alert">{error}</p>}
      </div>
    </Dialog>
  );
}

/** One kit colour: a swatch that opens the editor's colour picker and the hex typed in. */
function KitColor({label, value, onChange}: {label: string; value: string; onChange: (hex: string) => void}) {
  const swatch = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value.slice(1));
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setText(value.slice(1));
  }
  const paint = useMemo<SolidPaint>(() => ({type: 'SOLID', color: hexToRgb(value), opacity: 1, visible: true, blendMode: 'NORMAL'}), [value]);
  const anchor = useMemo(() => (open && swatch.current ? besidePanel(swatch.current) : null), [open]);
  return (
    <div className="dz-mp-gen-kit-color">
      <ColorSwatch ref={swatch} interactive color={value} size={16} aria-label={`${label}: ${value}`} aria-expanded={open} onClick={() => setOpen(!open)} />
      <span className="dz-mp-gen-kit-sub">{label}</span>
      <TextInput aria-label={`${label}, HEX`} value={text} onChange={setText} selectOnFocus className="dz-mp-gen-kit-hex"
        onCommit={typed => {
          const match = HEX.exec(typed.trim());
          if (match) onChange('#' + match[1].toLowerCase());
          else setText(value.slice(1));
        }} />
      {open && anchor && (
        <ColorPicker anchor={anchor} trigger={swatch.current} onClose={() => setOpen(false)} aria-label={label} kinds="solid" alpha={false} paint={paint}
          onChange={next => next.type === 'SOLID' && onChange(toHex(next.color))} />
      )}
    </div>
  );
}

/** A picture's preview that says so when its file is gone. */
function Thumb({asset, className}: {asset: ImageAsset; className: string}) {
  const [broken, setBroken] = useState(false);
  return (
    <span className={`${className} ${broken ? 'is-missing' : ''}`.trim()} title={broken ? 'The picture is unavailable: upload it again' : asset.name}>
      {broken ? <span className="dz-mp-gen-kit-missing">No file</span> : <img src={asset.url} alt="" draggable={false} onError={() => setBroken(true)} />}
    </span>
  );
}

function PickFiles({label, multiple, busy, onFiles, variant = 'secondary', icon}: {label: string; multiple?: boolean; busy: boolean; onFiles: (files: File[]) => void; variant?: 'secondary' | 'ghost'; icon?: ReactNode}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button variant={variant} icon={icon} busy={busy} disabled={busy} onClick={() => input.current?.click()}>{label}</Button>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" multiple={multiple} hidden aria-label={label}
        onChange={event => {
          const files = [...(event.currentTarget.files ?? [])];
          event.currentTarget.value = '';
          if (files.length) onFiles(files);
        }} />
    </>
  );
}

function KitPicture({label, value, busy, onUpload, onRemove}: {label: string; value: ImageAsset | null; busy: boolean; onUpload: (files: File[]) => void; onRemove: () => void}) {
  return (
    <div className="dz-mp-gen-kit-row">
      <span className="dz-mp-gen-kit-sub">{label}</span>
      {value ? <Thumb asset={value} className="dz-mp-gen-kit-thumb" /> : <span className="dz-mp-gen-kit-thumb is-empty" aria-hidden="true" />}
      <PickFiles label={value ? 'Replace' : 'Upload'} busy={busy} onFiles={onUpload} />
      {value && <Button variant="ghost" onClick={onRemove} aria-label={`Remove: ${label}`}>Remove</Button>}
    </div>
  );
}

function KitIcons({icons, busy, onAdd, onRemove}: {icons: readonly ImageAsset[]; busy: boolean; onAdd: (files: File[]) => void; onRemove: (index: number) => void}) {
  return (
    <div className="dz-mp-gen-kit-icons">
      {icons.map((icon, index) => (
        <span key={icon.url + index} className="dz-mp-gen-kit-icon">
          <Thumb asset={icon} className="dz-mp-gen-kit-thumb" />
          <button type="button" className="dz-mp-gen-kit-drop" aria-label={`Remove icon ${icon.name ?? index + 1}`} onClick={() => onRemove(index)}><IconClose size={12} /></button>
        </span>
      ))}
      {icons.length < BRAND_KIT_ICONS && <PickFiles label="Add" multiple busy={busy} onFiles={onAdd} variant="ghost" icon={<IconPlus />} />}
    </div>
  );
}
