// ZebraBrowserPrintWrapper.js

class ZebraBrowserPrintWrapper {
    constructor(statusCallback) {
        this.selectedDevice = null; // UI selected printer (fallback or for direct actions)
        this.availablePrinters = [];
        this.statusCallback = statusCallback || function(message, type) {
            const typeUpper = type ? type.toUpperCase() : "INFO";
            console.log(`[${typeUpper}] ${new Date().toLocaleTimeString()}: ${message}`);
        };

        try {
            if (typeof Handlebars === 'undefined') {
                throw new Error("Handlebars templating library not found. Please ensure it's included globally.");
            }
        } catch (e) {
            this._updateStatus(`Initialization Error: ${e.message}`, "error");
            throw e; // Re-throw to prevent wrapper usage if Handlebars is missing
        }

        if (typeof BrowserPrint === 'undefined') {
            this._updateStatus("Zebra Browser Print library not found. Please ensure it's included.", "error");
            throw new Error("Zebra Browser Print library not loaded."); // Re-throw
        }
    }

    _updateStatus(message, type = "info") {
        if (this.statusCallback) {
            this.statusCallback(message, type);
        }
    }

    async zebraScanPrinters() {
        this._updateStatus("Scanning for local Zebra printers...");
        return new Promise((resolve, reject) => {
            BrowserPrint.getLocalDevices(
                (device_list) => {
                    this.availablePrinters = device_list.filter(device =>
                        device.connection === 'usb' ||
                        (device.connection === 'driver' && device.manufacturer && device.manufacturer.toLowerCase().includes('zebra')) ||
                        device.connection === 'network' // Include network printers if BrowserPrint finds them
                    );
                    if (this.availablePrinters.length > 0) {
                        this._updateStatus(`Found ${this.availablePrinters.length} Zebra printer(s). List them in UI.`, "success");
                    } else {
                        this._updateStatus("No suitable Zebra printers found locally.", "warn");
                    }
                    resolve(this.availablePrinters); // Resolve with all found printers (empty if none)
                },
                (error_response) => {
                    const errorMsg = `Error scanning for printers: ${error_response}. Is Zebra Browser Print utility running and configured?`;
                    this._updateStatus(errorMsg, "error");
                    this.availablePrinters = []; // Clear list on error
                    reject(errorMsg);
                },
                "printer" // Specify we are looking for printers
            );
        });
    }

    setSelectedPrinter(device) { // For UI selection / fallback
        // This method is called by the UI when the dropdown selection changes
        if (device && device.name && typeof device.uid !== 'undefined' && typeof device.send === 'function') { // Check for send method
            this.selectedDevice = device;
            this._updateStatus(`UI Printer selection changed to: ${device.name} (UID: ${device.uid})`, "info");
        } else if (device === null) { // Explicitly de-selecting
            this.selectedDevice = null;
            this._updateStatus("UI Printer selection cleared.", "info");
        } else {
            this._updateStatus("Attempted to set an invalid printer device from UI.", "warn");
            // Optionally set this.selectedDevice = null here if strictness is required
        }
    }

    getSelectedPrinter() {
        // Returns the printer currently selected in the UI (stored in this.selectedDevice)
        return this.selectedDevice;
    }

    // Finds printer by name (case-insensitive) or UID from the availablePrinters list
    _findDevice(identifier) {
        if (!identifier || this.availablePrinters.length === 0) return null;
        const identifierLower = String(identifier).toLowerCase();
        // Prioritize exact name matching, then UID, then case-insensitive name
        let found = this.availablePrinters.find(p => p.name === identifier);
        if (found) return found;
        found = this.availablePrinters.find(p => p.uid === identifier);
        if (found) return found;
        found = this.availablePrinters.find(p => p.name && p.name.toLowerCase() === identifierLower);
        return found; // Will be null if not found by any criteria
    }

