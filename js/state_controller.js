// Independent state controller for the Spot verification demo.
// The graph and scene renderers are adapted from FunFact; state transitions are new demo logic.

import { resolveAssetUrl } from "./data_adapter.js";

const STATE_LABELS = { INITIAL: "INITIAL", AFTER_SWITCH_A: "AFTER SWITCH A", AFTER_SWITCH_B: "AFTER SWITCH B" };

export class StateController {
    constructor({ data, graph, scene, elements, media }) {
        this.data = data;
        this.graph = graph;
        this.scene = scene;
        this.elements = elements;
        this.media = media;
        this.currentState = "INITIAL";
        this.currentRelations = [];
        this.selectedObjectId = null;
        this.autoRunning = false;
        this.autoTimers = [];
        this.transitionToken = 0;
        this.autoRunToken = 0;
        this.evidenceManifest = null;
        this.bindControls();
    }

    async start() {
        if (this.data.loadEvidenceManifest && this.data.evidenceManifestUrl) {
            this.evidenceManifest = await this.data.loadEvidenceManifest(this.data.evidenceManifestUrl);
        }
        if (this.data.presentationMode && !this.evidenceManifest) {
            throw new Error("Recorded evidence manifest is required in presentation mode");
        }
        this.setState("INITIAL", { fromAuto: true });
        const manifest = await this.data.loadManifest(this.data.manifestUrl, this.data);
        await this.scene.loadManifest(manifest);
    }

    bindControls() {
        this.elements.stateButtons.forEach(button => button.addEventListener("click", () => {
            this.stopAutoDemo();
            this.setState(button.dataset.state);
        }));
        this.elements.autoDemoButton.addEventListener("click", () => this.autoRunning ? this.stopAutoDemo() : this.startAutoDemo());
        this.elements.resetViewButton.addEventListener("click", () => {
            this.stopAutoDemo();
            this.clearSelection();
            this.graph.fit();
            this.scene.resetView();
            this.showTransition("");
        });
        this.elements.focusDemoAreaButton.addEventListener("click", () => {
            this.stopAutoDemo();
            this.clearSelection();
            this.scene.focusDemoArea();
            this.showTransition("Focused on Switch A · Switch B · Lamp area");
        });
        this.elements.showBoxesButton.addEventListener("click", () => {
            const visible = this.scene.toggleBoundingBoxes();
            this.elements.showBoxesButton.setAttribute("aria-pressed", String(visible));
            this.elements.showBoxesButton.textContent = visible ? "Show Boxes" : "Hide Boxes";
        });
    }

    setState(stateName, { fromAuto = false, preserveMedia = false } = {}) {
        if (!this.data.states[stateName]) return;
        if (!fromAuto) this.stopAutoDemo();
        this.currentState = stateName;
        const state = this.data.states[stateName];
        this.currentRelations = state.relations;
        this.graph.render(this.data.objects, state.relations);
        if (this.selectedObjectId) this.applySelection({ focus: false });
        this.updateStateControls();
        this.renderEvidence(stateName, state);
        if (!preserveMedia) this.renderMedia(stateName, { autoplay: fromAuto });
    }

    updateStateControls() {
        this.elements.currentStateLabel.textContent = STATE_LABELS[this.currentState];
        this.elements.stateButtons.forEach(button => {
            const active = button.dataset.state === this.currentState;
            button.classList.toggle("is-active", active);
            button.setAttribute("aria-pressed", String(active));
        });
    }

    onObjectSelected(objectId, { source } = {}) {
        if (!objectId) {
            this.clearSelection();
            return;
        }
        const normalizedId = this.data.aliases.get(String(objectId)) || String(objectId);
        const object = this.data.objectById.get(normalizedId);
        if (!object) return;
        this.selectedObjectId = normalizedId;
        this.applySelection({ focus: source === "graph" });
        this.elements.selectionStatus.textContent = `Selected: ${object.label}`;
        this.updateSelectionCard(object, this.relatedObjectIds());
    }

    onObjectHovered(objectId) {
        this.scene.setHoveredObject(objectId);
    }

