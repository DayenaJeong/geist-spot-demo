import * as THREE from "three";
import { ConvexGeometry } from "three/addons/geometries/ConvexGeometry.js";

const STORAGE_KEY = "spot-demo-manual-annotations-v1";
const BOX_EDGES = [
    [0, 1], [0, 2], [1, 7], [2, 7],
    [3, 6], [3, 5], [4, 6], [4, 5],
    [0, 3], [1, 6], [2, 5], [4, 7]
];

export function setupAnnotationMode({ data, scene }) {
    document.body.dataset.annotationMode = "true";
    const panel = document.createElement("section");
    panel.className = "annotation-panel";
    panel.setAttribute("aria-label", "Manual real-scene annotation");
    panel.innerHTML = `
        <div class="annotation-heading">
            <div>
                <p class="panel-kicker">MANUAL REAL-SCENE ANNOTATION</p>
                <h2>Editable PLY-frame boxes</h2>
            </div>
            <span class="panel-tag">scene.ply coordinates</span>
        </div>
        <div class="annotation-controls">
            <label>Object <select data-annotation-object></select></label>
            <fieldset><legend>Center</legend>
                <label>X <input data-field="cx" type="number" step="0.001"></label>
                <label>Y <input data-field="cy" type="number" step="0.001"></label>
                <label>Z <input data-field="cz" type="number" step="0.001"></label>
            </fieldset>
            <fieldset><legend>Extent</legend>
                <label>X <input data-field="ex" type="number" min="0.001" step="0.001"></label>
                <label>Y <input data-field="ey" type="number" min="0.001" step="0.001"></label>
                <label>Z <input data-field="ez" type="number" min="0.001" step="0.001"></label>
            </fieldset>
            <label>Yaw <input data-field="yaw" type="number" step="0.1"></label>
            <button type="button" data-action="apply">Apply</button>
            <button type="button" data-action="save">Save</button>
            <button type="button" data-action="reload">Reload saved</button>
            <span class="annotation-status" data-annotation-status aria-live="polite"></span>
        </div>
    `;
    document.querySelector(".app-shell").insertBefore(panel, document.querySelector(".app-footer"));

    const select = panel.querySelector("[data-annotation-object]");
    const fields = Object.fromEntries([...panel.querySelectorAll("[data-field]")].map(input => [input.dataset.field, input]));
    const status = panel.querySelector("[data-annotation-status]");
    data.objects.forEach(object => {
        const option = document.createElement("option");
        option.value = object.id;
        option.textContent = object.label;
        select.appendChild(option);
    });

    function annotationFromEntry(entry) {
        const array = entry.wireframe.geometry.attributes.position.array;
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < array.length; i += 3) {
            for (let axis = 0; axis < 3; axis += 1) {
                min[axis] = Math.min(min[axis], array[i + axis]);
                max[axis] = Math.max(max[axis], array[i + axis]);
            }
        }
        return {
            center: min.map((value, axis) => (value + max[axis]) / 2),
            extent: min.map((value, axis) => Math.max(max[axis] - value, 0.001)),
            rotation: [0, 0, 0]
        };
    }

    function readForm() {
        return {
            center: [Number(fields.cx.value), Number(fields.cy.value), Number(fields.cz.value)],
            extent: [Number(fields.ex.value), Number(fields.ey.value), Number(fields.ez.value)],
            rotation: [0, 0, Number(fields.yaw.value) || 0]
        };
    }

    function writeForm(annotation) {
        [fields.cx.value, fields.cy.value, fields.cz.value] = annotation.center.map(value => value.toFixed(6));
        [fields.ex.value, fields.ey.value, fields.ez.value] = annotation.extent.map(value => value.toFixed(6));
        fields.yaw.value = String(annotation.rotation?.[2] || 0);
    }

    function current(id = select.value) {
        const entry = scene.objectEntries.get(id);
        return entry?.annotation || annotationFromEntry(entry);
    }

    function selectObject() {
        writeForm(current());
        status.textContent = `Editing ${select.options[select.selectedIndex].textContent}`;
    }

    function apply() {
        const annotation = readForm();
        if (!annotation.center.every(Number.isFinite) || !annotation.extent.every(value => Number.isFinite(value) && value > 0)) {
            status.textContent = "Enter finite center and positive extent values";
            return;
        }
        applyToScene(scene, select.value, annotation);
        status.textContent = "Applied in scene.ply frame";
    }

    function readSaved() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
        } catch {
            return {};
        }
    }

    function save() {
        const saved = readSaved();
        saved[select.value] = readForm();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(saved, null, 2));
        const blob = new Blob([JSON.stringify(saved, null, 2)], { type: "application/json" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = "objects_manual_annotations.json";
        link.click();
        URL.revokeObjectURL(link.href);
        status.textContent = "Saved locally and downloaded";
    }

    function reloadSaved() {
        const saved = readSaved();
        if (!saved[select.value]) {
            status.textContent = "No saved annotation for this object";
            return;
        }
        applyToScene(scene, select.value, saved[select.value]);
        writeForm(saved[select.value]);
        status.textContent = "Reloaded saved annotation";
    }

    select.addEventListener("change", selectObject);
    panel.querySelector('[data-action="apply"]').addEventListener("click", apply);
    panel.querySelector('[data-action="save"]').addEventListener("click", save);
    panel.querySelector('[data-action="reload"]').addEventListener("click", reloadSaved);
    selectObject();
    window.__spotDemo.annotationMode = { apply, save, reloadSaved, panel };
    return { panel };
}

function boxVertices(annotation) {
    const [cx, cy, cz] = annotation.center;
    const [sx, sy, sz] = annotation.extent.map(value => value / 2);
    const yaw = (annotation.rotation?.[2] || 0) * Math.PI / 180;
    const local = [
        [-sx, -sy, -sz], [sx, -sy, -sz], [-sx, sy, -sz], [-sx, -sy, sz],
        [sx, sy, sz], [-sx, sy, sz], [sx, sy, -sz], [sx, -sy, sz]
    ];
    return local.map(([x, y, z]) => [
        cx + x * Math.cos(yaw) - y * Math.sin(yaw),
        cy + x * Math.sin(yaw) + y * Math.cos(yaw),
        cz + z
    ]);
}

function applyToScene(scene, objectId, annotation) {
    const entry = scene.objectEntries.get(objectId);
    if (!entry) return;
    const vertices = boxVertices(annotation);
    const edgeVertices = [];
    BOX_EDGES.forEach(([start, end]) => edgeVertices.push(vertices[start], vertices[end]));
    entry.wireframe.geometry.dispose();
    entry.wireframe.geometry = new THREE.BufferGeometry().setFromPoints(edgeVertices.map(point => new THREE.Vector3(...point)));
    entry.wireframe.geometry.computeBoundingSphere();
    entry.hitMesh.geometry.dispose();
    entry.hitMesh.geometry = new ConvexGeometry(vertices.map(point => new THREE.Vector3(...point)));
    entry.center.set(...annotation.center);
    entry.annotation = JSON.parse(JSON.stringify(annotation));
    entry.vertices = vertices;
    scene.frameScene();
}
