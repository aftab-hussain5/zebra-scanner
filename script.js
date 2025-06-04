// ZebraBrowserPrintWrapper.js

class ZebraBrowserPrintWrapper {
    constructor(statusCallback) {
        this.selectedDevice = null;
        this.statusCallback = statusCallback || function(message, type) {
            console.log(`[${type.toUpperCase()}] ${new Date().toLocaleTimeString()}: ${message}`);
        };

        // Check if Handlebars is available
        try {
            if (typeof Handlebars === 'undefined') {
                throw new Error("Handlebars templating library not found. Please ensure it's included globally.");
            }
            // No instance needed for Handlebars compilation, it's a global object with methods
        } catch (e) {
            this._updateStatus(`Error initializing Handlebars environment: ${e.message}`, "error");
            throw e;
        }

        if (typeof BrowserPrint === 'undefined') {
            this._updateStatus("Zebra Browser Print library not found. Please ensure it's included.", "error");
            throw new Error("Zebra Browser Print library not loaded.");
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
                    const zebraPrinters = device_list.filter(device =>
                        device.connection === 'usb' ||
                        (device.connection === 'driver' && device.manufacturer && device.manufacturer.toLowerCase().includes('zebra'))
                    );
                    if (zebraPrinters.length > 0) {
                        this._updateStatus(`Found ${zebraPrinters.length} Zebra printer(s).`, "success");
                        if (!this.selectedDevice && zebraPrinters[0]) {
                            this.selectedDevice = zebraPrinters[0];
                            this._updateStatus(`Default printer set to: ${this.selectedDevice.name}`);
                        }
                    } else {
                        this._updateStatus("No suitable Zebra printers found locally.", "warn");
                    }
                    resolve(zebraPrinters);
                },
                (error_response) => {
                    this._updateStatus("Error scanning for printers: " + error_response + ". Is Zebra Browser Print utility running?", "error");
                    reject("Error scanning for printers: " + error_response);
                },
                "printer"
            );
        });
    }

    setSelectedPrinter(device) {
        if (device && device.name && device.uid && device.send) {
            this.selectedDevice = device;
            this._updateStatus(`Printer selected: ${device.name}`, "success");
        } else {
            this._updateStatus("Invalid printer device object provided.", "error");
            this.selectedDevice = null;
        }
    }

    getSelectedPrinter() {
        return this.selectedDevice;
    }

    async readPrintJobStatus(untilString = "\r\n", timeoutMs = 5000) {
        if (!this.selectedDevice) {
            const errorMsg = "No printer selected to read status from.";
            this._updateStatus(errorMsg, "error");
            return Promise.reject(errorMsg);
        }
        if (!this.selectedDevice.readUntilString) {
            const errorMsg = "Selected device does not support 'readUntilString'.";
            this._updateStatus(errorMsg, "error");
            return Promise.reject(errorMsg);
        }
        this._updateStatus(`Attempting to read status from ${this.selectedDevice.name}...`);
        return new Promise((resolve, reject) => {
            let timeoutId = setTimeout(() => {
                this._updateStatus(`Timeout reading from printer after ${timeoutMs}ms.`, "error");
                reject("Timeout reading from printer.");
            }, timeoutMs);
            this.selectedDevice.readUntilString(untilString, (data) => {
                clearTimeout(timeoutId);
                this._updateStatus(`Data received: ${data.substring(0,100)}...`, "success");
                resolve(data);
            }, (errorText) => {
                clearTimeout(timeoutId);
                this._updateStatus(`Error reading: ${errorText}`, "error");
                reject(errorText);
            });
        });
    }

    /**
     * Processes the print request and sends ZPL to the selected printer using Handlebars.
     * @param {Object} printRequestPayload - The payload containing print job details and ZPL templates.
     * @returns {Promise<Object>} A promise that resolves with a summary of print operations.
     */
    async zebraPrintWrapper(printRequestPayload) {
        this._updateStatus("Processing print request (Handlebars)...");

        if (!this.selectedDevice) { /* ... error handling ... */ return Promise.reject("No printer selected.");}
        if (!printRequestPayload || !printRequestPayload.KitLabelsRequest) { /* ... error handling ... */ return Promise.reject("Invalid payload.");}

        const { KitLabelsRequest } = printRequestPayload;
        let zplCommandsArray = [];
        let failedPrintsDueToRendering = 0;

        if (KitLabelsRequest.LabelSet &&
            KitLabelsRequest.LabelSet.KitLabelData &&
            KitLabelsRequest.LabelSet.KitLabelData.LabelTemplateZPL &&
            KitLabelsRequest.LabelSet.KitLabelData.KitLabelIDs) {

            const zplTemplateString = KitLabelsRequest.LabelSet.KitLabelData.LabelTemplateZPL;
            let compiledTemplate;
            try {
                compiledTemplate = Handlebars.compile(zplTemplateString);
            } catch (e) {
                this._updateStatus(`Error compiling Handlebars template: ${e.message}`, "error");
                return Promise.reject({ message: `Template compilation error: ${e.message}`, successfulPrints: 0, failedPrints: KitLabelsRequest.LabelSet.KitLabelData.KitLabelIDs.length, totalLabelsAttemptedRender: KitLabelsRequest.LabelSet.KitLabelData.KitLabelIDs.length });
            }
            
            for (const kitIdObj of KitLabelsRequest.LabelSet.KitLabelData.KitLabelIDs) {
                const templateData = {};

                if (kitIdObj.hasOwnProperty('KitID')) {
                    templateData.KitId = kitIdObj.KitID; // Matches {{KitId}}
                } else { /* ... warning ... */ }

                if (KitLabelsRequest.hasOwnProperty('KitSKU')) {
                    const skuParts = KitLabelsRequest.KitSKU.split('-');
                    templateData.KitType = skuParts[0] || KitLabelsRequest.KitSKU; // Matches {{KitType}}
                } else { /* ... warning ... */ }

                if (KitLabelsRequest.hasOwnProperty('LotNumber')) {
                    templateData.LotNumber = KitLabelsRequest.LotNumber; // Matches {{LotNumber}}
                } else { /* ... warning ... */ }

                if (KitLabelsRequest.hasOwnProperty('ExpirationDate')) {
                    templateData.ExpirationDate = KitLabelsRequest.ExpirationDate; // Matches {{ExpirationDate}}
                } else { /* ... warning ... */ }
                
                try {
                    const zpl = compiledTemplate(templateData); // Use the compiled template
                    console.log(zpl,"zpl");
                    zplCommandsArray.push(zpl);
                } catch (e) {
                    this._updateStatus(`Error rendering Kit Label ZPL (Handlebars) for KitID ${kitIdObj.KitID || 'N/A'}: ${e.message}. Data: ${JSON.stringify(templateData)}`, "error");
                    failedPrintsDueToRendering++;
                }
            }
        } else { /* ... warning ... */ }

        if (zplCommandsArray.length === 0) { /* ... handling for no ZPL generated ... */ 
             const message = failedPrintsDueToRendering > 0 ?
                "No valid ZPL commands generated due to rendering errors." :
                "No ZPL commands generated. Check payload structure and content.";
            this._updateStatus(message, failedPrintsDueToRendering > 0 ? "error" : "warn");
            return failedPrintsDueToRendering > 0 ?
                Promise.reject({ message, successfulPrints: 0, failedPrints: failedPrintsDueToRendering, totalLabelsAttempted: failedPrintsDueToRendering }) :
                Promise.resolve({ message, successfulPrints: 0, failedPrints: 0, totalLabelsAttempted: 0 });
        }


        this._updateStatus(`Attempting to print ${zplCommandsArray.length} label(s) to ${this.selectedDevice.name}...`);
        // ... (The rest of the print sending logic using Promise.allSettled remains the same) ...
        let successfulSends = 0;
        let failedSends = 0;
        const totalToRender = KitLabelsRequest.LabelSet.KitLabelData.KitLabelIDs.length;

        const printPromises = zplCommandsArray.map((zpl, index) => {
            return new Promise((resolvePrint, rejectPrint) => {
                this.selectedDevice.send(zpl,
                    (successResponse) => {
                        this._updateStatus(`Label ${index + 1} sent successfully.`, "success");
                        resolvePrint({ status: "success", labelIndex: index + 1 });
                    },
                    (errorResponse) => {
                        this._updateStatus(`Error sending label ${index + 1}: ${errorResponse}`, "error");
                        rejectPrint({ status: "error", labelIndex: index + 1, error: errorResponse });
                    }
                );
            });
        });

        return Promise.allSettled(printPromises).then(results => {
            successfulSends = results.filter(r => r.status === 'fulfilled').length;
            failedSends = results.filter(r => r.status === 'rejected').length;

            const finalMessage = `Print operations complete. Labels to Render: ${totalToRender}. Rendered ZPLs: ${zplCommandsArray.length}. Sent Successfully: ${successfulSends}. Send Failures: ${failedSends}. Render Failures: ${failedPrintsDueToRendering}.`;
            this._updateStatus(finalMessage, (failedSends > 0 || failedPrintsDueToRendering > 0) ? "error" : "success");
            return {
                message: finalMessage,
                successfulPrints: successfulSends,
                failedPrints: failedSends + failedPrintsDueToRendering,
                totalLabelsAttemptedRender: totalToRender,
                zplsGenerated: zplCommandsArray.length,
                individualSendResults: results
            };
        });
    }
}