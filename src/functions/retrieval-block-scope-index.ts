import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import type { RetrievalBlock } from "../types.js";

type RetrievalBlockScopeEntry = {
  ids: string[];
  updatedAt: string;
};

const GLOBAL_SCOPE_KEY = "scope:global";
const READY_SCOPE_KEY = "scope:index-ready";
const BRANCH_SCOPE_PREFIX = "scope:branch:";
const SCOPE_INDEX = KV.retrievalBlockScopeIndex;
const LEGACY_SCOPE_INDEX = KV.retrievalBlockIndex;
const DEFAULT_SCOPED_RETRIEVAL_BLOCK_LOAD_LIMIT = 512;

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function encodeScopeSegment(value: string): string {
  return encodeURIComponent(value);
}

function projectScopeKey(project: string): string {
  return `scope:project:${encodeScopeSegment(project)}`;
}

function sessionScopeKey(sessionId: string): string {
  return `scope:session:${encodeScopeSegment(sessionId)}`;
}

function branchScopeKey(project: string, branch: string): string {
  return `scope:branch:${encodeScopeSegment(project)}:${encodeScopeSegment(branch)}`;
}

function blockScopeKeys(block: RetrievalBlock): string[] {
  const keys: string[] = [];
  if (block.scope === "global" || block.project === "global") {
    keys.push(GLOBAL_SCOPE_KEY);
    return keys;
  }
  keys.push(projectScopeKey(block.project));
  if (block.sessionId) keys.push(sessionScopeKey(block.sessionId));
  if (block.project && block.branch) {
    keys.push(branchScopeKey(block.project, block.branch));
  }
  return uniqueStrings(keys);
}

function requestedScopeKeys(options: {
  project?: string;
  sessionId?: string;
  branch?: string;
}): string[] {
  if (!options.project && !options.sessionId) return [];
  const keys = [GLOBAL_SCOPE_KEY];
  if (options.project && options.project !== "global") {
    keys.push(projectScopeKey(options.project));
  }
  if (options.sessionId) keys.push(sessionScopeKey(options.sessionId));
  if (options.project && options.project !== "global" && options.branch) {
    keys.push(branchScopeKey(options.project, options.branch));
  }
  return uniqueStrings(keys);
}

async function readScopeEntry(
  kv: StateKV,
  key: string,
): Promise<RetrievalBlockScopeEntry | null> {
  const entry =
    (await kv.get<RetrievalBlockScopeEntry>(SCOPE_INDEX, key).catch(() => null)) ??
    (await kv
      .get<RetrievalBlockScopeEntry>(LEGACY_SCOPE_INDEX, key)
      .catch(() => null));
  if (!entry || !Array.isArray(entry.ids)) return null;
  return {
    ids: entry.ids.filter((id): id is string => typeof id === "string" && id.length > 0),
    updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : new Date().toISOString(),
  };
}

async function writeScopeEntry(
  kv: StateKV,
  key: string,
  ids: string[],
): Promise<void> {
  await kv.set(SCOPE_INDEX, key, {
    ids: uniqueStrings(ids),
    updatedAt: new Date().toISOString(),
  } satisfies RetrievalBlockScopeEntry);
}

async function readReady(kv: StateKV): Promise<boolean> {
  const ready =
    (await kv.get<{ ready?: boolean }>(SCOPE_INDEX, READY_SCOPE_KEY).catch(() => null)) ??
    (await kv
      .get<{ ready?: boolean }>(LEGACY_SCOPE_INDEX, READY_SCOPE_KEY)
      .catch(() => null));
  return ready?.ready === true;
}

async function writeReady(kv: StateKV): Promise<void> {
  await kv.set(SCOPE_INDEX, READY_SCOPE_KEY, {
    ready: true,
    updatedAt: new Date().toISOString(),
  });
}