    /**
     * Public method to send raw ZPL to a specified printer.
     * @param {string} zpl - The raw ZPL string to print.
     * @param {string} printerIdentifier - The name or UID of the target printer.
     * @param {Object|string} labelContext - Optional context/identifier for this label (e.g., {id: "SHIP001", type: "shipping"}) for logging and result tracking.
     * @returns {Promise<Object>} Promise resolving with success/failure details.
     */
    async sendRawZplToPrinter(zpl, printerIdentifier, labelContext = "Direct ZPL Print") {
        const labelIdForLog = typeof labelContext === 'object' ? (labelContext.id || JSON.stringify(labelContext)) : labelContext;

        if (!zpl || typeof zpl !== 'string' || zpl.trim() === "") {
            const msg = `${labelIdForLog}: ZPL string is empty or invalid.`;
            this._updateStatus(msg, "error");
            return Promise.reject({ status: "error", message: msg, context: labelContext, printerIdentifier });
        }
        if (!printerIdentifier) {
            const msg = `${labelIdForLog}: Printer identifier (name or UID) is required.`;
            this._updateStatus(msg, "error");
            return Promise.reject({ status: "error", message: msg, context: labelContext });
        }

        const device = this._findDevice(printerIdentifier);
        if (!device) {
            const msg = `${labelIdForLog}: Printer '${printerIdentifier}' not found among scanned devices.`;
            this._updateStatus(msg, "error");
            return Promise.reject({ status: "error", message: msg, context: labelContext, printerIdentifier });
        }
        if (typeof device.send !== 'function') { // Check if send is a function
             const msg = `${labelIdForLog}: Printer '${printerIdentifier}' found but is invalid (missing or invalid 'send' method).`;
            this._updateStatus(msg, "error");
            return Promise.reject({ status: "error", message: msg, context: labelContext, printerIdentifier });
        }

        this._updateStatus(`${labelIdForLog}: Sending to ${device.name} (UID: ${device.uid})...`, "info");
        return new Promise((resolve, reject) => {
            device.send(zpl,
                () => { // Success callback from BrowserPrint often has no arguments
                    this._updateStatus(`${labelIdForLog}: Sent successfully to ${device.name}.`, "success");
                    resolve({ status: "success", message: "Sent successfully", context: labelContext, deviceName: device.name, deviceUID: device.uid });
                },
                (errorResponse) => { // Error
                    const msg = `${labelIdForLog}: Error sending to ${device.name}: ${errorResponse}`;
                    this._updateStatus(msg, "error");
                    reject({ status: "error", message: msg, error: errorResponse, context: labelContext, deviceName: device.name, deviceUID: device.uid });
                }
            );
        });
    }


    // --- Specific Label Type Printing Functions (now use sendRawZplToPrinter) ---

