import {useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import type {NodeId, Paint, RGB} from '../../../../../shared/design/types';
import {EditorServicesContext} from '../../../editor/services';
import {cancelPick, isPickingColor, pickColor, setColorReceiver} from '../../../engine/eyedropper';
import {paintEditSession} from '../../../engine/tools/gradient-edit';
import {cropTransformFor} from '../../../engine/tools/image-crop';
import {useStoreApi} from '../../../engine/useDesignStore';
import {ColorPicker, paintWithColor, paintColor, type ImageServices} from '../../../ui/ColorPicker';
import type {Placement, Rect} from '../../../ui/position';
import type {Change, Committer} from './editing';
import {isGradient, type PaintField} from './paints';
import {collectDocumentColors} from './selection-colors';
import {colorBehind, contrastCategory} from './contrast';
import {useResolvedTheme} from '../../../ui/theme';

// The colour picker wired to the document: edits go through the owner's committer (one step per
// change, one gesture per drag), a gradient of a single layer gets its handles on the canvas, "Crop"
// crops on the canvas, the pipette and the file's colours work, and pictures upload into the file.

export type CanvasTarget = {nodeId: NodeId; field: PaintField; index: number};

export type PaintPickerProps = {
  anchor: Element | Rect;
  onClose: () => void;
  paint: Paint;
  /** The change that writes `paint` where this picker edits (absolute: gestures re-run it). */
  write: (paint: Paint) => Change;
  label: string;
  committer: Committer;
  /** One layer's paint: gradients and crops are edited on the canvas too. */
  canvasTarget?: CanvasTarget | null;
  box?: {width: number; height: number};
  libraries?: ReactNode;
  initialTab?: 'custom' | 'libraries';
  /** "+" in the picker's header: saves this paint as a colour style (PaintSection). */
  onCreateStyle?: () => void;
  kinds?: 'all' | 'solid';
  alpha?: boolean;
  boundVariable?: {name: string; onDetach: () => void} | null;
  title?: string;
  placement?: Placement;
  /** The row that opened the picker (a press on it toggles, it is not "outside"). */
  trigger?: Element | null;
};

/** Pictures through the editor's services; null in a page without them (uploads then stay off). */
export function useImageServices(): ImageServices | undefined {
  const services = useContext(EditorServicesContext);
  return useMemo(() => {
    if (!services) return undefined;
    return {
      url: ref => services.store.getState().doc.images[ref]?.url ?? null,
      async upload(file) {
        try {
          return (await services.uploadImage(file, file.name)).ref;
        } catch (error) {
          services.toast(error instanceof Error && error.message ? error.message : 'Could not upload the image.', 'error');
          return null;
        }
      },
    };
  }, [services]);
}

export function PaintPicker(props: PaintPickerProps) {
  const {paint, committer, canvasTarget, label} = props;
  const store = useStoreApi();
  const services = useContext(EditorServicesContext);
  const images = useImageServices();
  const [stop, setStop] = useState(0);
  const stopRef = useRef(stop);
  stopRef.current = stop;
  const writeRef = useRef(props.write);
  writeRef.current = props.write;
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  const latestPaint = useRef(paint);
  latestPaint.current = paint;

  const onChange = useCallback((next: Paint) => {
    const previous = latestPaint.current;
    // Choosing "Crop" fixes the picture where it shows now, so nothing jumps.
    if (next.type === 'IMAGE' && next.scaleMode === 'CROP' && !next.imageTransform && previous.type === 'IMAGE' && props.box) {
      const asset = store.getState().doc.images[next.imageRef];
      next = {...next, imageTransform: cropTransformFor(previous, props.box.width, props.box.height, asset?.width ?? props.box.width, asset?.height ?? props.box.height)};
    }
    committer.set(label, writeRef.current(next));
  }, [committer, label, store, props.box]);

  // ── The canvas session (gradient handles, crop) ───────────────────────────────────────────────
  const mine = useRef(false);
  const ending = useRef(false);
  const [cropping, setCropping] = useState(false);
  const gradient = isGradient(paint);
  const crop = cropping && paint.type === 'IMAGE' && paint.scaleMode === 'CROP';
  const endSession = () => {
    if (!mine.current) return;
    ending.current = true;
    mine.current = false;
    paintEditSession.end();
    ending.current = false;
  };
  useEffect(() => {
    if (!canvasTarget) return;
    if (gradient) {
      mine.current = true;
      paintEditSession.start(store, {...canvasTarget, kind: 'gradient', stop: stopRef.current});
    } else if (crop) {
      mine.current = true;
      paintEditSession.start(store, {...canvasTarget, kind: 'crop', stop: 0, image: ref => services?.images.get(ref, store.getState().doc) ?? null});
    } else {
      endSession();
    }
  }, [canvasTarget?.nodeId, canvasTarget?.field, canvasTarget?.index, gradient, crop]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => endSession(), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => paintEditSession.subscribe(() => {
    const target = paintEditSession.get();
    if (!target) {
      // Ended on the canvas (a press elsewhere, Escape, another tool): the picker goes with it.
      if (mine.current && !ending.current) {
        mine.current = false;
        onCloseRef.current();
      }
      return;
    }
    if (target.kind === 'gradient' && target.stop !== stopRef.current) setStop(target.stop);
  }), []);
  const selectStop = useCallback((index: number) => {
    setStop(index);
    if (mine.current) paintEditSession.update({stop: index});
  }, []);

  // ── Pipette: the button, and "I" while the picker is open ─────────────────────────────────────
  const applyPicked = useCallback((color: RGB) => {
    const current = latestPaint.current;
    const edited = paintColor(current, stopRef.current);
    if (!edited) return;
    committer.set('Eyedropper', writeRef.current(paintWithColor(current, stopRef.current, color, edited.alpha)));
  }, [committer]);
  useEffect(() => setColorReceiver(applyPicked), [applyPicked]);
  // A pick still running when the picker closes is cancelled with it.
  useEffect(() => () => {
    if (isPickingColor()) cancelPick();
  }, []);
  const eyedropper = useCallback(() => pickColor(store), [store]);

  const documentColors = useCallback(() => collectDocumentColors(store.getState().doc), [store]);
  // The contrast check judges one layer's fill or stroke against what is behind it (read when the picker opens).
  const theme = useResolvedTheme();
  const contrast = useMemo(() => {
    if (!canvasTarget) return null;
    const doc = store.getState().doc;
    return {behind: colorBehind(doc, canvasTarget.nodeId, theme), category: contrastCategory(doc.nodes[canvasTarget.nodeId])};
  }, [store, canvasTarget?.nodeId, theme]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <ColorPicker anchor={props.anchor} onClose={props.onClose} aria-label={label} paint={paint} onChange={onChange}
      onGestureStart={() => committer.begin(label)} onGestureEnd={() => committer.end()}
      kinds={props.kinds} alpha={props.alpha} stop={stop} onStopChange={selectStop} images={images}
      documentColors={documentColors} libraries={props.libraries} initialTab={props.initialTab} boundVariable={props.boundVariable}
      onEyedropper={eyedropper} contrast={contrast} onCreateStyle={props.onCreateStyle} onCrop={canvasTarget ? () => setCropping(true) : undefined} title={props.title} box={props.box}
      placement={props.placement} trigger={props.trigger}
      // Presses on the canvas belong to the handles of a gradient or crop being edited, and to the pipette.
      ignoreOutside={target => (mine.current || isPickingColor()) && !!target.closest('.dz-canvas')} />
  );
}
