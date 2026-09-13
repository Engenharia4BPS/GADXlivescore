import assert from "node:assert/strict";
import test from "node:test";
import {
  parseContestRunCategoriesResponse,
  parseContestRunDiscoveryResponse,
  parseContestRunDisplayScoreResponse,
} from "../src/index.js";

test("displayscore DTO redacts auth recursively while preserving source evidence", () => {
  const response = parseContestRunDisplayScoreResponse(
    JSON.stringify([
      {
        sign: "DM7EE",
        date: "2026-09-11 20:35:30",
        score: 36594,
        qtotal: 342,
        ptotal: 12345,
        mtotal: 107,
        soft: "4",
        qtotalc: 7,
        qtotalp: 8,
        qtotalr: 9,
        auth: "top-level-secret",
        nested: {
          AUTH: "nested-secret",
          retained: true,
          array: [{ auth: "array-secret", retained: "yes" }],
        },
      },
      { sign: "PA6Y", soft: 4 },
    ]),
  );

  const first = response.records[0];
  const second = response.records[1];
  assert(first);
  assert(second);
  assert.equal(first.date, "2026-09-11 20:35:30");
  assert.equal(first.soft, "4");
  assert.equal(second.soft, 4);
  assert.equal(first.qtotalc, 7);
  assert.deepEqual(first.nested, {
    retained: true,
    array: [{ retained: "yes" }],
  });
  assert.equal("sourceTimestamp" in first, false);
  assert.equal("sourceTimestampQuality" in first, false);
  assert.doesNotMatch(JSON.stringify(response), /auth|secret/i);
});

test("displayscore keeps malformed row positions for downstream row rejection", () => {
  const response = parseContestRunDisplayScoreResponse(
    JSON.stringify([{ sign: "DM7EE" }, null, "not-an-object"]),
  );
  assert.equal(response.records.length, 3);
  assert.deepEqual(response.records[1], {});
  assert.deepEqual(response.records[2], {});
  assert.throws(
    () => parseContestRunDisplayScoreResponse('{"not":"an array"}'),
    /must be a JSON array/,
  );
});

test("discovery and category DTOs preserve raw source identifiers and codes", () => {
  const discovery = parseContestRunDiscoveryResponse(
    JSON.stringify([
      {
        testid: 108,
        dat: 902,
        startday: 6,
        starttime: "1200",
        source_marker: "retain",
      },
      { testid: 0 },
    ]),
  );
  assert.deepEqual(discovery.records, [
    {
      testid: 108,
      dat: 902,
      startday: 6,
      starttime: "1200",
      source_marker: "retain",
    },
  ]);

  const categories = parseContestRunCategoriesResponse(
    JSON.stringify([
      {
        testid: 108,
        catid: 5,
        ctband: 4,
        "ct-band": "20m",
        source_code: "retain",
      },
    ]),
  );
  assert.deepEqual(categories.records[0], {
    testid: 108,
    catid: 5,
    ctband: 4,
    "ct-band": "20m",
    source_code: "retain",
  });
});
