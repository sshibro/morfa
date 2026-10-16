import {memo, useCallback} from 'react';
import {BrandSymbol} from '../../../brand/marks';
import {SUPPORT_ANCHOR, SupportDot, supportUnreadNote, withSupportNote} from '../../../support/badges';
import {useSupportState} from '../../../support/state';
import {IconChevronDown, IconMore} from '../../ui/icons';
import {useMenuTrigger} from '../../ui/Menu';
import type {MenuItem} from '../../ui/menu-model';
import {THEME_LABELS, setThemePreference, useThemePreference, type ThemePreference} from '../../ui/theme';
import {useTooltip} from '../../ui/Tooltip';
import {MAIN_MENU, buildMainMenu, type CommandLookup, type MainMenuSection} from './commands';

export type MainMenuProps = {
  commands: CommandLookup;
  menu?: readonly MainMenuSection[];
  onBackToFiles: () => void;
  /** The button's face: the product's symbol (the panel) or "⋯" (the phone's top bar, src/design/editor/phone). */
  face?: 'mark' | 'more';
};

const THEMES: ThemePreference[] = ['system', 'light', 'dark'];

/** The button at the top of the left panel, under the product's symbol: "Back to files", File ▸ … Help ▸, Theme ▸. */
export const MainMenu = memo(function MainMenu({commands, menu = MAIN_MENU, onBackToFiles, face = 'mark'}: MainMenuProps) {
  const theme = useThemePreference();
  // The support chat's unread answers: a dot on the button, a line under "Help ▸ Contact support" (src/support/badges.tsx).
  const {unread} = useSupportState();
  const items = useCallback((): MenuItem[] => withSupportNote(buildMainMenu(menu, commands, {
    onBackToFiles,
    extra: [{type: 'submenu', id: 'menu:theme', label: 'Theme', items: THEMES.map(preference => ({
      id: 'theme.' + preference, label: THEME_LABELS[preference], checked: theme === preference, radio: true, onSelect: () => setThemePreference(preference),
    }))}],
  }), unread), [menu, commands, onBackToFiles, theme, unread]);
  const trigger = useMenuTrigger({items, label: 'Main menu', minWidth: 220});
  const tip = useTooltip(trigger.open ? null : {label: 'Main menu'});
  return (
    <>
      <button type="button" className={`dz-app-menu is-${face} ${SUPPORT_ANCHOR}`} aria-label={unread ? `Main menu. ${supportUnreadNote(unread)}` : 'Main menu'} {...tip} {...trigger.triggerProps}>
        {face === 'more' ? <IconMore /> : <><BrandSymbol className="dz-app-menu-mark" /><IconChevronDown size={12} /></>}
        <SupportDot />
      </button>
      {trigger.element}
    </>
  );
});
