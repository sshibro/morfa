import type {Request, Response} from 'express';
import {rateLimit, type Options} from 'express-rate-limit';
import {RATE_LIMITED_MESSAGE} from '../shared/rate-limit';

/** What a limiter says, in the API's error shape; a limiter may have its own words or code. */
type LimitAnswer = {error: string; code?: string; retryable?: boolean};
export type LimitOptions = Partial<Omit<Options, 'message' | 'handler' | 'standardHeaders' | 'legacyHeaders'>> & {
  message?: LimitAnswer;
  /** For the few routes that are not the API: a sign-in page, or an OAuth endpoint whose errors have their own shape. It
   *  writes the whole 429 itself; the RateLimit headers are already set. */
  answer?: (req: Request, res: Response) => void;
};

/** Every API limiter: the RateLimit headers and a 429 in the API's JSON error shape. The
 * package's own answer is plain text, which api() cannot read and reported as a lost connection. */
export function limitRequests({message, answer: own, ...options}: LimitOptions) {
  const answer = {error: RATE_LIMITED_MESSAGE, code: 'rate_limited', ...message};
  return rateLimit({
    ...options,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res: Response, _next, {statusCode}) => {
      if (own) return own(req, res);
      res.status(statusCode).json({...answer, requestId: res.locals.requestId});
    },
  });
}
