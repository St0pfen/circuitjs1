import { describe, it, expect, beforeAll } from "vitest";
import { buildSpiceModels, buildSpiceParts, parseSpiceNetlist, registerSpiceModels } from "./ImportFromSpice";
import { DiodeModel } from "./DiodeModel";
import { TransistorModel } from "./TransistorModel";

// TP3: diodes, BJTs and JFETs, and the .model parameters that make a datasheet
// model usable.  The tests are written before the code on purpose.

const DIODE = `
.subckt dclamp a k
.model dmod d (is=2.52n rs=0.568 n=1.752 bv=100)
d1 a k dmod
.ends
`;

const BJT = `
.subckt amp c b e
.model qn npn (bf=200 is=1e-14 br=2 ne=1.5 nc=2 nf=1 nr=1 vaf=100 var=50 ikf=0.1 ikr=0.05 ise=1e-13 isc=1e-13)
q1 c b e qn
.ends
`;

describe("buildSpiceModels", () => {
    it("maps a diode model card onto DiodeModel's fields", () => {
        const specs = buildSpiceModels(parseSpiceNetlist(DIODE));
        expect(specs).toEqual([{
            kind: "diode",
            name: "dclamp-dmod",
            params: {
                saturationCurrent: 2.52e-9,
                seriesResistance: 0.568,
                emissionCoefficient: 1.752,
                breakdownVoltage: 100,
            },
        }]);
    });

    it("maps every BJT parameter, including the reciprocal ones", () => {
        const [spec] = buildSpiceModels(parseSpiceNetlist(BJT));
        expect(spec.kind).toBe("transistor");
        expect(spec.name).toBe("amp-qn");
        expect(spec.params).toEqual({
            satCur: 1e-14,
            betaR: 2,
            leakBEemissionCoeff: 1.5,
            leakBCemissionCoeff: 2,
            emissionCoeffF: 1,
            emissionCoeffR: 1,
            invEarlyVoltF: 1 / 100,
            invEarlyVoltR: 1 / 50,
            invRollOffF: 1 / 0.1,
            invRollOffR: 1 / 0.05,
            BEleakCur: 1e-13,
            BCleakCur: 1e-13,
        });
        expect(spec.polarity).toBe(1);
        // forward beta belongs to the element, not the model
        expect(spec.beta).toBe(200);
    });

    it("marks a pnp model as such and keeps the Java defaults", () => {
        const [spec] = buildSpiceModels(parseSpiceNetlist(`
.subckt t c b e
.model qp pnp (bf=50)
q1 c b e qp
.ends
`));
        expect(spec.polarity).toBe(-1);
        expect(spec.beta).toBe(50);
        expect(spec.params.satCur).toBe(1e-16);   // Java's default when the card has no is=
    });

    it("scales a model variant for area=", () => {
        const specs = buildSpiceModels(parseSpiceNetlist(`
.subckt t c b e
.model qn npn (bf=100 is=1e-14 ikf=1 ise=2e-13 isc=4e-13)
q1 c b e qn area=2
.ends
`));
        const variant = specs.find(s => s.name === "t-qn-A2")!;
        expect(variant).toBeDefined();
        expect(variant.params.satCur).toBeCloseTo(2e-14, 20);
        expect(variant.params.invRollOffF).toBeCloseTo(0.5, 12);
        expect(variant.params.BEleakCur).toBeCloseTo(4e-13, 20);
        expect(variant.params.BCleakCur).toBeCloseTo(8e-13, 20);
        expect(variant.beta).toBe(100);   // beta is not scaled by area
    });

    it("makes no model for a card nothing uses", () => {
        const specs = buildSpiceModels(parseSpiceNetlist(`
.subckt t a b
.model unused d (is=1e-14)
r1 a b 1k
.ends
`));
        expect(specs).toEqual([]);
    });
});

