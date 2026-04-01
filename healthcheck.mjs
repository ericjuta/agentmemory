const HEALTH_URL = "http://127.0.0.1:3113/agentmemory/health";

try {
  const response = await fetch(HEALTH_URL, {
    signal: AbortSignal.timeout(4000),
  });

  if (!response.ok) {
    process.exit(1);
  }
} catch {
  process.exit(1);
}
