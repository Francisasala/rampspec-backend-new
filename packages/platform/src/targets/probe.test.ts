import { describe, expect, it, vi } from "vitest";
import {
  PROBE_MAX_HEADER_VALUE_BYTES,
  PROBE_MAX_RESPONSE_BYTES,
  PROBE_MAX_SUPPORTED_SEPS,
  PROBE_MAX_TOTAL_HEADER_BYTES,
  probeTarget,
} from "./probe.js";

const clock = () => new Date("2026-09-12T18:00:00.000Z");
const SENTINEL = "PROBE-SENTINEL-DO-NOT-LEAK-7f3a9";

/** A stream of `count` chunks of `size` bytes; tracks how many were pulled. */
function chunkStream(
  count: number,
  size: number,
  fill = "a",
): { body: ReadableStream<Uint8Array>; pulled: () => number } {
  let pulled = 0;
  const chunk = new TextEncoder().encode(fill.repeat(size));
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      if (pulled <= count) {
        controller.enqueue(chunk);
      } else {
        controller.close();
      }
    },
  });
  return { body, pulled: () => pulled };
}

describe("target capability probe", () => {
  it("captures bounded protocol headers", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: {
          "x-stellar-toml-version": "SEP-0001, SEP-0012",
          server: "hidden",
        },
      }),
    );
    const result = await probeTarget("https://example.com", { fetcher, clock });
    expect(result.reachable).toBe(true);
    expect(result.supportedSeps).toEqual(["SEP-0001", "SEP-0012"]);
    expect(result.headers).not.toHaveProperty("server");
    expect(result.budgetExceeded).toBe(false);
    expect(result.limitReason).toBeNull();
  });

  it("fails closed for unsafe and unreachable targets", async () => {
    const fetcher = vi.fn();
    await expect(
      probeTarget("http://example.com", { fetcher }),
    ).rejects.toThrow("HTTPS");
    expect(fetcher).not.toHaveBeenCalled();
    const result = await probeTarget("https://example.com", {
      fetcher: vi.fn().mockRejectedValue(new Error("timeout")),
    });
    expect(result.reachable).toBe(false);
    expect(result.status).toBeNull();
    expect(result.budgetExceeded).toBe(false);
    expect(result.limitReason).toBeNull();
  });

  it("drains a small response body and stays reachable", async () => {
    const { body } = chunkStream(2, 16);
    const fetcher = vi.fn().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { "x-stellar-toml-version": "SEP-0001" },
      }),
    );
    const result = await probeTarget("https://example.com", { fetcher, clock });
    expect(result.reachable).toBe(true);
    expect(result.status).toBe(200);
    expect(result.supportedSeps).toEqual(["SEP-0001"]);
    expect(result.budgetExceeded).toBe(false);
  });

  it("accepts a body exactly at the response budget", async () => {
    const { body } = chunkStream(4, PROBE_MAX_RESPONSE_BYTES / 4);
    const fetcher = vi.fn().mockResolvedValue(
      new Response(body, { status: 200 }),
    );
    const result = await probeTarget("https://example.com", { fetcher, clock });
    expect(result.reachable).toBe(true);
    expect(result.budgetExceeded).toBe(false);
  });

  it("accepts a declared content length exactly at the budget", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: { "content-length": String(PROBE_MAX_RESPONSE_BYTES) },
      }),
    );
    const result = await probeTarget("https://example.com", { fetcher, clock });
    expect(result.reachable).toBe(true);
    expect(result.budgetExceeded).toBe(false);
  });

  it("accepts a header value exactly at the per-value budget", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: {
          "x-stellar-toml-version": "x".repeat(PROBE_MAX_HEADER_VALUE_BYTES),
        },
      }),
    );
    const result = await probeTarget("https://example.com", { fetcher, clock });
    expect(result.reachable).toBe(true);
    expect(result.budgetExceeded).toBe(false);
  });

  it("caps retained SEP identifiers at the configured maximum", async () => {
    const seps = Array.from(
      { length: PROBE_MAX_SUPPORTED_SEPS + 8 },
      (_, index) => `SEP-${String(index + 1).padStart(4, "0")}`,
    ).join(", ");
    const fetcher = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: { "x-stellar-toml-version": seps },
      }),
    );
    const result = await probeTarget("https://example.com", { fetcher, clock });
    expect(result.supportedSeps).toHaveLength(PROBE_MAX_SUPPORTED_SEPS);
    expect(result.supportedSeps[0]).toBe("SEP-0001");
    expect(result.budgetExceeded).toBe(false);
  });

  it("aborts a body over the response budget and discards it", async () => {
    const { body, pulled } = chunkStream(10, 10_240, SENTINEL.slice(0, 8));
    const fetcher = vi.fn().mockResolvedValue(
      new Response(body, { status: 200 }),
    );
    const result = await probeTarget("https://example.com", { fetcher, clock });
    expect(result.reachable).toBe(false);
    expect(result.status).toBe(200);
    expect(result.headers).toEqual({});
    expect(result.supportedSeps).toEqual([]);
    expect(result.budgetExceeded).toBe(true);
    expect(result.limitReason).toBe("response-budget-exceeded");
    expect(JSON.stringify(result)).not.toContain(SENTINEL.slice(0, 8));
    // The stream was abandoned mid-response instead of fully consumed.
    expect(pulled()).toBeLessThan(10);
  });

  it("refuses an over-budget declared content length without reading the body", async () => {
    const getReader = vi.fn();
    const cancel = vi.fn(() => Promise.resolve());
    const fakeResponse = {
      body: { cancel, getReader },
      headers: new Headers({
        "content-length": String(PROBE_MAX_RESPONSE_BYTES + 1),
      }),
      ok: true,
      status: 200,
    };
    const fetcher = vi.fn().mockResolvedValue(fakeResponse);
    const result = await probeTarget("https://example.com", { fetcher, clock });
    expect(result.reachable).toBe(false);
    expect(result.status).toBe(200);
    expect(result.budgetExceeded).toBe(true);
    expect(result.limitReason).toBe("content-length-budget-exceeded");
    expect(getReader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
  });

  it("aborts an oversized retained header value and discards it", async () => {
    const oversized = `${SENTINEL}-${"x".repeat(PROBE_MAX_HEADER_VALUE_BYTES)}`;
    const fetcher = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: { "x-stellar-toml-version": oversized },
      }),
    );
    const result = await probeTarget("https://example.com", { fetcher, clock });
    expect(result.reachable).toBe(false);
    expect(result.headers).toEqual({});
    expect(result.supportedSeps).toEqual([]);
    expect(result.budgetExceeded).toBe(true);
    expect(result.limitReason).toBe("header-budget-exceeded");
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("aborts when retained headers exceed their combined budget", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: {
          "content-type": "a".repeat(5000),
          "x-stellar-toml-version": "b".repeat(5000),
        },
      }),
    );
    const result = await probeTarget("https://example.com", {
      fetcher,
      clock,
      maxHeaderValueBytes: 6000,
      maxKeptHeaderBytes: 8000,
    });
    expect(result.reachable).toBe(false);
    expect(result.budgetExceeded).toBe(true);
    expect(result.limitReason).toBe("header-budget-exceeded");
  });

  it("aborts when dropped headers flood the total header budget", async () => {
    const headers: Record<string, string> = {};
    for (let index = 0; index < 100; index += 1) {
      headers[`x-junk-${index}`] = "x".repeat(1000);
    }
    const fetcher = vi.fn().mockResolvedValue(
      new Response(null, { status: 200, headers }),
    );
    const result = await probeTarget("https://example.com", { fetcher, clock });
    expect(result.reachable).toBe(false);
    expect(result.budgetExceeded).toBe(true);
    expect(result.limitReason).toBe("header-budget-exceeded");
    expect(JSON.stringify(result)).not.toContain("x-junk-");
  });

  it("enforces the total header budget at its boundary", async () => {
    const headers = { "x-junk-a": "x".repeat(60), "x-junk-b": "y".repeat(60) };
    const within = await probeTarget("https://example.com", {
      fetcher: vi.fn().mockResolvedValue(
        new Response(null, { status: 200, headers }),
      ),
      clock,
      maxTotalHeaderBytes: 140,
    });
    expect(within.reachable).toBe(true);
    expect(within.budgetExceeded).toBe(false);
    const over = await probeTarget("https://example.com", {
      fetcher: vi.fn().mockResolvedValue(
        new Response(null, { status: 200, headers }),
      ),
      clock,
      maxTotalHeaderBytes: 100,
    });
    expect(over.reachable).toBe(false);
    expect(over.limitReason).toBe("header-budget-exceeded");
    expect(PROBE_MAX_TOTAL_HEADER_BYTES).toBe(65_536);
  });

  it("honours caller-supplied response budgets", async () => {
    const { body } = chunkStream(2, 16);
    const fetcher = vi.fn().mockResolvedValue(
      new Response(body, { status: 200 }),
    );
    const result = await probeTarget("https://example.com", {
      fetcher,
      clock,
      maxResponseBytes: 10,
    });
    expect(result.reachable).toBe(false);
    expect(result.limitReason).toBe("response-budget-exceeded");
  });

  it("rejects non-positive budgets instead of probing unbounded", async () => {
    await expect(
      probeTarget("https://example.com", { maxResponseBytes: 0 }),
    ).rejects.toThrow("positive");
    await expect(
      probeTarget("https://example.com", { maxHeaderValueBytes: -1 }),
    ).rejects.toThrow("positive");
  });

  it("fails closed with no content when the body stream errors", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        controller.error(new Error("connection reset"));
      },
    });
    const fetcher = vi.fn().mockResolvedValue(
      new Response(body, { status: 200 }),
    );
    const result = await probeTarget("https://example.com", { fetcher, clock });
    expect(result.reachable).toBe(false);
    expect(result.status).toBe(200);
    expect(result.headers).toEqual({});
    expect(result.supportedSeps).toEqual([]);
    expect(result.budgetExceeded).toBe(false);
    expect(result.limitReason).toBeNull();
  });

  it("never exposes oversized partial content in the probe result", async () => {
    const { body } = chunkStream(10, 10_240, SENTINEL);
    const fetcher = vi.fn().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { "x-stellar-toml-version": "SEP-0001" },
      }),
    );
    const result = await probeTarget("https://example.com", { fetcher, clock });
    expect(result.limitReason).toBe("response-budget-exceeded");
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(JSON.stringify(result)).not.toContain("SEP-0001");
  });
});
