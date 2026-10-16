import {memo, useCallback, useContext, useSyncExternalStore} from 'react';
import {memoryDetails, memoryLabel} from '../memory-budget';
import {memoryWatchOf, subscribeMemoryWatches} from '../memory-watch';
import {EditorServicesContext} from '../services';
import {useTooltip} from '../../ui/Tooltip';
import {useDesignStore} from '../../engine/useDesignStore';
import type {DesignStore} from '../../engine/store';

// "File memory: 38%" under the file name (big files, docs/decisions/big-files.md §5): a bar of the tab's budget, yellow from
// 60 %, red from 75 %, with what is counted in its tooltip. Nothing for a whole document (the switch off).

export const MemoryIndicator = memo(function MemoryIndicator() {
  const services = useContext(EditorServicesContext);
  return services ? <Indicator store={services.store} /> : null;
});

function Indicator({store}: {store: DesignStore}) {
  const watch = useSyncExternalStore(subscribeMemoryWatches, () => memoryWatchOf(store));
  const estimate = useSyncExternalStore(useCallback((notify: () => void) => watch.subscribe(notify), [watch]), () => watch.estimate());
  const pages = useDesignStore(state => (state.pages ? {loaded: state.pages.loaded.size, total: state.doc.pages.length} : null), (a, b) => a?.loaded === b?.loaded && a?.total === b?.total, {store, slice: ['pages', 'doc']});
  const tip = useTooltip(estimate ? {label: memoryDetails(estimate, pages), placement: 'bottom-start'} : null);
  if (!estimate) return null;
  const percent = Math.min(100, Math.round(estimate.ratio * 100));
  return (
    <span className={`dz-memory is-${estimate.level}`} role="meter" aria-label={memoryLabel(estimate)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} tabIndex={0} {...tip}>
      <span className="dz-memory-bar" aria-hidden="true"><span className="dz-memory-fill" style={{width: percent + '%'}} /></span>
      <span className="dz-memory-text">{percent} %</span>
    </span>
  );
}
