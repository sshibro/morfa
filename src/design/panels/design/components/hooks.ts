import {useEffect} from 'react';
import type {DesignDocument} from '../../../../../shared/design/types';
import {useEditorServices, type EditorServices} from '../../../editor/services';
import {connectComponentCommands, isComponentHostConnected} from '../../../engine/commands/components';
import {useDesignStore} from '../../../engine/useDesignStore';
import {sameModel} from './model';

/** A value computed from the document, re-rendering only when it changes structurally (a drag of
 *  other layers recomputes it but renders nothing). Never reads the viewport. */
export function useDocValue<T>(services: EditorServices, compute: (doc: DesignDocument) => T): T {
  return useDesignStore(state => compute(state.doc), sameModel, {slice: 'doc', store: services.store});
}

/** Lets the component commands toast and reveal through this editor's services when DesignEditor did
 *  not connect them itself (the first section that mounts does; it stays connected for the store). */
export function useComponentHost(): EditorServices {
  const services = useEditorServices();
  useEffect(() => {
    if (isComponentHostConnected(services.store)) return;
    connectComponentCommands(services.store, {toast: (message, kind) => services.toast(message, kind === 'info' ? undefined : kind), revealNodes: ids => services.revealNodes(ids)});
  }, [services]);
  return services;
}
