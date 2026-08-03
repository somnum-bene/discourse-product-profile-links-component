import { describe, expect, it, vi } from "vitest";
import type { UserFieldValues } from "../../javascripts/discourse/lib/profile-links";
import { createUserFieldSource } from "../../javascripts/discourse/lib/user-field-source";

const AIRSENSE = { 1: "AirSense 11" };

/** Collapses the backoff, so a test exercising retries does not sleep. */
const noWait = async () => {};

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
    () =>
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

    expect(await first).toEqual({ ok: true, userFields: AIRSENSE });
    expect(await second).toEqual({ ok: true, userFields: AIRSENSE });
  });

  it("does not fetch again once a lookup has succeeded", async () => {
    const fetchUserFields = vi.fn(async () => AIRSENSE);
    const source = createUserFieldSource(fetchUserFields);

    expect(await source.lookup("pinder99")).toEqual({
      ok: true,
      userFields: AIRSENSE,
    });
    expect(await source.lookup("pinder99")).toEqual({
      ok: true,
      userFields: AIRSENSE,
    });

    expect(fetchUserFields).toHaveBeenCalledTimes(1);
  });

  it("fetches each username separately", async () => {
    const fetchUserFields = vi.fn(async (username: string) =>
      username === "pinder99" ? AIRSENSE : null
    );
    const source = createUserFieldSource(fetchUserFields);

    expect(await source.lookup("pinder99")).toEqual({
      ok: true,
      userFields: AIRSENSE,
    });
    expect(await source.lookup("someone-else")).toEqual({
      ok: true,
      userFields: null,
    });

    expect(fetchUserFields).toHaveBeenCalledTimes(2);
  });

  it("caches a user who simply has no Custom User Field values", async () => {
    const fetchUserFields = vi.fn(async () => null);
    const source = createUserFieldSource(fetchUserFields);

    expect(await source.lookup("pinder99")).toEqual({
      ok: true,
      userFields: null,
    });
    expect(await source.lookup("pinder99")).toEqual({
      ok: true,
      userFields: null,
    });

    expect(fetchUserFields).toHaveBeenCalledTimes(1);
  });

  it("reports a failed fetch as a failure rather than rejecting", async () => {
    const fetchUserFields = vi.fn(async () => {
      throw new Error("network");
    });
    const source = createUserFieldSource(fetchUserFields, {
      attempts: 1,
      wait: noWait,
    });

    await expect(source.lookup("pinder99")).resolves.toEqual({ ok: false });
  });

  it("tells a failed lookup apart from a user who holds no values", async () => {
    // Both have nothing to show, but only the failure is worth retrying, and a
    // caller can only leave it retryable if it can see the difference.
    const failing = createUserFieldSource(
      async () => {
        throw new Error("network");
      },
      { attempts: 1, wait: noWait }
    );
    const empty = createUserFieldSource(async () => null);

    expect(await failing.lookup("pinder99")).toEqual({ ok: false });
    expect(await empty.lookup("pinder99")).toEqual({
      ok: true,
      userFields: null,
    });
  });

  it("recovers from a blip within the one lookup, asking nobody to retry", async () => {
    // A post sitting on screen has no reason to re-render, so a lookup that
    // merely left itself retryable would be waiting for something that may
    // never come. Recovery happens here or not at all.
    let attempt = 0;
    const fetchUserFields = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("network");
      }
      return AIRSENSE;
    });
    const source = createUserFieldSource(fetchUserFields, { wait: noWait });

    expect(await source.lookup("pinder99")).toEqual({
      ok: true,
      userFields: AIRSENSE,
    });
    expect(fetchUserFields).toHaveBeenCalledTimes(2);
  });

  it("gives up after its attempts run out rather than trying forever", async () => {
    const fetchUserFields = vi.fn(async () => {
      throw new Error("network");
    });
    const source = createUserFieldSource(fetchUserFields, {
      attempts: 3,
      wait: noWait,
    });

    expect(await source.lookup("pinder99")).toEqual({ ok: false });
    expect(fetchUserFields).toHaveBeenCalledTimes(3);
  });

  it("waits longer before each retry than the one before", async () => {
    const waited: number[] = [];
    const fetchUserFields = vi.fn(async () => {
      throw new Error("network");
    });
    const source = createUserFieldSource(fetchUserFields, {
      attempts: 3,
      wait: async (ms: number) => {
        waited.push(ms);
      },
    });

    await source.lookup("pinder99");

    expect(waited).toHaveLength(2);
    expect(waited[1]).toBeGreaterThan(waited[0]);
  });

  it("does not retry a lookup that succeeded", async () => {
    const fetchUserFields = vi.fn(async () => AIRSENSE);
    const source = createUserFieldSource(fetchUserFields, { wait: noWait });

    await source.lookup("pinder99");

    expect(fetchUserFields).toHaveBeenCalledTimes(1);
  });

  it("still allows a fresh lookup after every attempt failed", async () => {
    let failUntil = 3;
    const fetchUserFields = vi.fn(async () => {
      if (fetchUserFields.mock.calls.length <= failUntil) {
        throw new Error("network");
      }
      return AIRSENSE;
    });
    const source = createUserFieldSource(fetchUserFields, {
      attempts: 3,
      wait: noWait,
    });

    expect(await source.lookup("pinder99")).toEqual({ ok: false });
    failUntil = 3;
    expect(await source.lookup("pinder99")).toEqual({
      ok: true,
      userFields: AIRSENSE,
    });
  });

  it("collapses callers arriving while a lookup is still retrying", async () => {
    // A topic full of posts by one author must not multiply its retries.
    const fetchUserFields = vi.fn(async () => {
      if (fetchUserFields.mock.calls.length === 1) {
        throw new Error("network");
      }
      return AIRSENSE;
    });
    const source = createUserFieldSource(fetchUserFields, { wait: noWait });

    const [first, second] = await Promise.all([
      source.lookup("pinder99"),
      source.lookup("pinder99"),
    ]);

    expect(first).toEqual({ ok: true, userFields: AIRSENSE });
    expect(second).toEqual(first);
    expect(fetchUserFields).toHaveBeenCalledTimes(2);
  });

  it("treats a fetch that throws synchronously as a failure, not a crash", async () => {
    const fetchUserFields = vi.fn(() => {
      throw new Error("misconfigured");
    });
    const source = createUserFieldSource(fetchUserFields, {
      attempts: 1,
      wait: noWait,
    });

    await expect(source.lookup("pinder99")).resolves.toEqual({ ok: false });
  });

  it("shares nothing between sources, so each starts from a known state", async () => {
    const fetchUserFields = vi.fn(async () => AIRSENSE);

    await createUserFieldSource(fetchUserFields).lookup("pinder99");
    await createUserFieldSource(fetchUserFields).lookup("pinder99");

    expect(fetchUserFields).toHaveBeenCalledTimes(2);
  });
});
