// Where the endpoint and the token come from: the environment first, then SSM when AWS credentials exist.
//
// SSM is called with a request this package signs itself (sigv4.ts), so the CLI stays free of dependencies and `npx` can run
// it in a bare session. That covers credentials in the environment and in the shared credentials file. Credentials that need
// a provider chain (SSO, an assumed role, a container role) are not read here; for those the CLI falls back to the `aws` command
// when it is installed, which resolves them itself.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CliError } from './git.ts';
import { signRequest, type Credentials } from './sigv4.ts';

const run = promisify(execFile);

export interface Resolved {
  url: string;
  token: string;
}

export const DEFAULT_TOKEN_PARAM = '/baton/agent-token';
export const DEFAULT_URL_PARAM = '/baton/url';

export async function awsCredentials(env: NodeJS.ProcessEnv): Promise<Credentials | undefined> {
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    return {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      sessionToken: env.AWS_SESSION_TOKEN,
    };
  }
  const file = env.AWS_SHARED_CREDENTIALS_FILE ?? join(env.HOME ?? homedir(), '.aws', 'credentials');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  const profile = env.AWS_PROFILE ?? 'default';
  let current = '';
  const values: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const section = /^\[(.+)\]$/.exec(line);
    if (section) current = (section[1] as string).trim();
    else if (current === profile) {
      const eq = line.indexOf('=');
      if (eq > 0) values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  }
  if (values.aws_access_key_id && values.aws_secret_access_key) {
    return {
      accessKeyId: values.aws_access_key_id,
      secretAccessKey: values.aws_secret_access_key,
      sessionToken: values.aws_session_token,
    };
  }
  return undefined;
}

async function viaSignedRequest(name: string, credentials: Credentials, env: NodeJS.ProcessEnv): Promise<string> {
  const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
  if (!region)
    throw new CliError('no_region', 'Set AWS_REGION so the CLI knows which SSM endpoint to read the token from.');
  const endpoint = env.AWS_ENDPOINT_URL_SSM ?? env.AWS_ENDPOINT_URL ?? `https://ssm.${region}.amazonaws.com/`;
  const body = JSON.stringify({ Name: name, WithDecryption: true });
  const headers = signRequest({
    method: 'POST',
    url: new URL(endpoint),
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AmazonSSM.GetParameter' },
    body,
    region,
    service: 'ssm',
    credentials,
  });
  const response = await fetch(endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  if (!response.ok) {
    let reason = text.slice(0, 200);
    try {
      const parsed = JSON.parse(text) as Record<string, string | undefined>;
      reason = `${parsed['__type'] ?? response.status}: ${parsed['message'] ?? parsed['Message'] ?? ''}`;
    } catch {
      // keep the raw text
    }
    throw new CliError(
      'ssm_failed',
      `Reading SSM parameter ${name} failed (${reason}). Check the credentials, region and parameter name.`,
      1,
    );
  }
  const value = (JSON.parse(text) as { Parameter?: { Value?: string } }).Parameter?.Value;
  if (!value) throw new CliError('ssm_failed', `SSM parameter ${name} has no value.`, 1);
  return value;
}

/** Something says AWS is set up here in a way the static readers above do not cover: a profile, a role or a container. */
function awsIsConfigured(env: NodeJS.ProcessEnv): boolean {
  const signals = [
    env.AWS_PROFILE,
    env.AWS_ROLE_ARN,
    env.AWS_WEB_IDENTITY_TOKEN_FILE,
    env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI,
    env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
    env.AWS_CONFIG_FILE,
  ];
  return signals.some(Boolean) || existsSync(join(env.HOME ?? homedir(), '.aws', 'config'));
}

// Credentials from a provider chain (an SSO login, an assumed role, a container role) cannot be read without the SDK, so for
// those the CLI asks the `aws` command, when it is installed, to make the one call. That is the only place this package runs
// another program for its own purposes, and it runs only when the signed request above had no credentials to use.
async function viaAwsCli(name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (!awsIsConfigured(env)) return undefined;
  try {
    const { stdout } = await run(
      'aws',
      ['ssm', 'get-parameter', '--name', name, '--with-decryption', '--query', 'Parameter.Value', '--output', 'text'],
      { env, encoding: 'utf8', timeout: 20_000 },
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function ssm(name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const credentials = await awsCredentials(env);
  if (credentials) return viaSignedRequest(name, credentials, env);
  return viaAwsCli(name, env);
}

export async function resolveConfig(env: NodeJS.ProcessEnv): Promise<Resolved> {
  let url = env.BATON_URL;
  let token = env.BATON_TOKEN;
  token ||= await ssm(env.BATON_SSM_TOKEN_PARAM ?? DEFAULT_TOKEN_PARAM, env);
  if (!token) {
    throw new CliError(
      'no_token',
      "No token. Set BATON_TOKEN (a token from the board's Agents page), or give the CLI AWS credentials that can read the SSM SecureString /baton/agent-token (set AWS_REGION too).",
    );
  }
  url ??= await ssm(env.BATON_SSM_URL_PARAM ?? DEFAULT_URL_PARAM, env);
  if (!url) {
    throw new CliError(
      'no_url',
      "No board address. Set BATON_URL to the board's https address, or store it in the SSM parameter /baton/url.",
    );
  }
  return { url: url.replace(/\/+$/, ''), token };
}
