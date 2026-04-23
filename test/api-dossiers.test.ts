import { describe, expect, it } from "vitest";
import { registerApiTriggers } from "../src/triggers/api.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("api dossiers", () => {
  it("returns a readable dossier refresh error when the backend throws a plain object", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never);
    sdk.registerFunction("mem::dossier-refresh", async () => {
      throw { detail: "legacy dossier row is malformed" };
    });

    const result = (await sdk.trigger("api::dossier-refresh", {
      body: {
        project: "/project",
        filePath: "src/functions/context.ts",
      },
      headers: {},
    })) as {
      status_code: number;
      body: { success: boolean; error: string };
    };

    expect(result.status_code).toBe(500);
    expect(result.body.success).toBe(false);
    expect(result.body.error).toBe("legacy dossier row is malformed");
  });
});
