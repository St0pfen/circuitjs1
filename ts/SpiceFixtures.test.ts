import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { importSpiceModel } from "./ImportFromSpiceModel";
import { SpiceParseError } from "./ImportFromSpice";
import { makeApp } from "./scripts/simHarness";

// TP6: the netlists in testdata/spice are the contract.  Every file there either
// imports or fails with the error declared next to it in expected.json, so a
// change that silently breaks a real circuit cannot pass.

const DIR = join(__dirname, "testdata", "spice");
const manifest: Record<string, { name?: string, pins?: string[], compare?: string[], error?: string }> =
    JSON.parse(readFileSync(join(DIR, "expected.json"), "utf8"));
const files = readdirSync(DIR).filter(f => f.endsWith(".cir")).sort();

beforeAll(async () => {
    await makeApp();
});

describe("the fixture folder", () => {
    it("holds ten to fifteen netlists", () => {
        expect(files.length).toBeGreaterThanOrEqual(10);
        expect(files.length).toBeLessThanOrEqual(15);
    });

    it("has an entry for every file and no entry for a file that is gone", () => {
        expect(files.filter(f => !(f in manifest))).toEqual([]);
        expect(Object.keys(manifest).filter(f => !files.includes(f))).toEqual([]);
    });
});

describe.each(files)("%s", (file) => {
    const expected = manifest[file];
    const text = readFileSync(join(DIR, file), "utf8");

    it("is covered by the manifest", () => {
        expect(expected, `${file} has no entry in expected.json`).toBeDefined();
    });

    if (expected?.error) {
        it("fails with the declared error", () => {
            let err: unknown;
            try {
                importSpiceModel(text);
            } catch (e) {
                err = e;
            }
            // (vitest's string matchers do not survive the headless DOM, see the
            // note in ImportFromSpiceDialog.test.ts)
            expect(err instanceof SpiceParseError, `${file} was expected to fail, got ${err}`).toBe(true);
            const message = (err as SpiceParseError).message;
            expect(message.includes(expected.error!), `${file}: ${message}`).toBe(true);
        });
    } else {
        it("imports as the declared subcircuit", () => {
            const model = importSpiceModel(text);
            expect(model.name).toBe(expected.name);
            expect(model.extList.map((e: any) => e.name)).toEqual(expected.pins);
        });
    }
});

describe("the comparison fixtures", () => {
    it("name the nets they compare, and there are enough of them", () => {
        const compared = Object.entries(manifest).filter(([, m]) => m.compare?.length);
        expect(compared.length).toBeGreaterThanOrEqual(8);
        for (const [file, m] of compared) {
            const text = readFileSync(join(DIR, file), "utf8");
            const model = importSpiceModel(text);
            const pins = model.extList.map((e: any) => e.name);
            for (const net of m.compare!)
                expect(pins.includes(net), `${file} compares ${net}, which is not a pin`).toBe(true);
        }
    });
});
