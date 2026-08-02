import { describe, expect, it } from "vitest";
import { formatDeploymentRelativeTime, formatDeploymentTime, parseDeploymentMetadata } from "../src/deployment-meta";

describe("deployment metadata", () => {
  it("accepts a deployment timestamp from the static file", () => {
    expect(parseDeploymentMetadata({ deployedAt: "2026-08-02T00:00:00.000Z" })).toEqual({
      deployedAt: "2026-08-02T00:00:00.000Z",
    });
  });

  it("formats the timestamp in the browser-selected timezone", () => {
    expect(formatDeploymentTime("2026-08-02T00:00:00.000Z", "ko-KR", "Asia/Seoul"))
      .toContain("2026");
  });

  it("formats recent deployments as relative time", () => {
    const now = new Date("2026-08-03T01:00:00.000Z");
    expect(formatDeploymentRelativeTime("2026-08-03T00:55:00.000Z", now)).toBe("5분 전");
    expect(formatDeploymentRelativeTime("2026-08-02T23:00:00.000Z", now)).toBe("2시간 전");
    expect(formatDeploymentRelativeTime("2026-07-31T01:00:00.000Z", now)).toBe("3일 전");
  });

  it("uses a safe fallback for missing or invalid timestamps", () => {
    expect(formatDeploymentTime(null)).toBe("배포 시각 확인 불가");
    expect(formatDeploymentTime("not-a-date")).toBe("배포 시각 확인 불가");
    expect(formatDeploymentRelativeTime(null)).toBe("배포 시각 확인 불가");
  });
});
