/// <reference types="node" />
// TP6: every fixture that declares nets in testdata/spice/expected.json goes
// import -> simulate in circuitjs -> same netlist in ngspice -> compare.
//
// Without ngspice the whole file skips instead of failing, so CI stays green on a
// runner that has no spice installed.

import { it, expect } from "vitest";
import { readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { compareImportedNetlist, ngspiceAvailable } from "./spiceImportHarness";

const DIR = join(__dirname, "..", "testdata", "spice");
const manifest: Record<string, { compare?: string[], tolerance?: number, note?: string }> =
    JSON.parse(readFileSync(join(DIR, "expected.json"), "utf8"));
const cases = Object.entries(manifest).filter(([, m]) => m.compare?.length);

it("has fixtures to compare", () => {
    expect(cases.length).toBeGreaterThanOrEqual(8);
});

it.skipIf(!ngspiceAvailable()).each(cases)("%s matches ngspice", async (file, m) => {
    const out = join(tmpdir(), "spice-fixture-" + file.replace(/\W+/g, "-"));
    const { all, failures } = await compareImportedNetlist(
        readFileSync(join(DIR, file), "utf8"), m.compare!, { out, tolerance: m.tolerance });
    // the tolerance and the reason for it stay visible in the output
    console.log(`${file}` + (m.tolerance ? ` (tolerance ${m.tolerance})` : "") +
                (m.note ? `\n  note: ${m.note}` : "") + `\n  ` + all.join("\n  "));
    expect(failures, `${file}\n  ` + all.join("\n  ")).toEqual([]);
});
