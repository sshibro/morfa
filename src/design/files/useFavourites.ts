import {useCallback, useState} from 'react';
import type {DesignFavourites} from '../../../shared/design/favourites';
import {listDesignFavourites, starDesign, unstarDesign} from './favourites-api';

// The caller's "Favorites" (favourites-api.ts): read with every file list (FileBrowser calls `refresh`), changed in place by a star
// and read again after it, so the sidebar follows at once. A failed star puts the list back and says why (`onError`).

const EMPTY: DesignFavourites = {files: [], projects: []};

export function useFavourites(onError: (error: unknown) => void) {
  const [favourites, setFavourites] = useState<DesignFavourites>(EMPTY);
  const refresh = useCallback(() => {
    listDesignFavourites().then(setFavourites, () => undefined);
  }, []);

  const isStarred = useCallback((kind: 'files' | 'projects', id: string) => favourites[kind].some(entry => entry.id === id), [favourites]);

  const setStar = useCallback(async (kind: 'files' | 'projects', entry: DesignFavourites['files'][number] | DesignFavourites['projects'][number], on: boolean) => {
    setFavourites(current => ({
      ...current,
      [kind]: on ? [...current[kind].filter(item => item.id !== entry.id), entry] : current[kind].filter(item => item.id !== entry.id),
    }));
    try {
      await (on ? starDesign(kind, entry.id) : unstarDesign(kind, entry.id));
    } catch (error) {
      onError(error);
    }
    refresh();
  }, [onError, refresh]);

  return {favourites, isStarred, setStar, refresh};
}
