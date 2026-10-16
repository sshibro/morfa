export type FigmaErrorKind = 'rate' | 'token' | 'scope' | 'access' | 'missing' | 'network' | 'server' | 'bad';
export type FigmaRateType = 'low' | 'high';

/** What went wrong with a Figma call, as the client read it from the answer. */
export type FigmaErrorFacts = {
  kind: FigmaErrorKind;
  status?: number;
  // Seconds, from Retry-After.
  retryAfter?: number;
  rateType?: FigmaRateType;
  upgradeLink?: string;
  // The answer was over MAX_FIGMA_RESPONSE_BYTES.
  tooLarge?: boolean;
};

/** One sentence for the screen; `more` is a line for the fold under it. */
export type FigmaErrorCopy = {message: string; more?: string};

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const MESSAGES: Record<Exclude<FigmaErrorKind, 'rate' | 'bad'>, string> = {
  token: 'The Figma token is invalid or has expired. Connect Figma again.',
  scope: 'The token has no permission to read files. Create a new token with "File content — Read only" access.',
  access: 'No access to the file. Open it in Figma with the same account or ask for access.',
  missing: 'File not found. Check the link.',
  network: 'Could not reach Figma. If Figma only opens for you through a VPN, turn it on and try again.',
  server: 'Figma did not respond. Try again in a minute.',
};
const RATE = 'Figma has temporarily limited requests for your account.';
const LOW_TIER = 'View and Collab seats get only a few requests per month. Import all the frames you need in one go.';
const TOO_LARGE = 'The design is too large to import in one go. Choose fewer frames.';
const BAD = 'Figma did not accept the request. Check the link and try again.';

/** A wait in seconds as the owner reads it: "2 min", "3 hours", "2 days", always rounded up. */
export function waitText(seconds: number): string {
  const wait = Math.max(0, seconds);
  if (wait < HOUR) return `${Math.max(1, Math.ceil(wait / MINUTE))} min`;
  if (wait < DAY) {
    const hours = Math.ceil(wait / HOUR);
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  const days = Math.ceil(wait / DAY);
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

/** The words for a failed Figma call. */
export function figmaErrorCopy(facts: FigmaErrorFacts): FigmaErrorCopy {
  if (facts.kind === 'rate') {
    const when = facts.retryAfter === undefined ? 'Try again later.' : `Try again in ${waitText(facts.retryAfter)}.`;
    return facts.rateType === 'low' ? {message: `${RATE} ${when}`, more: LOW_TIER} : {message: `${RATE} ${when}`};
  }
  if (facts.kind === 'bad') return {message: facts.tooLarge ? TOO_LARGE : BAD};
  return {message: MESSAGES[facts.kind]};
}
