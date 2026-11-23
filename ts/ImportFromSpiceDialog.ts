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

// File -> Import Subcircuit From Spice...: paste a netlist, press OK, and the
// subcircuit editor opens with the imported circuit.

import { Dialog } from "./Dialog";
import { CirSim } from "./CirSim";
import { Locale } from "./Locale";
import { EditSubcircuitModelDialog } from "./EditSubcircuitModelDialog";
import { importSpiceModel, SPICE_IMPORT_HELP } from "./ImportFromSpiceModel";
import { SpiceParseError } from "./ImportFromSpice";

export class ImportFromSpiceDialog extends Dialog {
    constructor() {
        super();
        this.closeOnEnter = false;
        this.makeResizable();
        this.dialogEl.innerHTML = "";

        const title = document.createElement("div");
        title.textContent = Locale.LS("Import Subcircuit From Spice");
        title.style.fontWeight = "bold";
        title.style.marginBottom = "8px";
        this.dialogEl.appendChild(title);

        const help = document.createElement("div");
        help.textContent = Locale.LS(SPICE_IMPORT_HELP);
        help.style.maxWidth = "420px";
        help.style.marginBottom = "6px";
        help.style.fontSize = "smaller";
        this.dialogEl.appendChild(help);

        const textArea = document.createElement("textarea");
        textArea.style.width = "420px";
        textArea.style.height = "220px";
        textArea.style.display = "block";
        textArea.style.fontFamily = "monospace";
        textArea.placeholder = ".subckt myfilter in out\nr1 in out 1k\nc1 out 0 1u\n.ends";
        this.dialogEl.appendChild(textArea);

        // messages and errors; hidden until there is something to say
        const log = document.createElement("div");
        log.style.marginTop = "6px";
        log.style.maxWidth = "420px";
        log.style.fontFamily = "monospace";
        log.style.fontSize = "smaller";
        log.style.whiteSpace = "pre-wrap";
        log.style.color = "#b00";
        log.hidden = true;
        this.dialogEl.appendChild(log);

        const buttons = document.createElement("div");
        buttons.style.display = "flex";
        buttons.style.gap = "8px";
        buttons.style.marginTop = "8px";
        this.dialogEl.appendChild(buttons);

        const okButton = document.createElement("button");
        okButton.textContent = Locale.LS("OK");
        okButton.addEventListener("click", () => {
            log.hidden = true;
            log.textContent = "";
            try {
                const model = importSpiceModel(textArea.value);
                this.closeDialog();
                const editor = new EditSubcircuitModelDialog();
                editor.setModel(model);
                editor.createDialog();
                CirSim.dialogShowing = editor;
                editor.show();
            } catch (e) {
                // a parse error names the line and the token; anything else is a bug
                log.textContent = e instanceof SpiceParseError ? e.message : String(e);
                log.hidden = false;
            }
        });
        buttons.appendChild(okButton);

        const cancelButton = document.createElement("button");
        cancelButton.textContent = Locale.LS("Cancel");
        cancelButton.addEventListener("click", () => this.closeDialog());
        buttons.appendChild(cancelButton);

        this.show();
    }
}
