import { describe, expect, it } from "vitest";
import { formatDeploymentTime, parseDeploymentMetadata } from "../src/deployment-meta";

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

  it("uses a safe fallback for missing or invalid timestamps", () => {
    expect(formatDeploymentTime(null)).toBe("배포 시각 확인 불가");
    expect(formatDeploymentTime("not-a-date")).toBe("배포 시각 확인 불가");
  });
});