    relatedObjectIds() {
        if (!this.selectedObjectId) return [];
        return this.currentRelations
            .filter(relation => relation.source === this.selectedObjectId || relation.target === this.selectedObjectId)
            .map(relation => relation.source === this.selectedObjectId ? relation.target : relation.source);
    }

    applySelection({ focus = false } = {}) {
        if (!this.selectedObjectId) return;
        const related = this.relatedObjectIds();
        this.graph.selectNode(this.selectedObjectId, { focus: false });
        this.graph.highlightRelations(this.selectedObjectId);
        this.scene.highlightObject(this.selectedObjectId, { focus });
        this.scene.setRelatedObjects(related);
        const object = this.data.objectById.get(this.selectedObjectId);
        if (object) this.updateSelectionCard(object, related);
    }

    updateSelectionCard(object, relatedIds) {
        if (!this.elements.sceneSelectionCard) return;
        const relatedLabels = relatedIds.map(id => this.data.objectById.get(id)?.label || id);
        this.elements.sceneSelectionLabel.textContent = object.label;
        this.elements.sceneSelectionMeta.textContent = relatedLabels.length
            ? `Related: ${relatedLabels.join(" · ")}`
            : `${object.type || "scene object"} · manual PLY-frame annotation`;
        this.elements.sceneSelectionCard.hidden = false;
    }

    clearSelection() {
        this.selectedObjectId = null;
        this.graph.clearSelection();
        this.scene.clearSelection();
        this.elements.selectionStatus.textContent = "No object selected";
        if (this.elements.sceneSelectionCard) this.elements.sceneSelectionCard.hidden = true;
    }

    renderEvidence(stateName, state) {
        const content = this.elements.evidenceContent;
        const evidence = this.recordedEvidence(stateName) || (this.data.presentationMode ? null : state.evidence);
        if (!evidence) {
            const initialState = stateName === "INITIAL";
            content.innerHTML = `<div class="evidence-idle"><strong>${initialState || !this.data.presentationMode ? "No interaction yet" : "Recorded evidence unavailable"}</strong><span>${initialState || !this.data.presentationMode ? "Candidate relations remain visible until physical evidence is observed." : "Presentation mode does not substitute scripted evidence."}</span></div>`;
            this.elements.evidencePanel.dataset.result = initialState || !this.data.presentationMode ? "idle" : "unavailable";
            return;
        }
        const sourceId = evidence.source_object_id || evidence.source;
        const object = this.data.objectById.get(sourceId);
        const label = object ? object.label : sourceId;
        const unsupported = evidence.result === "unsupported";
        const resultLabel = unsupported ? "Relation unsupported in this controlled setup" : "Relation verified";
        const resultClass = unsupported ? "unsupported" : "verified";
        const pressConfirmed = evidence.press_success_confirmed ?? evidence.press_confirmed;
        const pressLabel = pressConfirmed === false ? "Press not confirmed" : "Recorded press confirmed";
        const confidence = Number.isFinite(Number(evidence.press_confidence)) ? ` · signal confidence ${(Number(evidence.press_confidence) * 100).toFixed(0)}%` : "";
        content.innerHTML = `<div class="evidence-object"><span class="evidence-label">${escapeHtml(label)}</span><strong>${escapeHtml(pressLabel)}${escapeHtml(confidence)}</strong></div><div class="lamp-transition"><span>Lamp state</span><strong>${escapeHtml(evidence.lamp_before)} <b>→</b> ${escapeHtml(evidence.lamp_after)}</strong></div><div class="evidence-result ${resultClass}"><span>Result</span><strong>${resultLabel}</strong></div>`;
        this.elements.evidencePanel.dataset.result = resultClass;
    }

    recordedEvidence(stateName) {
        if (!this.evidenceManifest || stateName === "INITIAL") return null;
        const stateRecord = this.evidenceManifest.states?.[stateName];
        const key = stateRecord?.evidence_key;
        return key ? this.evidenceManifest.evidence?.interaction_evidence?.[key] || null : null;
    }

