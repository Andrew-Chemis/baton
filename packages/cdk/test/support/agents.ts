// Agents and their tokens, made the way a person does on the Agents page. Takes anything that can POST to the human API, so
// the service tests, the CLI tests and the local development server all use it.
type Post = (path: string, body?: unknown, key?: string) => Promise<{ status: number; body: any }>;
type Human = { post: Post };

export interface NewAgent {
  id: string;
  token: string;
  tokenId: string;
}

async function created(out: Promise<{ status: number; body: any }>, what: string): Promise<Record<string, any>> {
  const result = await out;
  if (result.status !== 201) throw new Error(`${what}: ${result.status} ${JSON.stringify(result.body)}`);
  return result.body as Record<string, any>;
}

/** Registers an agent and returns its id. */
export async function registerAgent(human: Human, name: string): Promise<string> {
  return (await created(human.post('/agents', { name }), 'agent')).agent.id as string;
}

/** Issues a token for an agent; `key` is an Idempotency-Key, to retry the issue. */
export async function issueToken(
  human: Human,
  agentId: string,
  options: { label?: string; key?: string } = {},
): Promise<{ token: string; tokenId: string }> {
  const body = await created(
    human.post(`/agents/${agentId}/tokens`, options.label === undefined ? {} : { label: options.label }, options.key),
    'token',
  );
  return { token: body.token as string, tokenId: body.tokenId as string };
}

/** An agent with one token. */
export async function newAgent(
  human: Human,
  name: string,
  options: { label?: string; key?: string } = {},
): Promise<NewAgent> {
  const id = await registerAgent(human, name);
  return { id, ...(await issueToken(human, id, options)) };
}
