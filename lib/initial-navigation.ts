export interface InitialNavigation {
  requestedCwd: string | null;
  sessionId: string | null;
  /** ?conv=<uuid>：直接按 UUID 加载会话（绕过 catalogue 查找，用于 evolve-driver 实时查看） */
  convId: string | null;
}

export function getInitialNavigation(searchParams: Pick<URLSearchParams, "get">): InitialNavigation {
  const requestedCwd = searchParams.get("cwd")?.trim() || null;
  const convId = searchParams.get("conv")?.trim() || null;

  return {
    requestedCwd,
    sessionId: requestedCwd ? null : searchParams.get("session"),
    convId: requestedCwd ? null : convId,
  };
}
