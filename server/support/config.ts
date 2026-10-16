import {operatorsNamed} from '../admin/operators';

// Whether the support chat is on (`supportChat` in /api/config, the person's /api/support routes): by default whenever MORFA_OPERATORS
// names an operator to answer it, off with SUPPORT_CHAT=0. The console's side (/api/admin/support) stays open to operators either
// way, so conversations already written can still be read and answered after the chat is switched off.

export const supportChatEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  env.SUPPORT_CHAT !== '0' && operatorsNamed(env);
