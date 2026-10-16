import {useSyncExternalStore} from 'react';
import type {AppConfig} from './session';

// Whether the signed-in account is one of Morfa's operators: /api/config says `admin: true` only to them (server/admin,
// MORFA_OPERATORS). App sets it once it has read the config for the account; the file browser's account menu offers "Admin"
// while it holds. It only shows the way in: every /api/admin answer is the server's own check.

let operator = false;
const listeners = new Set<() => void>();

export const isOperatorConfig = (config: AppConfig) => config.admin === true;

export function setOperator(next: boolean) {
  if (next === operator) return;
  operator = next;
  listeners.forEach(listener => listener());
}

export const operatorNow = () => operator;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const useOperator = () => useSyncExternalStore(subscribe, operatorNow, () => false);
