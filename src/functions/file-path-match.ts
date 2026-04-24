function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/").trim().toLowerCase();
}

function hasPathSegments(value: string): boolean {
  return normalizePath(value).includes("/");
}

function segmentBoundarySuffix(left: string, right: string): boolean {
  return left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

export function basename(filePath: string): string {
  const parts = normalizePath(filePath).split("/");
  return parts[parts.length - 1] || normalizePath(filePath);
}

export function filePathMatches(candidate: string, target: string): boolean {
  const left = normalizePath(candidate);
  const right = normalizePath(target);
  if (!left || !right) return false;
  if (left === right) return true;
  return segmentBoundarySuffix(left, right);
}

export function filePathMatchesAny(
  candidates: string[],
  target: string,
): boolean {
  const normalizedTarget = normalizePath(target);
  if (!normalizedTarget) return false;

  if (candidates.some((candidate) => filePathMatches(candidate, target))) {
    return true;
  }

  const targetBasename = basename(normalizedTarget);
  if (!targetBasename) return false;

  const basenameMatches = candidates
    .map((candidate) => normalizePath(candidate))
    .filter(Boolean)
    .filter((candidate) => basename(candidate) === targetBasename);

  if (basenameMatches.length !== 1) return false;

  const [candidate] = basenameMatches;
  return !hasPathSegments(candidate) || !hasPathSegments(normalizedTarget);
}
