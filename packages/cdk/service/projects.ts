// Projects, the repo map and the dashboard counts (Requirement 10).
import { GSI1 } from '../src/schema.ts';
import type { ProjectCounts, ProjectView } from './api-types.ts';
import { stateOf, isUnread } from './card-model.ts';
import type { CardItem, ProjectItem } from './items.ts';
import { ApiError, badRequest, notFound } from './errors.ts';
import { execute, type Attempt, type Reply, type RequestCtx } from './engine.ts';
import { randomChars, slugify } from './ids.ts';
import {
  ARCHIVED_PROJECTS_PARTITION,
  PROJECTS_PARTITION,
  boardPartition,
  projectKey,
  projectNameKey,
  repoKey,
} from './keys.ts';
import { asObject, normalizeName, normalizeRepo, stringList } from './validate.ts';
import {
  deleteItem,
  diffUpdate,
  getItem,
  putNew,
  queryAll,
  updateItem,
  type Deps,
  type TransactItem,
} from './store.ts';

const MAX_REPOS = 25;

interface NameItem {
  projectId: string;
}
interface RepoItem {
  projectId: string;
  repo: string;
}

function projectItem(p: Omit<ProjectItem, 'PK' | 'SK' | 'GSI1PK' | 'GSI1SK' | 'type'>): ProjectItem {
  return {
    ...p,
    ...projectKey(p.id),
    SK: 'META',
    type: 'project',
    GSI1PK: p.archived ? ARCHIVED_PROJECTS_PARTITION : PROJECTS_PARTITION,
    GSI1SK: `${p.nameKey}#${p.id}`,
  };
}

const emptyCounts = (): ProjectCounts => ({
  total: 0,
  claimed: 0,
  stale: 0,
  unowned: 0,
  reopened: 0,
  unread: 0,
  inReview: 0,
});

function foldCounts(cards: CardItem[], now: number): ProjectCounts {
  const counts = emptyCounts();
  for (const card of cards) {
    if (card.archived) continue;
    counts.total += 1;
    const state = stateOf(card, now);
    if (state === 'claimed') counts.claimed += 1;
    if (state === 'stale') counts.stale += 1;
    if (state === 'unowned') counts.unowned += 1;
    if (card.reopened) counts.reopened += 1;
    if (isUnread(card)) counts.unread += 1;
    if (card.column === 'in_review') counts.inReview += 1;
  }
  return counts;
}

const boardCards = (deps: Deps, projectId: string) =>
  queryAll<CardItem>(deps, {
    IndexName: GSI1.name,
    KeyConditionExpression: '#pk = :pk',
    ExpressionAttributeNames: { '#pk': GSI1.pk },
    ExpressionAttributeValues: { ':pk': boardPartition(projectId) },
  });

/** The wire shape of a project; `counts` only where the route promises them. */
const toProjectView = (item: ProjectItem, counts?: ProjectCounts): ProjectView => ({
  id: item.id,
  name: item.name,
  repos: item.repos,
  archived: item.archived,
  lastEventAt: item.lastEventAt,
  createdAt: item.createdAt,
  ...(counts ? { counts } : {}),
});

const projectView = async (deps: Deps, item: ProjectItem, now: number, withCounts: boolean): Promise<ProjectView> =>
  toProjectView(item, withCounts ? foldCounts(await boardCards(deps, item.id), now) : undefined);

export async function listProjects(
  deps: Deps,
  query: { repo?: string | undefined; counts: boolean },
): Promise<{ projects: ProjectView[] }> {
  const now = deps.now();
  if (query.repo) {
    const mapped = await getItem<RepoItem>(deps, repoKey(normalizeRepo(query.repo)));
    const item = mapped ? await getItem<ProjectItem>(deps, projectKey(mapped.projectId)) : undefined;
    return { projects: item && !item.archived ? [await projectView(deps, item, now, query.counts)] : [] };
  }
  const items = await queryAll<ProjectItem>(deps, {
    IndexName: GSI1.name,
    KeyConditionExpression: '#pk = :pk',
    ExpressionAttributeNames: { '#pk': GSI1.pk },
    ExpressionAttributeValues: { ':pk': PROJECTS_PARTITION },
  });
  return { projects: await Promise.all(items.map((item) => projectView(deps, item, now, query.counts))) };
}

async function loadProject(deps: Deps, id: string): Promise<ProjectItem> {
  const item = await getItem<ProjectItem>(deps, projectKey(id));
  if (!item) throw notFound(`No project "${id}". List projects with GET /projects, or register one.`);
  return item;
}

