import type {Request, Response, NextFunction, RequestHandler} from 'express';

/** Keep nested/callback adapters explicit; Express 5 also handles returned promises natively. */
export function asyncHandler(handler: (req: Request, res: Response, next: NextFunction) => unknown): RequestHandler {
  return (req, res, next) => {
    try {
      return Promise.resolve(handler(req, res, next)).catch(next);
    } catch (error) {
      next(error);
    }
  };
}
