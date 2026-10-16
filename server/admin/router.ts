import express, {type Response, type Router} from 'express';
import {z} from 'zod';
import {asyncHandler} from '../http';
import {ACCOUNT_SEGMENTS, ADMIN_ACCOUNT_SORTS, ADMIN_PERIODS, DEFAULT_ADMIN_PERIOD} from '../../shared/admin-analytics';
import {adminAccount} from './analytics/account';
import {adminAccounts} from './analytics/accounts';
import {operatorGate} from './operators';
import {periodReport, snapshot, type PeriodReportName} from './reports';

export {forgetAdminReports} from './reports';

/* The operator's console (shared/admin-analytics.ts), mounted at /api/admin: GET and read only. To anyone but an operator
 * (server/admin/operators.ts), signed out included, every path answers exactly what an unknown API route does, so the console cannot be
 * found. The operator's own reading is no one's activity: it never reaches the journal. */

const INVALID = 'Check the request data.';
const MAX_PAGE = 100_000;
const MAX_QUERY = 200;

const periodQuery = z.object({period: z.enum(ADMIN_PERIODS).default(DEFAULT_ADMIN_PERIOD)}).passthrough();
const accountsQuery = z
  .object({
    q: z
      .string()
      .max(MAX_QUERY)
      .default('')
      .transform(value => value.trim()),
    segment: z.enum([...ACCOUNT_SEGMENTS, 'all'] as const).default('all'),
    sort: z.enum(ADMIN_ACCOUNT_SORTS).default('created'),
    order: z.enum(['asc', 'desc']).default('desc'),
    page: z.coerce.number().int().min(1).max(MAX_PAGE).default(1),
  })
  .passthrough();
const accountId = z.string().min(1).max(200);

function invalid(res: Response) {
  res.status(400).json({error: INVALID, code: 'invalid_request', requestId: res.locals.requestId});
}

export function createAdminRouter(): Router {
  const router = express.Router();
  router.use((req, res, next) => {
    // The support chat's side (/api/admin/support, server/support) is its own router behind the same gate: never answered here.
    if (/^\/support(?:\/|$)/.test(req.path)) return next('router');
    res.locals.notActivity = true;
    next();
  }, operatorGate);
  const report = (name: PeriodReportName) =>
    router.get(
      '/' + name,
      asyncHandler(async (req, res) => {
        const query = periodQuery.safeParse(req.query);
        if (!query.success) return invalid(res);
        res.json(await periodReport(name, query.data.period));
      }),
    );
  report('overview');
  report('usage');
  router.get(
    '/accounts',
    asyncHandler(async (req, res) => {
      const query = accountsQuery.safeParse(req.query);
      if (!query.success) return invalid(res);
      res.json(await snapshot(tx => adminAccounts(tx, query.data, new Date())));
    }),
  );
  router.get(
    '/accounts/:id',
    asyncHandler(async (req, res) => {
      const id = accountId.safeParse(req.params.id);
      if (!id.success) return invalid(res);
      const account = await snapshot(tx => adminAccount(tx, id.data, new Date()));
      if (!account) {
        res.status(404).json({error: 'Account not found.', code: 'not_found'});
        return;
      }
      res.json(account);
    }),
  );
  return router;
}