    async printKitLabels(kitLabelsRequestData) {
        this._updateStatus("Processing Kit Labels...", "info");
        const resultsCollector = { type: "KitLabels", printerUsedIdentifier: null, request: kitLabelsRequestData, results: [] };

        if (!kitLabelsRequestData || !kitLabelsRequestData.PrinterName) {
            resultsCollector.error = "Missing KitLabelsRequest data or PrinterName.";
            this._updateStatus(resultsCollector.error, "error");
            return resultsCollector;
        }
        resultsCollector.printerUsedIdentifier = kitLabelsRequestData.PrinterName;

        const { LotNumber, KitSKU, ExpirationDate, LabelSet, PrinterName } = kitLabelsRequestData;
        if (!LabelSet || !LabelSet.KitLabelData || !LabelSet.KitLabelData.TemplateZPL || !LabelSet.KitLabelData.KitLabelIDs) {
            resultsCollector.error = "KitLabelData structure is incomplete.";
            this._updateStatus(resultsCollector.error, "error");
            return resultsCollector;
        }

        const zplTemplateString = LabelSet.KitLabelData.TemplateZPL;
        const kitLabelIDs = LabelSet.KitLabelData.KitLabelIDs;
        let compiledTemplate;

        try {
            compiledTemplate = Handlebars.compile(zplTemplateString);
        } catch (e) {
            const msg = `Kit Labels: Error compiling Handlebars template: ${e.message}`;
            this._updateStatus(msg, "error");
            resultsCollector.error = msg;
            // Populate results with compile errors for each label that would have been attempted
            (kitLabelIDs || []).forEach(idObj => resultsCollector.results.push({status: "compile_error", context: {type: "KitLabel", originalData: idObj, id: (idObj || {}).KitID}, message:msg}));
            return resultsCollector;
        }

        for (const kitIdObj of kitLabelIDs) {
            const labelContext = { type: "KitLabel", originalData: kitIdObj, id: (kitIdObj || {}).KitID };
            if (!kitIdObj || typeof kitIdObj.KitID === 'undefined') {
                this._updateStatus(`Kit Labels: Skipping an item due to missing KitID. Data: ${JSON.stringify(kitIdObj)}`, "warn");
                resultsCollector.results.push({ status: "skipped", message: "Missing KitID", context: labelContext });
                continue;
            }

            const templateData = {
                KitId: kitIdObj.KitID,
                KitType: KitSKU ? (String(KitSKU).split('-')[0] || KitSKU) : "SKU_MISSING",
                LotNumber: LotNumber || "LOT_MISSING",
                ExpirationDate: ExpirationDate || "EXP_MISSING"
            };
            try {
                const zpl = compiledTemplate(templateData);
                // Wait for each print to complete to get individual status
                const result = await this.sendRawZplToPrinter(zpl, PrinterName, labelContext);
                resultsCollector.results.push(result);
            } catch (e_render_or_send) { // Catch from sendRawZplToPrinter's rejection or render error
                const msg = e_render_or_send.message || `Kit Labels: Error processing KitID ${templateData.KitId}`;
                this._updateStatus(msg, "error");
                resultsCollector.results.push({ status: e_render_or_send.status || "render_send_error", message: msg, context: labelContext, errorDetail: e_render_or_send });
            }
        }
        return resultsCollector;
    }

    async printSpecimenLabels(specimenLabelData) {
        this._updateStatus("Processing Specimen Labels...", "info");
        const resultsCollector = { type: "SpecimenLabels", printerUsedIdentifier: null, request: specimenLabelData, results: [] };

        if (!specimenLabelData || !specimenLabelData.PrinterName) {
            resultsCollector.error = "Missing SpecimenLabelData or PrinterName.";
            this._updateStatus(resultsCollector.error, "error");
            return resultsCollector;
        }
        resultsCollector.printerUsedIdentifier = specimenLabelData.PrinterName;

        const { TemplateZPL, SpecimenLabelIDs, PrinterName } = specimenLabelData;
        if (!TemplateZPL || !SpecimenLabelIDs) {
            resultsCollector.error = "SpecimenLabelData structure is incomplete (TemplateZPL or SpecimenLabelIDs missing).";
            this._updateStatus(resultsCollector.error, "error");
            return resultsCollector;
        }

        let compiledTemplate;
        try {
            compiledTemplate = Handlebars.compile(TemplateZPL);
        } catch (e) {
            const msg = `Specimen Labels: Error compiling Handlebars template: ${e.message}`;
            this._updateStatus(msg, "error");
            resultsCollector.error = msg;
            (SpecimenLabelIDs || []).forEach(idObj => resultsCollector.results.push({status: "compile_error", context: {type: "SpecimenLabel", originalData: idObj, id:(idObj || {}).KitID, specimenType: (idObj || {}).SpecimenLabel}, message:msg}));
            return resultsCollector;
        }

        for (const specimenObj of SpecimenLabelIDs) {
            const labelContext = { type: "SpecimenLabel", originalData: specimenObj, id: (specimenObj || {}).KitID, specimenType: (specimenObj || {}).SpecimenLabel };
            if (!specimenObj || typeof specimenObj.KitID === 'undefined' || typeof specimenObj.SpecimenLabel === 'undefined') {
                this._updateStatus(`Specimen Labels: Skipping an item due to missing KitID or SpecimenLabel. Data: ${JSON.stringify(specimenObj)}`, "warn");
                resultsCollector.results.push({ status: "skipped", message: "Missing KitID or SpecimenLabel", context: labelContext });
                continue;
            }

            const templateData = {
                KitId: specimenObj.KitID,
                SpecimenLabel: specimenObj.SpecimenLabel
            };
            try {
                const zpl = compiledTemplate(templateData);
                const result = await this.sendRawZplToPrinter(zpl, PrinterName, labelContext);
                resultsCollector.results.push(result);
            } catch (e_render_or_send) {
                const msg = e_render_or_send.message || `Specimen Labels: Error processing KitID ${templateData.KitId}, Type ${templateData.SpecimenLabel}`;
                this._updateStatus(msg, "error");
                resultsCollector.results.push({ status: e_render_or_send.status || "render_send_error", message: msg, context: labelContext, errorDetail: e_render_or_send });
            }
        }
        return resultsCollector;
    }


