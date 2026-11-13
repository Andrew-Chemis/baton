// Apart from baton-distribution.ts so the local development server can import it without loading the CDK.
/** Content-Security-Policy of the app: its own origin, and the Cognito hosted UI for the sign-in token exchange. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' https://*.amazoncognito.com",
  "form-action 'self' https://*.amazoncognito.com",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');