    renderMedia(stateName, { autoplay = false, playAll = false } = {}) {
        if (!this.media) return;
        const stateRecord = this.evidenceManifest?.states?.[stateName];
        const items = (stateRecord?.media || []).map(item => ({ ...item, source: resolveAssetUrl(item.source, this.evidenceManifest.__sourceUrl) }));
        return this.media.render(items, { autoplay, playAll });
    }

    playEvidence(stateName) { return this.renderMedia(stateName, { autoplay: true, playAll: true }); }

    startAutoDemo() {
        this.stopAutoDemo({ resetButton: false });
        this.autoRunning = true;
        document.body.dataset.autoDemo = "true";
        this.elements.autoDemoButton.textContent = "Stop Auto Demo";
        this.elements.autoDemoButton.setAttribute("aria-pressed", "true");
        this.setState("INITIAL", { fromAuto: true, preserveMedia: true });
        this.onObjectSelected("lamp", { source: "auto" });
        const evidenceA = this.recordedEvidence("AFTER_SWITCH_A");
        const evidenceB = this.recordedEvidence("AFTER_SWITCH_B");
        if (!evidenceA || !evidenceB) {
            this.stopAutoDemo();
            this.showTransition("Corrected evidence unavailable");
            return;
        }
        const token = ++this.autoRunToken;
        this.runAutoDemoTimeline(token, evidenceA, evidenceB);
    }

    async runAutoDemoTimeline(token, evidenceA, evidenceB) {
        const active = () => this.autoRunning && token === this.autoRunToken;
        const wait = delay => new Promise(resolve => window.setTimeout(resolve, delay));
        await wait(450); if (!active()) return;
        this.onObjectSelected("switch_A", { source: "auto" });
        await this.playEvidence("AFTER_SWITCH_A"); if (!active()) return;
        this.showTransition("Switch A selected · evidence playing");
        await wait(evidenceA.press_contact_timestamp_sec * 1000); if (!active()) return;
        this.showTransition("Successful press · Switch A");
        await wait((evidenceA.after_timestamp_sec - evidenceA.press_contact_timestamp_sec) * 1000); if (!active()) return;
        this.showTransition("Lamp: OFF → OFF");
        this.setState("AFTER_SWITCH_A", { fromAuto: true, preserveMedia: true });
        this.showTransition("Lamp: OFF → OFF · Switch A REMOVED");
        await wait(1250); if (!active()) return;
        this.onObjectSelected("switch_B", { source: "auto" });
        await this.playEvidence("AFTER_SWITCH_B"); if (!active()) return;
        this.showTransition("Switch B selected · evidence playing");
        await wait(evidenceB.press_contact_timestamp_sec * 1000); if (!active()) return;
        this.showTransition("Successful press · Switch B");
        await wait((evidenceB.state_change_timestamp_sec - evidenceB.press_contact_timestamp_sec) * 1000); if (!active()) return;
        this.showTransition("Lamp: OFF → ON");
        await wait((evidenceB.after_timestamp_sec - evidenceB.state_change_timestamp_sec) * 1000); if (!active()) return;
        this.setState("AFTER_SWITCH_B", { fromAuto: true, preserveMedia: true });
        this.onObjectSelected("lamp", { source: "auto" });
        this.stopAutoDemo();
        this.showTransition("Lamp selected · OFF → ON · Switch B VERIFIED");
    }

    stopAutoDemo({ resetButton = true } = {}) {
        this.autoTimers.forEach(timer => clearTimeout(timer));
        this.autoTimers = [];
        this.autoRunning = false;
        this.autoRunToken += 1;
        document.body.dataset.autoDemo = "false";
        if (resetButton) {
            this.elements.autoDemoButton.textContent = "Auto Demo";
            this.elements.autoDemoButton.setAttribute("aria-pressed", "false");
        }
    }

    showTransition(message) {
        const token = ++this.transitionToken;
        const target = this.elements.transitionMessage;
        target.textContent = message;
        target.classList.toggle("is-visible", Boolean(message));
        if (message) window.setTimeout(() => {
            if (token === this.transitionToken && !this.autoRunning) {
                target.textContent = "";
                target.classList.remove("is-visible");
            }
        }, 2200);
    }
}

function escapeHtml(value) {
    return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