    // --- Main Orchestrator ---
    /**
     * @param {Object} mainPayload - The main JSON payload.
     * @param {string} actualKitZPL - The actual ZPL string for Kit labels.
     * @param {string} actualSpecimenZPL - The actual ZPL string for Specimen labels.
     */
    async zebraPrintWrapper(mainPayload, actualKitZPL, actualSpecimenZPL) {
        this._updateStatus("Orchestrating print jobs based on main payload...", "info");
        const overallResults = {
            kitLabelSummary: null,
            specimenLabelSummary: null,
            orchestrationErrors: [] // Store top-level errors here
        };

        if (!mainPayload) {
            const msg = "Main payload is missing.";
            this._updateStatus(msg, "error");
            overallResults.orchestrationErrors.push(msg);
            return overallResults;
        }

        // Process Kit Labels
        if (mainPayload.KitLabelsRequest) {
            let kitRequest = JSON.parse(JSON.stringify(mainPayload.KitLabelsRequest)); // Deep clone
            if (kitRequest.LabelSet && kitRequest.LabelSet.KitLabelData &&
                kitRequest.LabelSet.KitLabelData.TemplateZPL === "{{KitZPL}}") {
                if (actualKitZPL && actualKitZPL.trim() !== "") {
                    kitRequest.LabelSet.KitLabelData.TemplateZPL = actualKitZPL;
                } else {
                    const kitErr = "KitLabelsRequest specified {{KitZPL}} but no actual Kit ZPL template was provided.";
                    this._updateStatus(kitErr, "error");
                    overallResults.orchestrationErrors.push(kitErr);
                    // Avoid calling printKitLabels if template is fundamentally missing
                    overallResults.kitLabelSummary = { type: "KitLabels", error: kitErr, results: [] };
                }
            } else if (kitRequest.LabelSet && kitRequest.LabelSet.KitLabelData) {
                 this._updateStatus("KitLabelsRequest: Using TemplateZPL directly from payload (not {{KitZPL}} placeholder).", "info");
            }
            // Proceed only if no fatal error above with template
            if (!overallResults.kitLabelSummary || !overallResults.kitLabelSummary.error) {
                 overallResults.kitLabelSummary = await this.printKitLabels(kitRequest);
            }
            if(overallResults.kitLabelSummary && overallResults.kitLabelSummary.error && overallResults.orchestrationErrors.indexOf(overallResults.kitLabelSummary.error) === -1) {
                overallResults.orchestrationErrors.push(`KitLabels Processing Error: ${overallResults.kitLabelSummary.error}`);
            }

        } else {
            this._updateStatus("No KitLabelsRequest found in payload.", "info");
        }

        // Process Specimen Labels
        if (mainPayload.KitLabelsRequest && mainPayload.KitLabelsRequest.SpecimenLabelData) {
            let specimenData = JSON.parse(JSON.stringify(mainPayload.KitLabelsRequest.SpecimenLabelData)); // Deep clone
            if (specimenData.TemplateZPL === "{{SpecimenZPL}}") {
                if (actualSpecimenZPL && actualSpecimenZPL.trim() !== "") {
                    specimenData.TemplateZPL = actualSpecimenZPL;
                } else {
                    const specErr = "SpecimenLabelData specified {{SpecimenZPL}} but no actual Specimen ZPL template was provided.";
                    this._updateStatus(specErr, "error");
                    overallResults.orchestrationErrors.push(specErr);
                    overallResults.specimenLabelSummary = { type: "SpecimenLabels", error: specErr, results: [] };
                }
            } else {
                this._updateStatus("SpecimenLabelData: Using TemplateZPL directly from payload (not {{SpecimenZPL}} placeholder).", "info");
            }

            if(!overallResults.specimenLabelSummary || !overallResults.specimenLabelSummary.error) {
                overallResults.specimenLabelSummary = await this.printSpecimenLabels(specimenData);
            }
            if(overallResults.specimenLabelSummary && overallResults.specimenLabelSummary.error && overallResults.orchestrationErrors.indexOf(overallResults.specimenLabelSummary.error) === -1) {
                 overallResults.orchestrationErrors.push(`SpecimenLabels Processing Error: ${overallResults.specimenLabelSummary.error}`);
            }
        } else {
            this._updateStatus("No SpecimenLabelData found in payload (expected under KitLabelsRequest).", "info");
        }

        let successCount = 0;
        let failureCount = 0; // Includes skipped, compile_error, render_send_error, and actual send errors
        if(overallResults.kitLabelSummary && overallResults.kitLabelSummary.results) {
            successCount += overallResults.kitLabelSummary.results.filter(r => r.status === 'success').length;
            failureCount += overallResults.kitLabelSummary.results.filter(r => r.status !== 'success').length;
        }
        if(overallResults.specimenLabelSummary && overallResults.specimenLabelSummary.results) {
            successCount += overallResults.specimenLabelSummary.results.filter(r => r.status === 'success').length;
            failureCount += overallResults.specimenLabelSummary.results.filter(r => r.status !== 'success').length;
        }

        const finalSummaryMessage = `Print Orchestration Complete. Total Successful Sends: ${successCount}. Total Failures/Skipped/Errors: ${failureCount}.`;
        this._updateStatus(finalSummaryMessage, (failureCount > 0 || overallResults.orchestrationErrors.length > 0) ? "warn" : "success");
        if(overallResults.orchestrationErrors.length > 0) {
            this._updateStatus(`Overall Orchestration Errors: ${overallResults.orchestrationErrors.join('; ')}`, "error");
        }
        
        return overallResults;
    }

