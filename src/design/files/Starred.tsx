import {useState} from 'react';
import type {DesignFavourites} from '../../../shared/design/favourites';
import {FILES_DRAG_TYPE} from './drop';
import {IconFile, IconFolder} from '../ui/icons';
import {IconBoard} from './board-icon';
import {viewKey, type BrowserView} from './sidebar';

// "Favorites" in the sidebar, Figma's "Starred": the starred projects (they open in the browser) and files (they open in the
// editor), in the order they were starred. Nothing shows until something is starred, or while cards are dragged: then the section
// is a place to drop them, Figma's "Drag a file directly into the Starred section".

export function Starred({favourites, view, onView, onOpenFile, dragging = false, onDropFiles}: {
  favourites: DesignFavourites;
  view: BrowserView;
  onView: (view: BrowserView) => void;
  onOpenFile: (id: string) => void;
  /** Cards are being dragged from the browser (FileBrowser's drag): the section takes them. */
  dragging?: boolean;
  onDropFiles?: () => void;
}) {
  const [over, setOver] = useState(false);
  if (!favourites.files.length && !favourites.projects.length && !dragging) return null;
  const current = viewKey(view);
  return (
    <div className={`dz-files-place-group dz-files-starred ${dragging ? 'is-drop' : ''} ${over ? 'is-drop-target' : ''}`.replace(/\s+/g, ' ').trim()} role="group" aria-label="Favorites"
      onDragOver={event => {
        if (!dragging || !onDropFiles || !event.dataTransfer.types.includes(FILES_DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'link';
        setOver(true);
      }}
      onDragLeave={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={event => {
        setOver(false);
        if (!dragging || !onDropFiles || !event.dataTransfer.types.includes(FILES_DRAG_TYPE)) return;
        event.preventDefault();
        onDropFiles();
      }}>
      <div className="dz-files-place-title"><span className="dz-files-place-title-text">Favorites</span></div>
      {dragging && !favourites.files.length && !favourites.projects.length && <div className="dz-files-starred-hint">Drag here to add</div>}
      {favourites.projects.map(project => {
        const target: BrowserView = {kind: 'team', teamId: project.teamId, projectId: project.id};
        const active = viewKey(target) === current;
        return (
          <button key={'p' + project.id} type="button" className={`dz-files-place ${active ? 'is-active' : ''}`.trim()} aria-current={active ? 'page' : undefined}
            onClick={() => onView(target)}>
            <IconFolder /><span className="dz-files-place-label">{project.name}</span>
          </button>
        );
      })}
      {favourites.files.map(file => (
        <button key={'f' + file.id} type="button" className="dz-files-place" onClick={() => onOpenFile(file.id)}>
          {file.kind === 'board' ? <IconBoard /> : <IconFile />}<span className="dz-files-place-label">{file.name}</span>
        </button>
      ))}
    </div>
  );
}
