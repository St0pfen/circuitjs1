/*
    Copyright (C) Paul Falstad and Iain Sharp

    This file is part of CircuitJS1.

    CircuitJS1 is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 2 of the License, or
    (at your option) any later version.

    CircuitJS1 is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with CircuitJS1.  If not, see <http://www.gnu.org/licenses/>.
*/

// The dialog behind File -> Import Subcircuit From Spice...: paste a netlist,
// press OK, and the subcircuit editor opens with the imported circuit.
//
// importSpiceModel() is the whole hand-off and is separate from the dialog so it
// can be tested without a browser: parse, build the model cards as descriptions,
// build the elements, register the models (only now, so a broken netlist leaves
// nothing behind), and hand the old nodeList/elmDump pair to SubcircuitModel.

// The hand-off from a pasted SPICE netlist to a CircuitJS subcircuit model, kept
// apart from the dialog: this part is testable without a browser.
//
// parse -> build the model cards as descriptions -> build the elements -> register
// the models (only now, so a broken netlist leaves nothing behind) -> hand the old
// nodeList/elmDump pair to SubcircuitModel.

import { SubcircuitModel } from "./SubcircuitModel";
import { ChipElm } from "./ChipElm";
import { buildSpiceModels, buildSpiceParts, parseSpiceNetlist, registerSpiceModels,
         toOldFormatModel } from "./ImportFromSpice";

// What the dialog says about its own scope.  Kept here so a test can check that
// it stays honest.
export const SPICE_IMPORT_HELP =
    "Paste one .subckt from a SPICE netlist. Supported: R, C, L, V, I, D, Q, J, " +
    "E, G, F, H and B sources with their .model cards. Imported for a DC operating " +
    "point; .tran and .ac analysis, .include, .param, nested X subcircuits and " +
    "SIN/PULSE/EXP sources are not supported.";

export function importSpiceModel(text: string, name?: string): SubcircuitModel {
    const nl = parseSpiceNetlist(text);
    const specs = buildSpiceModels(nl);
    // build the elements before registering anything: a netlist we cannot import
    // must not leave models in the registry
    const parts = buildSpiceParts(nl, specs);
    registerSpiceModels(specs);
    const { nodeList, elmDump } = toOldFormatModel(parts);
    // a SPICE netlist has no pin positions, so spread them over both sides; the
    // editor lets the user drag them afterwards
    nl.extList.forEach((entry, i) => {
        entry.side = i % 2 === 0 ? ChipElm.SIDE_W : ChipElm.SIDE_E;
        entry.pos = Math.floor(i / 2);
    });
    return SubcircuitModel.createModelFromOldFormat(name ?? nl.subcircuitName, elmDump, nodeList, nl.extList);
}