    async readPrintJobStatus(untilString = "\r\n", timeoutMs = 7000, deviceToReadFrom = null) {
        const targetDevice = deviceToReadFrom || this.selectedDevice;
        if (!targetDevice) {
            const errorMsg = "No printer specified or selected to read status from.";
            this._updateStatus(errorMsg, "error");
            return Promise.reject(errorMsg);
        }
        if (typeof targetDevice.readUntilString !== 'function') {
            const errorMsg = `Target device ${targetDevice.name} does not support 'readUntilString'.`;
            this._updateStatus(errorMsg, "error");
            return Promise.reject(errorMsg);
        }
        this._updateStatus(`Attempting to read status from ${targetDevice.name} (UID: ${targetDevice.uid})...`);
        return new Promise((resolve, reject) => {
            let timeoutId = setTimeout(() => {
                this._updateStatus(`Timeout reading from printer ${targetDevice.name} after ${timeoutMs}ms.`, "error");
                reject(`Timeout reading from printer ${targetDevice.name}.`);
            }, timeoutMs);
            targetDevice.readUntilString(untilString, (data) => {
                clearTimeout(timeoutId);
                const responseData = data ? data.substring(0, 200) + (data.length > 200 ? '...' : '') : 'No data received';
                this._updateStatus(`Data received from ${targetDevice.name}: ${responseData}`, "success");
                resolve(data);
            }, (errorText) => {
                clearTimeout(timeoutId);
                this._updateStatus(`Error reading from ${targetDevice.name}: ${errorText}`, "error");
                reject(errorText);
            });
        });
    }
}