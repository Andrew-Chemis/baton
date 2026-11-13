// The event API Gateway hands the Lambda, built from the parts a test or the local server has.
import type { HttpEvent } from '../../service/router.ts';

/** `path` may carry its query string. `authorizer` is what the gateway's authorizer put on the request. */
export function httpEvent(
  method: string,
  path: string,
  options: {
    headers?: Record<string, string | undefined>;
    body?: string | undefined;
    authorizer?: HttpEvent['requestContext']['authorizer'];
  } = {},
): HttpEvent {
  const at = path.indexOf('?');
  return {
    rawPath: at === -1 ? path : path.slice(0, at),
    rawQueryString: at === -1 ? '' : path.slice(at + 1),
    headers: options.headers ?? {},
    body: options.body,
    requestContext: { http: { method }, ...(options.authorizer ? { authorizer: options.authorizer } : {}) },
  };
}
