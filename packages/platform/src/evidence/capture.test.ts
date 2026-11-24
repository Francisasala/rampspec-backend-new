import { describe, expect, it, vi } from "vitest";
import { captureEvidence, computeSha256 } from "./capture.js";

describe("evidence capture", () => {
  it("hashes and stores immutable content-addressed artifacts", async () => {
    const keys: string[] = [];
    const recorded: string[] = [];
    const artifact = await captureEvidence({
      runId: "run_00000000-0000-4000-8000-000000000001",
      mediaType: "application/json",
      bytes: new TextEncoder().encode("{}"),
      store: {
        put: (key) => {
          keys.push(key);
          return Promise.resolve();
        },
        record: (art) => {
          recorded.push(art.id);
          return Promise.resolve();
        },
      },
    });
    expect(artifact.contentHash).toHaveLength(64);
    expect(keys[0]).toBe(`evidence/${artifact.contentHash}`);
    expect(recorded).toHaveLength(1);
  });

  it("enforces media type and byte limits", async () => {
    const store = {
      put: () => Promise.resolve(),
      record: () => Promise.resolve(),
    };
    await expect(
      captureEvidence({
        runId: "run_00000000-0000-4000-8000-000000000001",
        mediaType: "",
        bytes: new Uint8Array(),
        store,
      }),
    ).rejects.toThrow("media");
    await expect(
      captureEvidence({
        runId: "run_00000000-0000-4000-8000-000000000001",
        mediaType: "text/plain",
        bytes: new Uint8Array(11),
        maxBytes: 10,
        store,
      }),
    ).rejects.toThrow("large");
  });

  it("verifies expected checksum during capture streaming", async () => {
    const store = {
      put: () => Promise.resolve(),
      record: () => Promise.resolve(),
    };
    const bytes = new TextEncoder().encode("valid-content");
    const validChecksum = computeSha256(bytes);

    const artifact = await captureEvidence({
      runId: "run_00000000-0000-4000-8000-000000000001",
      mediaType: "text/plain",
      bytes,
      store,
      expectedChecksum: validChecksum,
    });
    expect(artifact.contentHash).toBe(validChecksum);

    await expect(
      captureEvidence({
        runId: "run_00000000-0000-4000-8000-000000000001",
        mediaType: "text/plain",
        bytes,
        store,
        expectedChecksum:
          "0000000000000000000000000000000000000000000000000000000000000000",
      }),
    ).rejects.toThrow("checksum mismatch");
  });

  it("verifies the stored object before publishing its reference and leaves no active reference on failure", async () => {
    let recorded = false;
    const failingStore = {
      put: () => Promise.resolve(),
      verify: () => Promise.resolve(false),
      record: () => {
        recorded = true;
        return Promise.resolve();
      },
    };

    await expect(
      captureEvidence({
        runId: "run_00000000-0000-4000-8000-000000000001",
        mediaType: "application/json",
        bytes: new TextEncoder().encode('{"test": true}'),
        store: failingStore,
      }),
    ).rejects.toThrow("Stored evidence verification failed");
    expect(recorded).toBe(false);

    // Using get fallback
    const corruptedGetStore = {
      put: () => Promise.resolve(),
      get: () => Promise.resolve(new TextEncoder().encode("corrupted")),
      record: () => {
        recorded = true;
        return Promise.resolve();
      },
    };

    await expect(
      captureEvidence({
        runId: "run_00000000-0000-4000-8000-000000000001",
        mediaType: "application/json",
        bytes: new TextEncoder().encode('{"test": true}'),
        store: corruptedGetStore,
      }),
    ).rejects.toThrow("checksum mismatch");
    expect(recorded).toBe(false);
  });

  it("rejects over-limit evidence before any store interaction", async () => {
    const put = vi.fn(() => Promise.resolve());
    const record = vi.fn(() => Promise.resolve());
    await expect(
      captureEvidence({
        runId: "run_00000000-0000-4000-8000-000000000001",
        mediaType: "text/plain",
        bytes: new Uint8Array(11),
        maxBytes: 10,
        store: { put, record },
      }),
    ).rejects.toThrow("large");
    expect(put).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("accepts evidence exactly at the byte limit", async () => {
    const put = vi.fn(() => Promise.resolve());
    const record = vi.fn(() => Promise.resolve());
    const artifact = await captureEvidence({
      runId: "run_00000000-0000-4000-8000-000000000001",
      mediaType: "text/plain",
      bytes: new Uint8Array(10),
      maxBytes: 10,
      store: { put, record },
    });
    expect(artifact.byteLength).toBe(10);
    expect(put).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
  });
});
