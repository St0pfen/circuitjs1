import { describe, it, expect, beforeAll } from "vitest";
import { importSpiceModel, SPICE_IMPORT_HELP } from "./ImportFromSpiceModel";
import { SpiceParseError } from "./ImportFromSpice";
import { DiodeModel } from "./DiodeModel";
import { makeApp } from "./scripts/simHarness";
import { SubcircuitElm } from "./SubcircuitElm";

// TP5: the hand-off from the dialog to a SubcircuitModel, and the strings the
// dialog shows.  Written before the code.

const NETLIST = `
* a divider as a subcircuit
.subckt divider in out
r1 in out 1k
r2 out 0 2k
.ends
`;

beforeAll(async () => {
    // building a SubcircuitModel goes through the element classes and the DOM
    await makeApp();
});

describe("importSpiceModel", () => {
    it("builds a subcircuit model named after the .subckt", () => {
        const model = importSpiceModel(NETLIST);
        expect(model.name).toBe("divider");
        expect(model.extList.map((e: any) => e.name)).toEqual(["in", "out"]);
        expect(model.extList.map((e: any) => e.node)).toEqual([1, 2]);
        const tags = Array.from(model.elmDoc!.documentElement.children).map((c: any) => c.tagName);
        expect(tags).toEqual(["r", "r"]);
    });

    it("carries the element values into the model", () => {
        const model = importSpiceModel(NETLIST);
        const [r1, r2] = Array.from(model.elmDoc!.documentElement.children) as any[];
        expect(r1.getAttribute("r")).toBe("1000");
        expect(r2.getAttribute("r")).toBe("2000");
    });

    it("lays the pins out on both sides so they do not overlap", () => {
        const model = importSpiceModel(`.subckt t a b c\nr1 a b 1k\nr2 b c 1k\n.ends\n`);
        // west, east, west — ChipElm.SIDE_W = 2, SIDE_E = 3
        expect(model.extList.map((e: any) => [e.side, e.pos])).toEqual([[2, 0], [3, 0], [2, 1]]);
    });

    it("yields a subcircuit an instance can be made from", () => {
        const model = importSpiceModel(NETLIST);
        const elm: any = new SubcircuitElm(0, 0, model.name);
        expect(elm.getPostCount()).toBe(2);
        expect(elm.compElmList.map((c: any) => c.getClassName()))
            .toEqual(["ResistorElm", "ResistorElm"]);
    });

    it("takes a name of its own", () => {
        expect(importSpiceModel(NETLIST, "mein-teiler").name).toBe("mein-teiler");
    });

    it("registers the models the netlist uses", () => {
        importSpiceModel(`
.subckt clamp a k
.model dm d (is=1e-14 n=1.7)
d1 a k dm
.ends
`);
        expect(DiodeModel.registry.get("clamp-dm")!.emissionCoefficient).toBe(1.7);
    });

    it("reports a broken netlist with its line and leaves no model behind", () => {
        let err: unknown;
        try {
            importSpiceModel(".subckt broken a\n.model dm d (is=1e-14)\nd1 a\n.ends\n");
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(SpiceParseError);
        expect((err as SpiceParseError).line).toBe(3);
        expect(DiodeModel.registry.get("broken-dm")).toBeUndefined();
    });
});
