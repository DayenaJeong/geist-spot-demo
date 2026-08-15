import * as THREE from "three";
import { setupCameraCaptureControls } from "./camera_capture_ui.js";

const STORAGE_KEY = "spot-demo-manual-annotations-v2";

export function setupAnnotationMode({ data, scene }) {
    document.body.dataset.annotationMode = "true";
    const panel = document.createElement("section");
    panel.className = "annotation-panel";
    panel.setAttribute("aria-label", "Manual real-scene annotation");
    panel.innerHTML = `
        <div class="annotation-heading">
            <div><p class="panel-kicker">MANUAL REAL-SCENE ANNOTATION</p><h2>Direct point-cloud annotation</h2></div>
            <span class="panel-tag">aligned_world · Y-up</span>
        </div>
        <div class="annotation-toolbar">
            <label class="annotation-object">Object <select data-annotation-object></select></label>
            <button type="button" data-tool="draw-box">Draw Box</button>
            <span class="annotation-tool-label">Mode</span>
            <button type="button" class="is-active" data-tool="move">Move</button>
            <button type="button" data-tool="resize">Resize</button>
            <button type="button" data-tool="rotate">Rotate</button>
            <button type="button" data-tool="anchor">Set Anchor</button>
            <button type="button" data-tool="focus">Set Focus</button>
            <button type="button" data-action="camera">Save Current Camera</button>
            <button type="button" data-action="save">Save Annotation</button>
            <button type="button" data-action="reload">Reload Saved</button>
        </div>
        <p class="annotation-instructions" data-annotation-instructions>Choose Move, then drag the selected box gizmo. Draw Box creates a depth-filtered seed from a screen rectangle.</p>
        <details class="annotation-advanced" open><summary>Advanced numeric adjustment · 0.001 m precision</summary>
            <div class="annotation-controls">
                <fieldset><legend>Box center</legend><label>X <input data-field="cx" type="number" step="0.001"></label><label>Y <input data-field="cy" type="number" step="0.001"></label><label>Z <input data-field="cz" type="number" step="0.001"></label></fieldset>
                <fieldset><legend>Extent</legend><label>X <input data-field="ex" type="number" min="0.001" step="0.001"></label><label>Y <input data-field="ey" type="number" min="0.001" step="0.001"></label><label>Z <input data-field="ez" type="number" min="0.001" step="0.001"></label></fieldset>
                <label>Yaw <input data-field="yaw" type="number" step="0.1"></label>
                <fieldset><legend>Anchor point</legend><label>X <input data-field="ax" type="number" step="0.001"></label><label>Y <input data-field="ay" type="number" step="0.001"></label><label>Z <input data-field="az" type="number" step="0.001"></label></fieldset>
                <fieldset><legend>Focus point</legend><label>X <input data-field="fx" type="number" step="0.001"></label><label>Y <input data-field="fy" type="number" step="0.001"></label><label>Z <input data-field="fz" type="number" step="0.001"></label></fieldset>
                <fieldset><legend>Camera offset</legend><label>X <input data-field="ox" type="number" step="0.001"></label><label>Y <input data-field="oy" type="number" step="0.001"></label><label>Z <input data-field="oz" type="number" step="0.001"></label></fieldset>
                <button type="button" data-action="apply">Apply numeric values</button>
            </div>
        </details>
        <span class="annotation-status" data-annotation-status aria-live="polite"></span>`;
    document.querySelector(".app-shell").insertBefore(panel, document.querySelector(".app-footer"));
    setupCameraCaptureControls({ panel, scene, status: panel.querySelector("[data-annotation-status]") });

    const select = panel.querySelector("[data-annotation-object]");
    const fields = Object.fromEntries([...panel.querySelectorAll("[data-field]")].map(input => [input.dataset.field, input]));
    const status = panel.querySelector("[data-annotation-status]");
    const instructions = panel.querySelector("[data-annotation-instructions]");
    const toolButtons = [...panel.querySelectorAll("[data-tool]")];
    let tool = "move";
    let drawStart = null;
    let drawing = false;

    (data.objects || []).forEach(object => {
        const option = document.createElement("option");
        option.value = object.id;
        option.textContent = object.label;
        select.appendChild(option);
    });

    function current(id = select.value) {
        const annotation = scene.getAnnotation(id);
        if (!annotation) return null;
        return annotation;
    }

    function writeForm(annotation) {
        if (!annotation) return;
        const bbox = annotation.bbox;
        [fields.cx.value, fields.cy.value, fields.cz.value] = bbox.center.map(value => Number(value).toFixed(6));
        [fields.ex.value, fields.ey.value, fields.ez.value] = bbox.extent.map(value => Number(value).toFixed(6));
        fields.yaw.value = String(Number(bbox.rotation?.[1] || bbox.rotation?.[2] || 0).toFixed(3));
        [fields.ax.value, fields.ay.value, fields.az.value] = annotation.anchor.map(value => Number(value).toFixed(6));
        [fields.fx.value, fields.fy.value, fields.fz.value] = annotation.focus.map(value => Number(value).toFixed(6));
        const offset = annotation.cameraOffset || [0, 0, 0];
        [fields.ox.value, fields.oy.value, fields.oz.value] = offset.map(value => Number(value).toFixed(6));
    }

    function readForm() {
        return {
            bbox: {
                center: [Number(fields.cx.value), Number(fields.cy.value), Number(fields.cz.value)],
                extent: [Number(fields.ex.value), Number(fields.ey.value), Number(fields.ez.value)],
                rotation: [0, 0, Number(fields.yaw.value) || 0]
            },
            anchor: [Number(fields.ax.value), Number(fields.ay.value), Number(fields.az.value)],
            focus: [Number(fields.fx.value), Number(fields.fy.value), Number(fields.fz.value)],
            cameraOffset: [Number(fields.ox.value), Number(fields.oy.value), Number(fields.oz.value)],
            camera: current()?.camera || null
        };
    }

    function selectObject() {
        scene.detachTransformControls();
        scene.highlightObject(select.value, { focus: false });
        writeForm(current());
        status.textContent = `Editing ${select.options[select.selectedIndex]?.textContent || select.value}`;
        if (["move", "resize", "rotate"].includes(tool)) scene.setTransformMode(tool, select.value);
    }

    function setTool(nextTool) {
        tool = nextTool;
        toolButtons.forEach(button => button.classList.toggle("is-active", button.dataset.tool === tool));
        if (tool === "draw-box") {
            scene.detachTransformControls();
            scene.setOrbitEnabled(true);
            instructions.textContent = "Drag a rectangle around the visible object. Release to create a depth-filtered 3D seed box.";
            status.textContent = "Draw Box ready";
            return;
        }
        if (tool === "anchor" || tool === "focus") {
            scene.detachTransformControls();
            scene.setOrbitEnabled(true);
            instructions.textContent = `Click the real point-cloud surface to set ${tool === "anchor" ? "the relation anchor" : "the presentation focus"}.`;
            status.textContent = `Click point cloud to set ${tool}`;
            return;
        }
        scene.setTransformMode(tool, select.value);
        instructions.textContent = tool === "resize"
            ? "Drag the scale gizmo handles to resize the box."
            : tool === "rotate"
                ? "Drag the Y-axis rotation ring to change yaw."
                : "Drag the selected box gizmo. Orbit is paused while the gizmo is active.";
        status.textContent = `${tool[0].toUpperCase()}${tool.slice(1)} mode`;
    }

    function handlePointerDown(event) {
        if (tool !== "draw-box" || event.button !== 0) return false;
        drawing = true;
        drawStart = { x: event.clientX, y: event.clientY };
        scene.setOrbitEnabled(false);
        scene.showSelectionRectangle(drawStart, drawStart);
        event.preventDefault();
        return true;
    }

    function handlePointerMove(event) {
        if (!drawing) return false;
        scene.showSelectionRectangle(drawStart, { x: event.clientX, y: event.clientY });
        event.preventDefault();
        return true;
    }

    function handlePointerUp(event) {
        if (!drawing) return false;
        const end = { x: event.clientX, y: event.clientY };
        drawing = false;
        scene.hideSelectionRectangle();
        scene.setOrbitEnabled(true);
        const points = scene.selectPointCloudRectangle(drawStart, end, select.value);
        if (points.length >= 8 && scene.createBoxFromPoints(select.value, points)) {
            scene.highlightObject(select.value, { focus: false });
            writeForm(current());
            setTool("move");
            status.textContent = `Box seed created from ${points.length.toLocaleString()} filtered points`;
        } else {
            status.textContent = "No sufficient point-cloud sample in rectangle";
        }
        drawStart = null;
        event.preventDefault();
        return true;
    }

    function handleClick(event) {
        if (tool === "anchor" || tool === "focus") {
            const point = scene.pickPointAt(event.clientX, event.clientY, select.value);
            if (!point) {
                status.textContent = "No point-cloud surface found at that click";
                return true;
            }
            const kind = tool === "anchor" ? "anchor" : "focus";
            scene.setPresentationPointFromWorld(select.value, kind, point);
            writeForm(current());
            status.textContent = `${kind[0].toUpperCase()}${kind.slice(1)} saved from point-cloud click`;
            return true;
        }
        if (tool === "draw-box" || ["move", "resize", "rotate"].includes(tool)) return true;
        return false;
    }

    function applyNumeric() {
        const annotation = readForm();
        const finite = [...annotation.bbox.center, ...annotation.bbox.extent, ...annotation.anchor, ...annotation.focus, ...annotation.cameraOffset].every(Number.isFinite);
        if (!finite || annotation.bbox.extent.some(value => value <= 0)) {
            status.textContent = "Numeric values must be finite and extents must be positive";
            return;
        }
        scene.setEntryAnnotation(select.value, annotation);
        scene.setTransformMode(tool, select.value);
        status.textContent = "Applied in aligned_world frame";
    }

    function save() {
        const objects = {};
        scene.objectEntries.forEach(entry => { objects[entry.id] = scene.getAnnotation(entry.id); });
        const payload = {
            version: 2,
            coordinateFrame: "aligned_world",
            sourceCoordinateFrame: "scene.ply",
            worldAlignment: scene.presentation.worldAlignment || { enabled: true, quaternion: [0, 0, 0, 1], translation: [0, 0, 0] },
            annotationSource: "manual_real_scene_verification",
            objects
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(payload, null, 2));
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = "scene_presentation_manual_aligned.json";
        link.click();
        URL.revokeObjectURL(link.href);
        status.textContent = "All annotations saved locally and downloaded";
    }

    function saveCamera() {
        if (!scene.saveCurrentCamera(select.value)) {
            status.textContent = "Camera could not be saved";
            return;
        }
        writeForm(current());
        status.textContent = `Camera preset saved for ${select.options[select.selectedIndex]?.textContent || select.value}`;
    }

    function reloadSaved() {
        let payload;
        try { payload = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch { payload = {}; }
        const saved = payload.objects?.[select.value] || payload[select.value];
        if (!saved) {
            status.textContent = "No saved annotation for this object";
            return;
        }
        const annotation = saved.bbox ? saved : { bbox: { center: saved.center, extent: saved.extent, rotation: saved.rotation }, anchor: saved.anchor, focus: saved.focus, cameraOffset: saved.cameraOffset, camera: saved.camera };
        scene.setEntryAnnotation(select.value, annotation);
        writeForm(current());
        status.textContent = "Reloaded saved annotation";
    }

    function onSceneChanged(objectId) {
        if (String(objectId) === String(select.value)) writeForm(current());
    }

    select.addEventListener("change", selectObject);
    toolButtons.forEach(button => button.addEventListener("click", () => setTool(button.dataset.tool)));
    panel.querySelector('[data-action="apply"]').addEventListener("click", applyNumeric);
    panel.querySelector('[data-action="camera"]').addEventListener("click", saveCamera);
    panel.querySelector('[data-action="save"]').addEventListener("click", save);
    panel.querySelector('[data-action="reload"]').addEventListener("click", reloadSaved);

    scene.setAnnotationController({ handlePointerDown, handlePointerMove, handlePointerUp, handleClick, onSceneChanged, onTransformDragging: dragging => scene.setOrbitEnabled(!dragging) });
    if (select.options.length) selectObject();
    window.__spotDemo.annotationMode = { panel, save, reloadSaved, setTool, apply: applyNumeric };
    return { panel };
}

// Keep a small Three namespace reference in this module for consumers that
// import it while developing annotation plugins; all geometry work lives in SceneView.
export { THREE };