const repoTaken = async (deps: Deps, repo: string): Promise<ApiError> => {
  const mapped = await getItem<RepoItem>(deps, repoKey(repo));
  const holder = mapped ? await getItem<ProjectItem>(deps, projectKey(mapped.projectId)) : undefined;
  return new ApiError(
    'repo_taken',
    holder
      ? `Repo ${repo} already belongs to project "${holder.name}". Use that project (its board is at /p/${holder.id}), or remove the repo from it first.`
      : `Repo ${repo} was registered a moment ago by another request. Repeat this request to see which project holds it.`,
    holder ? { project: { id: holder.id, name: holder.name } } : {},
  );
};

const nameTaken = (holder: { id: string; name: string }) =>
  new ApiError(
    'name_taken',
    `A project named "${holder.name}" already exists (/p/${holder.id}). Pick another name, or add repos to that one.`,
    {
      project: { id: holder.id, name: holder.name },
    },
  );

function parseRepos(value: unknown, field: string): string[] {
  const list = stringList(value, field, MAX_REPOS, 300).map((r) => normalizeRepo(r, field));
  return [...new Set(list)];
}

const putRepo = (repo: string, projectId: string): TransactItem =>
  putNew({ ...repoKey(repo), type: 'repo', repo, projectId });

/** Frees `repo` for another project, provided this one still holds it. */
const releaseRepo = (repo: string, projectId: string): TransactItem =>
  deleteItem(repoKey(repo), { expr: '#p = :p', names: { '#p': 'projectId' }, values: { ':p': projectId } });

/** Writes `next` over `project`; any change to the project since it was read bumped `rev`, so this then fails. */
const updateProject = (project: ProjectItem, next: ProjectItem): TransactItem =>
  diffUpdate(projectKey(project.id), project, next, {
    expr: '#rev = :rev0',
    names: { '#rev': 'rev' },
    values: { ':rev0': project.rev },
  });

/** Refuses repos the project already holds, naming the project (Requirement 10.2), and a list longer than it may hold. */
async function assertCanAdd(deps: Deps, project: ProjectItem, add: string[], resulting: string[]): Promise<void> {
  const held = add.filter((r) => project.repos.includes(r));
  if (held.length > 0) throw await repoTaken(deps, held[0] as string);
  if (resulting.length > MAX_REPOS) throw badRequest(`A project may hold at most ${MAX_REPOS} repos.`);
}

/** Adds repos to a project that exists. A repo it already holds is refused, naming the project (Requirement 10.2). */
async function addRepos(deps: Deps, project: ProjectItem, repos: string[], now: number): Promise<Attempt> {
  const resulting = [...project.repos, ...repos];
  await assertCanAdd(deps, project, repos, resulting);
  const next = projectItem({ ...project, repos: resulting, rev: project.rev + 1, updatedAt: now });
  return {
    items: [updateProject(project, next), ...repos.map((repo) => putRepo(repo, project.id))],
    reply: { status: 200, body: { project: toProjectView(next), created: false, added: repos } },
    retryOn: [0],
    classify: async (c) => {
      const index = repos.findIndex((_, i) => c.failed(1 + i));
      return index >= 0 ? await repoTaken(deps, repos[index] as string) : undefined;
    },
  };
}

