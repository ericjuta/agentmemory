import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import type { RetrievalBlock } from "../types.js";

type RetrievalBlockScopeEntry = {
  ids: string[];
  updatedAt: string;
};

const GLOBAL_SCOPE_KEY = "scope:global";
const READY_SCOPE_KEY = "scope:index-ready";

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
  if (options.project) keys.push(projectScopeKey(options.project));
  if (options.sessionId) keys.push(sessionScopeKey(options.sessionId));
  if (options.project && options.branch) {
    keys.push(branchScopeKey(options.project, options.branch));
  }
  return uniqueStrings(keys);
}

async function readScopeEntry(
  kv: StateKV,
  key: string,
): Promise<RetrievalBlockScopeEntry | null> {
  const entry = await kv
    .get<RetrievalBlockScopeEntry>(KV.retrievalBlockIndex, key)
    .catch(() => null);
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
  await kv.set(KV.retrievalBlockIndex, key, {
    ids: uniqueStrings(ids),
    updatedAt: new Date().toISOString(),
  } satisfies RetrievalBlockScopeEntry);
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
  await kv.set(KV.retrievalBlockIndex, READY_SCOPE_KEY, {
    ready: true,
    updatedAt: new Date().toISOString(),
  });
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
  await kv.set(KV.retrievalBlockIndex, READY_SCOPE_KEY, {
    ready: true,
    updatedAt: new Date().toISOString(),
  });
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
  await kv.set(KV.retrievalBlockIndex, READY_SCOPE_KEY, {
    ready: true,
    updatedAt: new Date().toISOString(),
  });
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
  const ready = await kv
    .get<{ ready?: boolean }>(KV.retrievalBlockIndex, READY_SCOPE_KEY)
    .catch(() => null);
  if (!ready?.ready) {
    return { blocks: [], complete: false };
  }

  const scopeEntries = await Promise.all(
    scopeKeys.map(async (key) => ({
      key,
      entry: await readScopeEntry(kv, key),
    })),
  );
  if (scopeEntries.some(({ entry }) => !entry)) {
    return { blocks: [], complete: false };
  }
  const ids = uniqueStrings(
    scopeEntries.flatMap(({ entry }) => entry?.ids || []),
  );

  if (ids.length === 0) {
    return { blocks: [], complete: true };
  }

  const loaded = await Promise.all(
    ids.map(async (id) => ({
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
    complete: missingIds.size === 0,
  };
}
