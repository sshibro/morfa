import type {Request, RequestHandler} from 'express';

/* How long a request may take to arrive. Node gives every request five minutes (its requestTimeout), which
 * a 200 MB export over a slow line cannot meet, and Node cannot vary it by route. So Node's own limit is
 * only the backstop, and this middleware keeps the five minutes for every route but file imports. An
 * import may take as long as its declared size needs at about 1 Mbit/s, from five minutes to half an
 * hour, and is cut as soon as nothing arrives for a minute: a trickle cannot hold its place. */
export const REQUEST_BODY_WINDOW_MS = 5 * 60 * 1000;
export const UPLOAD_MAX_WINDOW_MS = 30 * 60 * 1000;
export const UPLOAD_MIN_BYTES_PER_SECOND = 128 * 1024;
export const UPLOAD_IDLE_MS = 60 * 1000;
/** Node's requestTimeout: just above the longest window, so this middleware always acts first. */
export const SERVER_REQUEST_TIMEOUT_MS = UPLOAD_MAX_WINDOW_MS + 60 * 1000;
export const REQUEST_TOO_SLOW = 'The request took too long to send. Check your connection and try again.';

/** How long a request body of `declaredBytes` may take to arrive. */
export function bodyWindowMs(declaredBytes: number, upload: boolean) {
  if (!upload) return REQUEST_BODY_WINDOW_MS;
  const needed = (Math.max(0, declaredBytes) / UPLOAD_MIN_BYTES_PER_SECOND) * 1000;
  return Math.min(UPLOAD_MAX_WINDOW_MS, Math.max(REQUEST_BODY_WINDOW_MS, needed));
}

export type BodyWindowOptions = {
  /** Requests that get the upload window, and the idle cut, instead of the plain five minutes. */
  isUpload: (req: Request) => boolean;
  /** What an upload that ran out of time is told. */
  uploadMessage: string;
  window?: (declaredBytes: number, upload: boolean) => number;
  idleMs?: number;
  checkEveryMs?: number;
};

/**
 * Cuts a request whose body has not fully arrived in its window, or an upload with no new bytes for
 * `idleMs` (measured between chunks, not in total). An upload's route learns of it through
 * `res.locals.bodyExpired`, a promise that rejects with a 408 error, so it answers in its own words;
 * any other route is answered 408 here. Either way the connection closes once the answer is sent.
 */
export function requestBodyWindow({
  isUpload,
  uploadMessage,
  window = bodyWindowMs,
  idleMs = UPLOAD_IDLE_MS,
  checkEveryMs = 5000,
}: BodyWindowOptions): RequestHandler {
  return (req, res, next) => {
    if (req.complete) return next();
    const upload = isUpload(req);
    const windowMs = window(Number(req.headers['content-length']) || 0, upload);
    const socket = req.socket;
    const started = Date.now();
    let seen = socket.bytesRead,
      progressAt = started,
      expire: (error: Error) => void = () => {};
    if (upload) {
      res.locals.bodyExpired = new Promise<never>((_resolve, reject) => (expire = reject));
      // Nothing may be left unobserved when the route never races it.
      res.locals.bodyExpired.catch(() => {});
    }
    const timer = setInterval(() => {
      if (req.complete) return stop();
      const now = Date.now();
      if (socket.bytesRead !== seen) {
        seen = socket.bytesRead;
        progressAt = now;
      }
      const idle = upload && now - progressAt > idleMs;
      if (now - started <= windowMs && !idle) return;
      stop();
      res.once('finish', () => req.destroy());
      const error = Object.assign(Error(upload ? uploadMessage : REQUEST_TOO_SLOW), {status: 408});
      if (upload) expire(error);
      else if (!res.headersSent) res.status(408).set('Connection', 'close').json({error: error.message});
      else req.destroy();
    }, checkEveryMs);
    timer.unref();
    const stop = () => clearInterval(timer);
    res.once('close', stop);
    next();
  };
}