export async function upsertRetrievalBlockScopeMembership(
  kv: StateKV,
  block: RetrievalBlock,
  previous?: RetrievalBlock | null,
): Promise<void> {
  const previousKeys = new Set(previous ? blockScopeKeys(previous) : []);
  const nextKeys = new Set(blockScopeKeys(block));
  const allKeys = uniqueStrings([...previousKeys, ...nextKeys]);

  await Promise.all(
    allKeys.map(async (key) => {
      const existing = await readScopeEntry(kv, key);
      const ids = existing?.ids || [];
      const withoutPrevious = previousKeys.has(key)
        ? ids.filter((id) => id !== block.id)
        : ids;
      const nextIds = nextKeys.has(key)
        ? [block.id, ...withoutPrevious]
        : withoutPrevious;
      await writeScopeEntry(kv, key, nextIds);
    }),
  );
  await writeReady(kv);
}

export async function removeRetrievalBlockScopeMembership(
  kv: StateKV,
  block: RetrievalBlock,
): Promise<void> {
  const keys = blockScopeKeys(block);
  await Promise.all(
    keys.map(async (key) => {
      const existing = await readScopeEntry(kv, key);
      if (!existing) return;
      await writeScopeEntry(
        kv,
        key,
        existing.ids.filter((id) => id !== block.id),
      );
    }),
  );
  await writeReady(kv);
}

export async function warmRetrievalBlockScopeMemberships(
  kv: StateKV,
  blocks: RetrievalBlock[],
): Promise<void> {
  const grouped = new Map<string, string[]>();
  for (const block of blocks) {
    for (const key of blockScopeKeys(block)) {
      grouped.set(key, [...(grouped.get(key) || []), block.id]);
    }
  }
  if (!grouped.has(GLOBAL_SCOPE_KEY)) {
    grouped.set(GLOBAL_SCOPE_KEY, []);
  }
  await Promise.all(
    [...grouped.entries()].map(([key, ids]) => writeScopeEntry(kv, key, ids)),
  );
  await writeReady(kv);
}

export async function loadScopedRetrievalBlocks(
  kv: StateKV,
  options: {
    project?: string;
    sessionId?: string;
    branch?: string;
  },
): Promise<{ blocks: RetrievalBlock[]; complete: boolean }> {
  const scopeKeys = requestedScopeKeys(options);
  if (scopeKeys.length === 0) {
    return { blocks: [], complete: false };
  }
  if (!(await readReady(kv))) {
    return { blocks: [], complete: false };
  }

  const scopeEntries = await Promise.all(
    scopeKeys.map(async (key) => ({
      key,
      entry: await readScopeEntry(kv, key),
    })),
  );
  if (
    scopeEntries.some(
      ({ key, entry }) => !entry && !key.startsWith(BRANCH_SCOPE_PREFIX),
    )
  ) {
    return { blocks: [], complete: false };
  }
  const ids = uniqueStrings(
    scopeEntries.flatMap(({ entry }) => entry?.ids || []),
  );
  const loadLimit = readPositiveIntegerEnv(
    "AGENTMEMORY_SCOPED_RETRIEVAL_BLOCK_LOAD_LIMIT",
    DEFAULT_SCOPED_RETRIEVAL_BLOCK_LOAD_LIMIT,
  );

  if (ids.length === 0) {
    return { blocks: [], complete: true };
  }

  const idsToLoad = ids.slice(0, loadLimit);
  const loaded = await Promise.all(
    idsToLoad.map(async (id) => ({
      id,
      block: await kv.get<RetrievalBlock>(KV.retrievalBlocks, id).catch(() => null),
    })),
  );
  const missingIds = new Set(
    loaded
      .filter((entry) => !entry.block)
      .map((entry) => entry.id),
  );

  if (missingIds.size > 0) {
    await Promise.all(
      scopeEntries.map(async ({ key, entry }) => {
        if (!entry) return;
        await writeScopeEntry(
          kv,
          key,
          entry.ids.filter((id) => !missingIds.has(id)),
        );
      }),
    );
  }

  return {
    blocks: loaded
      .map((entry) => entry.block)
      .filter((block): block is RetrievalBlock => block !== null),
    complete: ids.length <= loadLimit && missingIds.size === 0,
  };
}
