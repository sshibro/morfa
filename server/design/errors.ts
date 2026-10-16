import type {DesignErrorCode} from '../../shared/design/api';

/** The API's error shape (`{error, code, ...}`); `extra` fields reach the client as `ApiError.details`. */
export type DesignFailure = Error & {status: number; code: string; extra?: Record<string, unknown>};

export function designFail(
  status: number,
  code: DesignErrorCode | 'invalid_request' | 'rate_limited',
  message: string,
  extra?: Record<string, unknown>,
): never {
  throw Object.assign(new Error(message), {status, code, ...(extra ? {extra} : {})}) as DesignFailure;
}

export const isDesignFailure = (error: unknown): error is DesignFailure =>
  error instanceof Error &&
  typeof (error as DesignFailure).status === 'number' &&
  typeof (error as DesignFailure).code === 'string';

export const NOT_FOUND = 'File not found.';
export const notFound = (): never => designFail(404, 'not_found', NOT_FOUND);
