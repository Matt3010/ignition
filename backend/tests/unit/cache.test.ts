import { TtlCache } from "../../src/domain/services/cache.js";

describe("TTL cache", () => {
  it("returns cached value before expiry", () => {
    const cache = new TtlCache<string, number>(1000);
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
  });

  it("drops expired values", () => {
    const cache = new TtlCache<string, number>(1);
    cache.set("a", 1);
    cache.clearExpired(Date.now() + 10);
    expect(cache.get("a")).toBeNull();
  });
});
