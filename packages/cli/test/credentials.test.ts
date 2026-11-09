// Requirement 8.3: the token and endpoint come from the environment, then from SSM when AWS credentials exist. The signing is
// hand-written (no SDK in the package), so it is checked against AWS's published example and against the SDK's own signer.
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { signRequest } from '../src/sigv4.ts';
import { REPO, startWorld, type World } from './harness.ts';

describe('SigV4', () => {
  test('matches the example in the AWS documentation (IAM ListUsers)', () => {
    const headers = signRequest({
      method: 'GET',
      url: new URL('https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08'),
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: '',
      region: 'us-east-1',
      service: 'iam',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
      date: new Date('2015-08-30T12:36:00Z'),
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, ' +
        'SignedHeaders=content-type;host;x-amz-date, ' +
        'Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
    );
  });

  const cases = [
    {
      name: 'a JSON POST to SSM',
      body: '{"Name":"/baton/agent-token","WithDecryption":true}',
      session: undefined,
      query: '',
    },
    { name: 'a POST with a session token', body: '{"Name":"x"}', session: 'FwoGZXIvYXdzEXAMPLETOKEN/+=', query: '' },
    { name: 'a query that needs sorting and encoding', body: '', session: undefined, query: '?b=2&a=1&a=%20x&c=%2F' },
  ];
  test.each(cases)('agrees with the AWS SDK signer for $name', async ({ body, session, query }) => {
    const date = new Date('2026-03-04T05:06:07Z');
    const credentials = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret/KEY+value', sessionToken: session };
    const url = new URL(`https://ssm.us-west-2.amazonaws.com/${query}`);
    const ours = signRequest({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AmazonSSM.GetParameter' },
      body,
      region: 'us-west-2',
      service: 'ssm',
      credentials,
      date,
    });
    const signer = new SignatureV4({
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        ...(session ? { sessionToken: session } : {}),
      },
      region: 'us-west-2',
      service: 'ssm',
      sha256: Sha256,
      applyChecksum: false,
    });
    const query2: Record<string, string | string[]> = {};
    for (const [k, v] of url.searchParams) {
      const prior = query2[k];
      query2[k] = prior === undefined ? v : [...(Array.isArray(prior) ? prior : [prior]), v];
    }
    const signed = await signer.sign(
      new HttpRequest({
        method: 'POST',
        protocol: 'https:',
        hostname: url.hostname,
        path: url.pathname,
        query: query2,
        headers: {
          'content-type': 'application/x-amz-json-1.1',
          'x-amz-target': 'AmazonSSM.GetParameter',
          host: url.host,
        },
        body,
      }),
      { signingDate: date },
    );
    const theirs = Object.fromEntries(Object.entries(signed.headers).map(([k, v]) => [k.toLowerCase(), v]));
    expect(ours.authorization).toBe(theirs.authorization);
    expect(ours['x-amz-date']).toBe(theirs['x-amz-date']);
  });
});

let w: World;
let ssm: Server;
let ssmUrl: string;
const seen: { target: string | undefined; auth: string | undefined; body: string; token: string | undefined }[] = [];
const PARAMS: Record<string, string> = {};

