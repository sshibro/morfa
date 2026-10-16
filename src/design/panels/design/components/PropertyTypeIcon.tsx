import type {ComponentPropertyType} from '../../../../../shared/design/types';
import {IconInstance, IconText, IconToggle, IconVariant} from '../../../ui/icons';

/** The icon of a component property's type, as the properties list shows it. */
export function PropertyTypeIcon({type, size = 16}: {type: ComponentPropertyType; size?: number}) {
  if (type === 'VARIANT') return <IconVariant size={size} />;
  if (type === 'BOOLEAN') return <IconToggle size={size} />;
  if (type === 'TEXT') return <IconText size={size} />;
  return <IconInstance size={size} />;
}
