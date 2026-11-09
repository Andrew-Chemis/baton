// AWS Signature Version 4 with Node's crypto, enough to call one JSON-protocol service. This is why the CLI has no
// dependency on the AWS SDK: it needs a single signed request, to read the token from SSM, and nothing else.
import { createHmac, hash } from 'node:crypto';

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | undefined;
}

const hex = (data: string | Buffer) => hash('sha256', data);
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();

const encode = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface SignInput {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
  region: string;
  service: string;
  credentials: Credentials;
  /** Fixed in tests; otherwise now. */
  date?: Date;
}

/** Returns the headers to send: the ones given plus host, x-amz-date, x-amz-security-token and Authorization. */
export function signRequest(input: SignInput): Record<string, string> {
  const date = input.date ?? new Date();
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) headers[k.toLowerCase()] = v.trim().replace(/\s+/g, ' ');
  headers.host = input.url.host;
  headers['x-amz-date'] = amzDate;
  if (input.credentials.sessionToken) headers['x-amz-security-token'] = input.credentials.sessionToken;

  const names = Object.keys(headers).toSorted();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const query = [...input.url.searchParams.entries()]
    .map(([k, v]) => [encode(k), encode(v)] as const)
    .toSorted((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalRequest = [
    input.method,
    input.url.pathname || '/',
    query,
    canonicalHeaders,
    signedHeaders,
    hex(input.body),
  ].join('\n');
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${input.credentials.secretAccessKey}`, day);
  const kSigning = hmac(hmac(hmac(kDate, input.region), input.service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}