describe("semiconductor elements", () => {
    it("wires a diode to its model", () => {
        const nl = parseSpiceNetlist(DIODE);
        const [part] = buildSpiceParts(nl);
        expect(part.className).toBe("DiodeElm");
        expect(part.nodes).toEqual([1, 2]);
        expect(part.dump).toBe("2 dclamp-dmod");
    });

    it("puts the transistor in base-collector-emitter order", () => {
        const nl = parseSpiceNetlist(BJT);
        const [part] = buildSpiceParts(nl);
        expect(part.className).toBe("TransistorElm");
        // SPICE writes c b e, CircuitJS wants b c e
        expect(part.nodes).toEqual([2, 1, 3]);
        expect(part.dump).toBe("0 1 0 0 200 amp-qn");
    });

    it("uses the area variant and adds the bulk resistors and junction caps", () => {
        const nl = parseSpiceNetlist(`
.subckt t c b e
.model qn npn (bf=100 rc=5 rb=10 re=1 cje=2p cjc=4p)
q1 c b e qn area=2
r1 c 0 1k
.ends
`);
        const parts = buildSpiceParts(nl);
        const classes = parts.map(p => p.className);
        expect(classes).toEqual([
            "ResistorElm", "ResistorElm", "ResistorElm",   // rc, rb, re
            "CapacitorElm", "CapacitorElm",                // cje, cjc
            "TransistorElm", "ResistorElm",
        ]);
        // rc/area, rb/area, re/area on fresh nodes past the node table
        expect(parts.slice(0, 3).map(p => p.dump)).toEqual(["0 2.5", "0 5", "0 0.5"]);
        // cje*area, cjc*area, backward Euler
        expect(parts.slice(3, 5).map(p => p.dump)).toEqual(["2 4e-12 0 0", "2 8e-12 0 0"]);
        // base 5 (after rb), collector 4 (after rc), emitter 6 (after re)
        expect(parts[5].nodes).toEqual([5, 4, 6]);
        expect(parts[3].nodes).toEqual([5, 6]);   // cje: base-emitter
        expect(parts[4].nodes).toEqual([5, 4]);   // cjc: base-collector
        expect(parts[5].dump).toBe("0 1 0 0 100 t-qn-A2");
    });

    it("wires an n-channel and a p-channel JFET, gate-source-drain", () => {
        const nl = parseSpiceNetlist(`
.subckt t d g s
.model jn njf (vto=-2 beta=1m)
.model jp pjf (vto=2 beta=0.5m)
j1 d g s jn
j2 s g d jp
.ends
`);
        const parts = buildSpiceParts(nl);
        expect(parts[0].className).toBe("JfetElm");
        expect(parts[0].nodes).toEqual([2, 3, 1]);   // SPICE d g s → gate, source, drain
        // beta is doubled: SPICE has no 1/2 in Id = beta*(vgs-vt)^2, CircuitJS does
        expect(parts[0].dump).toBe("0 -2 0.002");
        expect(parts[1].nodes).toEqual([2, 1, 3]);   // g=2, s=1, d=3
        expect(parts[1].dump).toBe("1 2 0.001");
    });
});

describe("model scope", () => {
    beforeAll(() => {
        // the registries are global state; use names no other test touches
        registerSpiceModels(buildSpiceModels(parseSpiceNetlist(DIODE)));
    });

    it("registers nothing before the caller confirms", () => {
        const nl = parseSpiceNetlist(`
.subckt never c b e
.model qnever npn (bf=123)
q1 c b e qnever
.ends
`);
        const specs = buildSpiceModels(nl);
        expect(TransistorModel.registry.get("never-qnever")).toBeUndefined();
        registerSpiceModels(specs);
        expect(TransistorModel.registry.get("never-qnever")).toBeDefined();
    });

    it("puts the imported values into the registered model", () => {
        const dm = DiodeModel.registry.get("dclamp-dmod")!;
        expect(dm).toBeDefined();
        expect(dm.saturationCurrent).toBeCloseTo(2.52e-9, 20);
        expect(dm.seriesResistance).toBe(0.568);
        expect(dm.emissionCoefficient).toBe(1.752);
        expect(dm.breakdownVoltage).toBe(100);
    });

    it("registers a transistor model with its mapped fields", () => {
        registerSpiceModels(buildSpiceModels(parseSpiceNetlist(BJT)));
        const tm = TransistorModel.registry.get("amp-qn")!;
        expect(tm.satCur).toBe(1e-14);
        expect(tm.betaR).toBe(2);
        expect(tm.invEarlyVoltF).toBeCloseTo(0.01, 12);
        expect(tm.invRollOffF).toBeCloseTo(10, 12);
    });
});
