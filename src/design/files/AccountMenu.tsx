import {useCallback, useEffect, useState} from 'react';
import {useOperator} from '../../auth/operator';
import {readSession, type Account} from '../../auth/session';
import {requestNavigation} from '../../navigation';
import {accountInitial, accountLabel} from './account';
import {IconChevronDown, IconLeave, IconMonitor, IconMoon, IconSliders, IconSun} from '../ui/icons';
import {useMenuTrigger} from '../ui/Menu';
import type {MenuItem} from '../ui/menu-model';
import {THEME_LABELS, setThemePreference, useThemePreference, type ThemePreference} from '../ui/theme';

// The account at the top of the file browser's sidebar, as Figma's: who is signed in, and a menu with the theme and "Sign out"
// (docs/figma-parity-shell.md, "Account"). The account is read from the session the shell already holds. An operator
// (src/auth/operator.ts) also gets "Admin console", the console at #admin (src/admin).

const THEME_ICON = {light: IconSun, dark: IconMoon, system: IconMonitor} as const;

function useAccount() {
  const [account, setAccount] = useState<Account | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    readSession(controller.signal).then(setAccount, () => undefined);
    return () => controller.abort();
  }, []);
  return account;
}

export function AccountMenu({onSignOut}: {onSignOut: () => void}) {
  const account = useAccount();
  const preference = useThemePreference();
  const operator = useOperator();
  const items = useCallback((): MenuItem[] => [
    ...(operator ? [{id: 'admin', label: 'Admin console', icon: <IconSliders />, onSelect: () => requestNavigation({kind: 'admin'})} as MenuItem] : []),
    ...(operator ? [{type: 'separator'} as MenuItem] : []),
    {type: 'submenu', id: 'theme', label: 'Theme', icon: <IconSun />, items: (['system', 'light', 'dark'] as ThemePreference[]).map(option => {
      const Icon = THEME_ICON[option];
      return {id: 'theme-' + option, label: THEME_LABELS[option], icon: <Icon />, checked: preference === option, radio: true, onSelect: () => setThemePreference(option)};
    })},
    {type: 'separator'},
    {id: 'sign-out', label: 'Sign out', icon: <IconLeave />, onSelect: onSignOut},
  ], [operator, preference, onSignOut]);
  const menu = useMenuTrigger({items, label: 'Account', placement: 'bottom-start', minWidth: 220});
  return (
    <>
      <button type="button" className="dz-account" aria-label="Account" {...menu.triggerProps}>
        <span className="dz-account-avatar" aria-hidden="true">{accountInitial(account)}</span>
        <span className="dz-account-name">{accountLabel(account)}</span>
        <IconChevronDown size={12} className="dz-account-chevron" />
      </button>
      {menu.element}
    </>
  );
}
