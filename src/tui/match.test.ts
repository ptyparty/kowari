import { describe, expect, test } from "bun:test";
import { findIn, findLastIn, fuzzyFilter, fuzzyScore } from "./match.ts";

describe("fuzzy matching", () => {
  test("matches letters in order, ignoring case", () => {
    expect(fuzzyScore("shp", "public.Shipment")).not.toBeNull();
    expect(fuzzyScore("phs", "public.shipment")).toBeNull();
  });

  test("ranks a run of letters at a word start first", () => {
    expect(fuzzyFilter("ship", ["public.leg_shipment", "public.shipment", "audit.s_h_i_p"], (t) => t)).toEqual(["public.shipment", "public.leg_shipment", "audit.s_h_i_p"]);
  });

  test("keeps every item, in order, for an empty query", () => {
    expect(fuzzyFilter("", ["b", "a"], (t) => t)).toEqual(["b", "a"]);
  });
});

describe("finding text", () => {
  test("ignores case unless the query has a capital", () => {
    expect(findIn("Select Booked", "booked")).toBe(7);
    expect(findIn("Select booked", "Booked")).toBe(-1);
    expect(findIn("abc abc", "abc", 1)).toBe(4);
  });

  test("finds the last match before a position", () => {
    expect(findLastIn("abc abc abc", "abc", 8)).toBe(4);
    expect(findLastIn("abc abc abc", "abc", 0)).toBe(-1);
  });
});