beforeAll(async () => {
  w = await startWorld();
  await w.board.as({ human: 'owner@example.test' }).post('/projects', { name: 'Widgets', repos: [REPO] });
  PARAMS['/baton/agent-token'] = w.token;
  PARAMS['/baton/url'] = w.server.url;
  // The part of SSM this needs: GetParameter, answered only to a request signed by the key it is told about.
  ssm = createServer((req: IncomingMessage, res) => {
    void (async () => {
      const body = await text(req);
      const auth = req.headers.authorization;
      seen.push({
        target: req.headers['x-amz-target'] as string | undefined,
        auth,
        body,
        token: req.headers['x-amz-security-token'] as string | undefined,
      });
      const name = (JSON.parse(body) as { Name: string }).Name;
      const value = PARAMS[name];
      res.setHeader('content-type', 'application/x-amz-json-1.1');
      if (!auth?.includes('Credential=AKIAEXAMPLE/') || value === undefined) {
        res.statusCode = value === undefined ? 400 : 403;
        res.end(
          JSON.stringify({
            __type: value === undefined ? 'ParameterNotFound' : 'UnrecognizedClientException',
            message: 'no',
          }),
        );
        return;
      }
      res.end(JSON.stringify({ Parameter: { Name: name, Type: 'SecureString', Value: value } }));
    })();
  });
  await new Promise<void>((r) => ssm.listen(0, '127.0.0.1', r));
  const address = ssm.address();
  ssmUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`;
});
afterAll(async () => {
  ssm.close();
  await w.close();
});

const noToken = { BATON_TOKEN: undefined, BATON_URL: undefined };
const awsEnv = {
  AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'secret',
  AWS_REGION: 'us-west-2',
  AWS_ENDPOINT_URL_SSM: '',
};

describe('where the token and address come from', () => {
  test('the environment wins and SSM is never asked', async () => {
    seen.length = 0;
    const result = await w.baton(['check'], { env: { ...awsEnv, AWS_ENDPOINT_URL_SSM: ssmUrl } });
    expect(result.code).toBe(0);
    expect(seen).toHaveLength(0);
  });

  test('with no BATON_TOKEN the token (and the address) are read from SSM with a signed request', async () => {
    seen.length = 0;
    const result = await w.baton(['check'], {
      env: { ...noToken, ...awsEnv, AWS_ENDPOINT_URL_SSM: ssmUrl, AWS_SESSION_TOKEN: 'session-token-value' },
    });
    expect(result.code).toBe(0);
    expect(result.json.cards).toEqual([]);
    expect(seen.map((s) => JSON.parse(s.body))).toEqual([
      { Name: '/baton/agent-token', WithDecryption: true },
      { Name: '/baton/url', WithDecryption: true },
    ]);
    expect(seen.every((s) => s.target === 'AmazonSSM.GetParameter' && s.token === 'session-token-value')).toBe(true);
    expect(seen[0]?.auth).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/us-west-2\/ssm\/aws4_request, SignedHeaders=.*x-amz-security-token.*x-amz-target/,
    );
  });

  test('BATON_URL with the token from SSM reads only the token', async () => {
    seen.length = 0;
    const result = await w.baton(['check'], {
      env: { BATON_TOKEN: undefined, ...awsEnv, AWS_ENDPOINT_URL_SSM: ssmUrl },
    });
    expect(result.code).toBe(0);
    expect(seen).toHaveLength(1);
  });

  test('credentials in the shared credentials file are used', async () => {
    const home = mkdtempSync(join(tmpdir(), 'baton-home-'));
    mkdirSync(join(home, '.aws'));
    const file = join(home, '.aws', 'credentials');
    writeFileSync(
      file,
      '[default]\naws_access_key_id = nope\naws_secret_access_key = nope\n\n[baton]\naws_access_key_id = AKIAEXAMPLE\naws_secret_access_key = from-file\n',
    );
    seen.length = 0;
    const result = await w.baton(['check'], {
      env: { ...noToken, HOME: home, AWS_PROFILE: 'baton', AWS_REGION: 'us-west-2', AWS_ENDPOINT_URL_SSM: ssmUrl },
    });
    expect(result.code).toBe(0);
    expect(seen).toHaveLength(2);
  });

  test('a refused SSM read says which parameter and what to check', async () => {
    const result = await w.baton(['check'], {
      env: { ...noToken, ...awsEnv, AWS_ACCESS_KEY_ID: 'AKIABAD', AWS_ENDPOINT_URL_SSM: ssmUrl },
    });
    expect(result.code).toBe(1);
    expect(result.error.code).toBe('ssm_failed');
    expect(result.error.message).toMatch(/\/baton\/agent-token/);
    expect(result.error.message).toMatch(/credentials, region and parameter name/);
  });

  test('SSM credentials without a region ask for AWS_REGION', async () => {
    const result = await w.baton(['check'], {
      env: { ...noToken, ...awsEnv, AWS_REGION: undefined, AWS_DEFAULT_REGION: undefined },
    });
    expect(result.code).toBe(2);
    expect(result.error.code).toBe('no_region');
  });

  test('no token anywhere: exit 2 naming both ways to supply one', async () => {
    const result = await w.baton(['check'], { env: noToken });
    expect(result.code).toBe(2);
    expect(result.error.code).toBe('no_token');
    expect(result.error.message).toMatch(/BATON_TOKEN/);
    expect(result.error.message).toMatch(/\/baton\/agent-token/);
  });

  test('a token but no address asks for BATON_URL', async () => {
    const result = await w.baton(['check'], { env: { BATON_URL: undefined } });
    expect(result.code).toBe(2);
    expect(result.error.code).toBe('no_url');
  });

  test('without static credentials, a configured profile is resolved by the aws command, when one is installed', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'baton-bin-'));
    const log = join(bin, 'calls.txt');
    const script = join(bin, 'aws');
    writeFileSync(
      script,
      `#!/bin/sh\necho "$@" >> ${log}\ncase "$*" in *agent-token*) echo ${w.token};; *) echo ${w.server.url};; esac\n`,
    );
    chmodSync(script, 0o755);
    const result = await w.baton(['check'], {
      env: { ...noToken, AWS_PROFILE: 'sso-dev', PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
    expect(result.code).toBe(0);
    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain('ssm get-parameter --name /baton/agent-token --with-decryption');
  });

  test('with nothing indicating AWS is set up, the aws command is not run', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'baton-bin-'));
    const marker = join(bin, 'ran');
    const script = join(bin, 'aws');
    writeFileSync(script, `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(script, 0o755);
    const result = await w.baton(['check'], { env: { ...noToken, PATH: `${bin}:${process.env.PATH ?? ''}` } });
    expect(result.error.code).toBe('no_token');
    expect(existsSync(marker)).toBe(false);
  });
});