export async function registerProject(deps: Deps, ctx: RequestCtx, input: unknown): Promise<Reply> {
  const body = asObject(input);
  const { name, nameKey } = normalizeName(body.name);
  const repos = parseRepos(body.repos, 'repos');
  const ifExists = body.ifExists === undefined ? 'refuse' : body.ifExists;
  if (ifExists !== 'add' && ifExists !== 'refuse') throw badRequest('ifExists must be "add" or "refuse".');
  return execute(deps, ctx, async (now) => {
    const named = await getItem<NameItem>(deps, projectNameKey(nameKey));
    if (named) {
      const existing = await loadProject(deps, named.projectId);
      if (ifExists !== 'add') throw nameTaken(existing);
      if (repos.length === 0)
        throw badRequest(`Project "${existing.name}" exists. Name at least one repo to add to it.`);
      return addRepos(deps, existing, repos, now);
    }
    let id = slugify(name);
    if (await getItem(deps, projectKey(id))) id = `${id}-${randomChars(4)}`;
    const item = projectItem({
      id,
      name,
      nameKey,
      repos,
      archived: false,
      rev: 0,
      lastEventAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const items: TransactItem[] = [
      putNew(item),
      putNew({ ...projectNameKey(nameKey), type: 'project-name', projectId: id }),
      ...repos.map((repo) => putRepo(repo, id)),
    ];
    return {
      items,
      reply: {
        status: 201,
        body: { project: toProjectView(item, emptyCounts()), created: true, added: repos },
      },
      classify: async (c) => {
        // The name or the id appeared between the read and the write: read again and take the add or refuse path.
        if (c.failed(0) || c.failed(1)) return 'retry';
        const index = repos.findIndex((_, i) => c.failed(2 + i));
        return index >= 0 ? await repoTaken(deps, repos[index] as string) : undefined;
      },
    };
  });
}

export async function patchProject(deps: Deps, ctx: RequestCtx, id: string, input: unknown): Promise<Reply> {
  const body = asObject(input);
  const rename = body.name === undefined ? undefined : normalizeName(body.name);
  const add = parseRepos(body.addRepos, 'addRepos');
  const remove = parseRepos(body.removeRepos, 'removeRepos');
  if (!rename && add.length === 0 && remove.length === 0) throw badRequest('Send name, addRepos or removeRepos.');
  return execute(deps, ctx, async (now) => {
    const project = await loadProject(deps, id);
    if (project.archived) throw badRequest(`Project "${project.name}" is archived and can no longer be changed.`);
    const missing = remove.filter((r) => !project.repos.includes(r));
    if (missing.length > 0) throw badRequest(`Project "${project.name}" does not hold ${missing.join(', ')}.`);
    const repos = [...project.repos.filter((r) => !remove.includes(r)), ...add];
    await assertCanAdd(deps, project, add, repos);
    // Only a new name key is a change of name here; a respelling keeps the key and just rewrites the name.
    const renamed = rename && rename.nameKey !== project.nameKey ? rename : undefined;
    const next = projectItem({
      ...project,
      name: rename ? rename.name : project.name,
      nameKey: rename ? rename.nameKey : project.nameKey,
      repos,
      rev: project.rev + 1,
      updatedAt: now,
    });
    const items: TransactItem[] = [updateProject(project, next)];
    const addAt = items.length;
    for (const repo of add) items.push(putRepo(repo, id));
    for (const repo of remove) items.push(releaseRepo(repo, id));
    const nameAt = items.length;
    if (renamed) {
      items.push(putNew({ ...projectNameKey(renamed.nameKey), type: 'project-name', projectId: id }));
      items.push(deleteItem(projectNameKey(project.nameKey)));
    }
    const view = await projectView(deps, next, now, true);
    return {
      items,
      reply: { status: 200, body: { project: view } },
      retryOn: [0],
      classify: async (c) => {
        const addIndex = add.findIndex((_, i) => c.failed(addAt + i));
        if (addIndex >= 0) return await repoTaken(deps, add[addIndex] as string);
        if (renamed && c.failed(nameAt)) {
          const named = await getItem<NameItem>(deps, projectNameKey(renamed.nameKey));
          const holder = named ? await getItem<ProjectItem>(deps, projectKey(named.projectId)) : undefined;
          return holder ? nameTaken(holder) : 'retry';
        }
        return undefined;
      },
    };
  });
}

/** Archives a project that has no claim on any card, and frees its repos (Requirement 10.5). */
export async function archiveProject(deps: Deps, ctx: RequestCtx, id: string): Promise<Reply> {
  return execute(deps, ctx, async (now) => {
    const project = await loadProject(deps, id);
    if (project.archived) {
      return { items: [], reply: { status: 200, body: { project: await projectView(deps, project, now, true) } } };
    }
    const cards = await boardCards(deps, id);
    // Any claim blocks, stale or not: a stale holder can still heartbeat its claim back to life without moving `rev`.
    const claimed = cards.filter((c) => !c.archived && c.claim);
    if (claimed.length > 0) {
      const first = claimed[0] as CardItem;
      throw new ApiError(
        'project_has_claims',
        `Project "${project.name}" has ${claimed.length} claimed card(s), for example ${first.key ?? first.title} held by ${first.claim?.agentId}. ` +
          'Wait for those agents to pass or drop them. A card whose agent is gone can be moved to Done or archived here. Then archive the project again.',
        { project: { id: project.id, name: project.name } },
      );
    }
    const next = projectItem({ ...project, archived: true, repos: [], rev: project.rev + 1, updatedAt: now });
    // Any card write since the read bumped rev, so a claim that landed after the check above fails this update.
    const items: TransactItem[] = [
      updateProject(project, next),
      deleteItem(projectNameKey(project.nameKey)),
      ...project.repos.map((repo) => releaseRepo(repo, id)),
    ];
    return { items, reply: { status: 200, body: { project: toProjectView(next) } }, retryOn: [0] };
  });
}

/** The Update that records a card event on its project. One per transaction; `rev` moves so project edits notice. */
export const touchProject = (projectId: string, now: number): TransactItem =>
  updateItem(projectKey(projectId), {
    expr: 'SET #l = :now ADD #rev :one',
    names: { '#l': 'lastEventAt', '#rev': 'rev' },
    values: { ':now': now, ':one': 1 },
  });
