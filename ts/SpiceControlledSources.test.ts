import { describe, it, expect } from "vitest";
import { buildSpiceParts, parseSpiceNetlist, SpiceParseError } from "./ImportFromSpice";
import { ExprEngine } from "./ExprEngine";

// TP4: controlled sources (E/G/F/H), POLY() and behavioural B sources.
// Written before the code.

const CONTROLLED = ["VCVSElm", "VCCSElm", "CCVSElm", "CCCSElm"];

const partsOf = (body: string) => buildSpiceParts(parseSpiceNetlist(`.subckt t in ref out\n${body}\n.ends\n`));

const errorOf = (body: string): SpiceParseError => {
    try {
        partsOf(body);
    } catch (e) {
        return e as SpiceParseError;
    }
    throw new Error("expected the import to fail");
};

describe("linear E and G", () => {
    it("builds a VCVS with the control nodes first", () => {
        const [part] = partsOf("e1 out 0 in 0 10");
        expect(part.className).toBe("VCVSElm");
        // in+, in-, out+, out-
        expect(part.nodes).toEqual([1, 0, 3, 0]);
        expect(part.dump).toBe("0 2 10*(a-b)");
    });

    it("builds a VCCS with the output nodes swapped", () => {
        const [part] = partsOf("g1 out 0 in 0 1m");
        expect(part.className).toBe("VCCSElm");
        // a current source flows the other way, so out- comes first
        expect(part.nodes).toEqual([1, 0, 0, 3]);
        expect(part.dump).toBe("0 2 0.001*(a-b)");
    });
});

describe("current-controlled F and H", () => {
    it("resolves the sensing source and builds a CCVS", () => {
        const part = partsOf("v1 in 0 0\nh1 out 0 v1 10").at(-1)!;
        expect(part.className).toBe("CCVSElm");
        expect(part.nodes).toEqual([1, 0, 3, 0]);
        expect(part.dump).toBe("2 2 10*a");
    });

    it("builds a CCCS with the output nodes swapped", () => {
        const part = partsOf("v1 in 0 0\nf1 out 0 v1 2").at(-1)!;
        expect(part.className).toBe("CCCSElm");
        expect(part.nodes).toEqual([1, 0, 0, 3]);
        expect(part.dump).toBe("2 2 2*a");
    });

    it("says so when the sensing source does not exist", () => {
        expect(errorOf("h1 out 0 v9 10").message).toBe('line 2: no voltage source named "v9"');
    });
});

describe("POLY", () => {
    it("turns POLY(1) into a linear expression", () => {
        const [part] = partsOf("e1 out 0 poly(1) in 0 0 2");
        expect(part.className).toBe("VCVSElm");
        expect(part.dump).toBe("0 2 2*(a-b)");
    });

    it("turns POLY(2) into linear plus quadratic terms", () => {
        const [part] = partsOf("e1 out 0 poly(2) in 0 ref 0 0 1 0 0 0.5 0");
        // the two control pairs first, then out+, out-
        expect(part.nodes).toEqual([1, 0, 2, 0, 3, 0]);
        // c0=0, c1*x1, c2*x2, c3*x1^2, c4*x1*x2, c5*x2^2
        expect(part.dump).toBe("0 4 1*(a-b)+0.5*(a-b)*(c-d)");
    });

    it("keeps a constant term", () => {
        const [part] = partsOf("g1 out 0 poly(1) in 0 0.5 2");
        expect(part.dump).toBe("0 2 0.5+2*(a-b)");
    });

    it("refuses an order it cannot express", () => {
        expect(errorOf("e1 out 0 poly(3) in 0 ref 0 out 0 0 1 0 0 0 0 0 0")
            .message).toBe("line 2: POLY(3) is not supported yet");
    });
});

describe("B sources and VALUE=", () => {
    it("imports a current B source, braces and all", () => {
        const [part] = partsOf("b1 out 0 i={v(in)*2}");
        expect(part.className).toBe("VCCSElm");
        // one control pin, then out-, out+
        expect(part.nodes).toEqual([1, 0, 3]);
        expect(part.dump).toBe("0 1 a*2");
    });

    it("imports a voltage B source", () => {
        const [part] = partsOf("b1 out 0 v={v(in)*2}");
        expect(part.className).toBe("VCVSElm");
        expect(part.nodes).toEqual([1, 3, 0]);
        expect(part.dump).toBe("0 1 a*2");
    });

    it("maps V(a,b) to a difference and keeps the other operands", () => {
        const [part] = partsOf("b1 out 0 i={v(in,ref)*3+1}");
        expect(part.nodes).toEqual([1, 2, 0, 3]);
        expect(part.dump).toBe("0 2 (a-b)*3+1");
    });

    it("imports an E source with VALUE=", () => {
        const [part] = partsOf("e1 out 0 value={v(in)*v(ref)}");
        expect(part.className).toBe("VCVSElm");
        expect(part.nodes).toEqual([1, 2, 3, 0]);
        expect(part.dump).toBe("0 2 a*b");
    });

    it("says which source type it does not know", () => {
        expect(errorOf("b1 out 0 q={v(in)}").message).toBe('line 2: B source with "q=" is not supported yet');
    });
});

describe("expressions reach the ExprEngine", () => {
    const engine = () => new ExprEngine({} as any);
    const body = [
        "e1 out 0 in 0 10",
        "g2 out 0 in 0 1m",
        "v1 in 0 0",
        "h1 out 0 v1 10",
        "f1 out 0 v1 2",
        "e2 out 0 poly(2) in 0 ref 0 0 1 0 0 0.5 0",
        "b1 out 0 i={v(in,ref)*3+1}",
        "b2 out 0 v={pwr(v(in),2)-pwrs(v(ref),2)}",
        "e3 out 0 value={v(in)*v(ref)}",
    ].join("\n");

    it("accepts every generated expression", () => {
        const parts = buildSpiceParts(parseSpiceNetlist(`.subckt t in ref out\n${body}\n.ends\n`))
            .filter(p => CONTROLLED.includes(p.className));
        expect(parts.length).toBe(8);
        for (const part of parts) {
            // the dump is "<flags> <inputCount> <expression>"
            const expr = part.dump.split(" ").slice(2).join(" ");
            expect(engine().parse(expr), `${part.className}: ${expr}`).toBeNull();
        }
    });

    it("counts the expression inputs the element will get", () => {
        const parts = buildSpiceParts(parseSpiceNetlist(`.subckt t in ref out\n${body}\n.ends\n`))
            .filter(p => CONTROLLED.includes(p.className));
        for (const part of parts) {
            const inputCount = Number(part.dump.split(" ")[1]);
            expect(part.nodes.length - 2, part.className).toBe(inputCount);
        }
    });
});
