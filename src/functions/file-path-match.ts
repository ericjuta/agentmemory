function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/").trim().toLowerCase();
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
  if (basename(left) === basename(right)) return true;
  if (left.endsWith(`/${right}`) || right.endsWith(`/${left}`)) return true;
  return left.includes(right) || right.includes(left);
}
