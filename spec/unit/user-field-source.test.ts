import { describe, expect, it, vi } from "vitest";
import { createUserFieldSource } from "../../javascripts/discourse/lib/user-field-source";
import type { UserFieldValues } from "../../javascripts/discourse/lib/profile-links";

const AIRSENSE = { 1: "AirSense 11" };

/**
 * A fetch whose resolution the test controls, so an in-flight lookup can be
 * observed before it settles.
 */
function deferredFetch() {
  const settlers: Array<{
    resolve: (fields: UserFieldValues) => void;
    reject: (reason: unknown) => void;
  }> = [];

  const fetchUserFields = vi.fn(
    (_username: string) =>
      new Promise<UserFieldValues>((resolve, reject) => {
        settlers.push({ resolve, reject });
      })
  );

  return { fetchUserFields, settlers };
}

describe("createUserFieldSource", () => {
  it("collapses concurrent lookups for one username into a single fetch", async () => {
    const { fetchUserFields, settlers } = deferredFetch();
    const source = createUserFieldSource(fetchUserFields);

    const first = source.lookup("pinder99");
    const second = source.lookup("pinder99");

    expect(fetchUserFields).toHaveBeenCalledTimes(1);

    settlers[0].resolve(AIRSENSE);

    expect(await first).toEqual(AIRSENSE);
    expect(await second).toEqual(AIRSENSE);
  });

  it("does not fetch again once a lookup has succeeded", async () => {
    const fetchUserFields = vi.fn(async () => AIRSENSE);
    const source = createUserFieldSource(fetchUserFields);

    expect(await source.lookup("pinder99")).toEqual(AIRSENSE);
    expect(await source.lookup("pinder99")).toEqual(AIRSENSE);

    expect(fetchUserFields).toHaveBeenCalledTimes(1);
  });

  it("fetches each username separately", async () => {
    const fetchUserFields = vi.fn(async (username: string) =>
      username === "pinder99" ? AIRSENSE : null
    );
    const source = createUserFieldSource(fetchUserFields);

    expect(await source.lookup("pinder99")).toEqual(AIRSENSE);
    expect(await source.lookup("someone-else")).toBeNull();

    expect(fetchUserFields).toHaveBeenCalledTimes(2);
  });

  it("caches a user who simply has no Custom User Field values", async () => {
    const fetchUserFields = vi.fn(async () => null);
    const source = createUserFieldSource(fetchUserFields);

    expect(await source.lookup("pinder99")).toBeNull();
    expect(await source.lookup("pinder99")).toBeNull();

    expect(fetchUserFields).toHaveBeenCalledTimes(1);
  });

  it("resolves a failed fetch to no field values rather than rejecting", async () => {
    const fetchUserFields = vi.fn(async () => {
      throw new Error("network");
    });
    const source = createUserFieldSource(fetchUserFields);

    await expect(source.lookup("pinder99")).resolves.toBeNull();
  });

  it("retries after a failure, so a blip does not outlast itself", async () => {
    let attempt = 0;
    const fetchUserFields = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("network");
      }
      return AIRSENSE;
    });
    const source = createUserFieldSource(fetchUserFields);

    expect(await source.lookup("pinder99")).toBeNull();
    expect(await source.lookup("pinder99")).toEqual(AIRSENSE);

    expect(fetchUserFields).toHaveBeenCalledTimes(2);
  });

  it("treats a fetch that throws synchronously as a failure, not a crash", async () => {
    const fetchUserFields = vi.fn(() => {
      throw new Error("misconfigured");
    });
    const source = createUserFieldSource(fetchUserFields);

    await expect(source.lookup("pinder99")).resolves.toBeNull();
  });

  it("shares nothing between sources, so each starts from a known state", async () => {
    const fetchUserFields = vi.fn(async () => AIRSENSE);

    await createUserFieldSource(fetchUserFields).lookup("pinder99");
    await createUserFieldSource(fetchUserFields).lookup("pinder99");

    expect(fetchUserFields).toHaveBeenCalledTimes(2);
  });
});
