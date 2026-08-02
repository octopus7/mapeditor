export interface DeploymentMetadata {
  deployedAt: string | null;
}

export function parseDeploymentMetadata(value: unknown): DeploymentMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { deployedAt: null };
  }
  const deployedAt = (value as Record<string, unknown>).deployedAt;
  return { deployedAt: typeof deployedAt === "string" ? deployedAt : null };
}

export function formatDeploymentTime(
  value: unknown,
  locale?: string,
  timeZone?: string,
): string {
  if (typeof value !== "string") return "배포 시각 확인 불가";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "배포 시각 확인 불가";
  try {
    const formatted = new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
      ...(timeZone ? { timeZone } : {}),
    }).format(date);
    return `배포 ${formatted}`;
  } catch {
    return "배포 시각 확인 불가";
  }
}

export function formatDeploymentRelativeTime(value: unknown, now = new Date()): string {
  if (typeof value !== "string") return "배포 시각 확인 불가";
  const deployedAt = new Date(value);
  if (Number.isNaN(deployedAt.getTime())) return "배포 시각 확인 불가";
  const elapsedMinutes = Math.max(0, Math.floor((now.getTime() - deployedAt.getTime()) / 60_000));
  if (elapsedMinutes < 1) return "방금 전";
  if (elapsedMinutes < 60) return `${elapsedMinutes}분 전`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}시간 전`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays}일 전`;
}
