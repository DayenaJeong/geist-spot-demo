// Reused/adapted from FunFact's Three.js point-cloud and OBB viewer.
// FunFact attribution: https://github.com/funfact-scenegraph/FunFact

import * as THREE from "three";
import { ConvexGeometry } from "three/addons/geometries/ConvexGeometry.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { PLYLoader } from "three/addons/loaders/PLYLoader.js";

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

const BOX_EDGES = [
    [0, 1], [0, 2], [1, 7], [2, 7],
    [3, 6], [3, 5], [4, 6], [4, 5],
    [0, 3], [1, 6], [2, 5], [4, 7]
];
const DEFAULT_SWITCH_COLOR = 0x3f8fc4;
const DEFAULT_LAMP_COLOR = 0xd49a2a;
const SELECTED_COLOR = 0x0d426a;
const RELATED_COLOR = 0x287da9;
const HOVER_COLOR = 0x155e91;

export class SceneView {
    constructor(container, placeholder, modeTag, { onObjectSelected, onObjectHovered = () => {} }) {
        this.container = container;
        this.placeholder = placeholder;
        this.modeTag = modeTag;
        this.onObjectSelected = onObjectSelected;
        this.onObjectHovered = onObjectHovered;
        this.objectEntries = new Map();
        this.raycastObjects = [];
        this.animationFrame = null;
        this.cameraTween = null;
        this.defaultTarget = new THREE.Vector3(0, 0, 0);
        this.defaultPosition = new THREE.Vector3(0, -2.8, 1.8);
        this.sceneBounds = null;
        this.pointCloudMetrics = null;
        this.hasPointCloud = false;
        this.hasBoundingBoxes = false;
        this.showBoundingBoxes = true;
        this.activeObjectId = null;
        this.hoveredObjectId = null;
        this.relatedObjectIds = new Set();
        this.presentation = {};
        this.renderer = null;
        this.camera = null;
        this.controls = null;
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color("#f4f7fa");

        try {
            this.initializeRenderer();
            this.startAnimation();
        } catch (error) {
            console.warn(`3D viewer unavailable; graph remains active: ${error.message}`);
            this.setStatus("3D scene data not loaded");
            this.modeTag.textContent = "3D UNAVAILABLE";
        }
    }

    initializeRenderer() {
        const width = Math.max(this.container.clientWidth, 1);
        const height = Math.max(this.container.clientHeight, 1);
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.renderer.setSize(width, height);
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.container.appendChild(this.renderer.domElement);

        this.camera = new THREE.PerspectiveCamera(40, width / height, 0.01, 5000);
        this.camera.up.set(0, 0, 1);
        this.camera.position.copy(this.defaultPosition);
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.screenSpacePanning = true;
        this.controls.rotateSpeed = 0.68;
        this.controls.panSpeed = 0.8;
        this.controls.zoomSpeed = 0.85;
        this.controls.minDistance = 0.35;
        this.controls.maxDistance = 80;
        this.controls.mouseButtons = {
            LEFT: THREE.MOUSE.ROTATE,
            MIDDLE: THREE.MOUSE.DOLLY,
            RIGHT: THREE.MOUSE.PAN
        };
        this.controls.target.copy(this.defaultTarget);
        this.controls.update();

        this.scene.add(new THREE.AmbientLight(0xffffff, 1.8));
        this.renderer.domElement.addEventListener("click", event => this.handleClick(event));
        this.renderer.domElement.addEventListener("pointermove", event => this.handlePointerMove(event));
        this.renderer.domElement.addEventListener("pointerleave", () => this.setHoveredObject(null));
        window.addEventListener("resize", () => this.resize());
    }

    async loadManifest(manifest) {
        this.clearGeometry();
        this.manifest = manifest || null;
        this.presentation = manifest?.presentation || {};
        if (!this.renderer || !manifest) {
            this.setStatus("3D scene data not loaded");
            return;
        }

        const manifestUrl = manifest.__sourceUrl || window.location.href;
        const objectMetadata = Array.isArray(manifest.objects) ? manifest.objects : [];
        if (manifest.pointcloud) this.loadPointCloud(new URL(manifest.pointcloud, manifestUrl).toString());
        const boundingBoxes = await this.collectBoundingBoxes(objectMetadata, manifest, manifestUrl);
        boundingBoxes.forEach(record => this.createBoundingBox(record, objectMetadata));

        if (!this.hasPointCloud && !this.hasBoundingBoxes) {
            this.setStatus("3D scene data not loaded");
            this.modeTag.textContent = "EMPTY DATA MODE";
        } else {
            this.modeTag.textContent = "SCENE DATA READY";
            this.setStatus("Scene data loaded · click an object to select");
            this.applyInitialView();
        }
    }

    async collectBoundingBoxes(objectMetadata, manifest, manifestUrl) {
        const records = [];
        if (Array.isArray(manifest.bounding_boxes)) records.push(...manifest.bounding_boxes);
        if (manifest.objects_file) {
            try {
                const response = await fetch(new URL(manifest.objects_file, manifestUrl));
                if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
                const payload = await response.json();
                (Array.isArray(payload.objects) ? payload.objects : []).forEach(object => {
                    if (object && Array.isArray(object.vertices)) records.push({ ...object, id: object.id, name: object.label || object.name || object.id });
                });
            } catch (error) {
                console.warn(`Object metadata unavailable; continuing with manifest boxes: ${error.message}`);
            }
        }
        for (const object of objectMetadata) {
            if (object.bounding_box && Array.isArray(object.bounding_box.vertices)) {
                records.push({ ...object.bounding_box, id: object.id, name: object.label });
                continue;
            }
            if (!object.bbox_file) continue;
            try {
                const response = await fetch(new URL(object.bbox_file, manifestUrl));
                if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
                const payload = await response.json();
                const payloadBoxes = Array.isArray(payload.bounding_boxes) ? payload.bounding_boxes : [payload];
                const match = payloadBoxes.find(box => String(box.id) === String(object.id)) || payloadBoxes[0];
                if (match) records.push({ ...match, id: object.id, name: object.label });
            } catch (error) {
                console.warn(`Bounding box unavailable for ${object.id}: ${error.message}`);
            }
        }
        return records;
    }

    loadPointCloud(pointcloudUrl) {
        const loader = new PLYLoader();
        loader.load(pointcloudUrl, geometry => {
            if (geometry.attributes.position === undefined) throw new Error("PLY has no position attribute");
            geometry.computeBoundingBox();
            geometry.computeBoundingSphere();
            const pointSize = this.computePointSize(geometry);
            const material = new THREE.PointsMaterial({
                size: pointSize,
                vertexColors: Boolean(geometry.attributes.color),
                color: geometry.attributes.color ? 0xffffff : 0x6f879a,
                sizeAttenuation: true
            });
            const pointCloud = new THREE.Points(geometry, material);
            pointCloud.name = "spot-point-cloud";
            this.scene.add(pointCloud);
            this.pointCloudMetrics = {
                pointCount: geometry.attributes.position.count,
                min: geometry.boundingBox.min.clone(),
                max: geometry.boundingBox.max.clone(),
                extent: geometry.boundingBox.getSize(new THREE.Vector3()),
                center: geometry.boundingBox.getCenter(new THREE.Vector3()),
                boundingSphereRadius: geometry.boundingSphere?.radius || 0,
                pointSize
            };
            this.hasPointCloud = true;
            this.modeTag.textContent = "SCENE DATA READY";
            this.setStatus("Point cloud loaded · click an object to select");
            this.addCoordinateAxes(geometry);
            this.applyInitialView();
        }, undefined, error => {
            console.warn(`Point cloud unavailable; continuing without it: ${error.message || error}`);
            this.setStatus(this.hasBoundingBoxes ? "Bounding boxes loaded · point cloud unavailable" : "3D scene data not loaded");
        });
    }

    createBoundingBox(record, objectMetadata) {
        if (!Array.isArray(record.vertices) || record.vertices.length < 8) {
            console.warn(`Skipping invalid bounding box for ${record.id || "unknown object"}`);
            return;
        }
        const objectId = this.resolveObjectId(record.id, objectMetadata);
        const vertices = record.vertices.map(vertex => new THREE.Vector3(vertex[0], vertex[1], vertex[2]));
        const objectPresentation = this.presentation.objects?.[objectId] || {};
        const center = new THREE.Box3().setFromPoints(vertices).getCenter(new THREE.Vector3());
        const anchorPoint = this.toVector(objectPresentation.anchor, center);
        const focusPoint = this.toVector(objectPresentation.focus, center);
        const cameraOffset = this.toVector(objectPresentation.camera_offset, null);
        const edgeVertices = [];
        BOX_EDGES.forEach(([start, end]) => edgeVertices.push(vertices[start], vertices[end]));
        const baseColor = this.parseColor(record.color_metadata || objectPresentation.display_color || (objectId === "lamp" ? DEFAULT_LAMP_COLOR : DEFAULT_SWITCH_COLOR));
        const lineGeometry = new THREE.BufferGeometry().setFromPoints(edgeVertices);
        const wireframe = new THREE.LineSegments(lineGeometry, new THREE.LineBasicMaterial({ color: baseColor, transparent: true, opacity: 0.92 }));
        wireframe.userData = { objectId, objectName: record.name || record.label || objectId, originalColor: baseColor };
        wireframe.renderOrder = 4;

        const hull = new ConvexGeometry(vertices);
        const fillMesh = new THREE.Mesh(hull.clone(), new THREE.MeshBasicMaterial({ color: baseColor, transparent: true, opacity: 0.055, depthWrite: false, side: THREE.DoubleSide }));
        fillMesh.renderOrder = 2;
        const hitMesh = new THREE.Mesh(hull, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
        hitMesh.renderOrder = 1;
        hitMesh.userData = { objectId, objectName: record.name || record.label || objectId, wireframe };

        const extent = new THREE.Box3().setFromPoints(vertices).getSize(new THREE.Vector3());
        const markerRadius = Math.max(Math.max(extent.x, extent.y, extent.z) * 0.075, 0.025);
        const markerGeometry = new THREE.SphereGeometry(markerRadius, 8, 6);
        const markerMaterial = new THREE.MeshBasicMaterial({ color: baseColor, transparent: true, opacity: 0.9, depthWrite: false });
        const cornerMarkers = new THREE.Group();
        cornerMarkers.name = `${objectId}-bbox-corners`;
        vertices.forEach(vertex => {
            const marker = new THREE.Mesh(markerGeometry, markerMaterial);
            marker.position.copy(vertex);
            cornerMarkers.add(marker);
        });
        cornerMarkers.renderOrder = 5;

        const anchorMarker = new THREE.Mesh(new THREE.SphereGeometry(markerRadius * 1.35, 10, 8), new THREE.MeshBasicMaterial({ color: baseColor, transparent: true, opacity: 1, depthWrite: false }));
        anchorMarker.position.copy(anchorPoint);
        anchorMarker.renderOrder = 6;
        const anchorGeometry = new THREE.BufferGeometry().setFromPoints([center, anchorPoint]);
        const anchorGuide = new THREE.LineSegments(anchorGeometry, new THREE.LineBasicMaterial({ color: baseColor, transparent: true, opacity: 0.4, depthWrite: false }));
        anchorGuide.renderOrder = 3;

        this.scene.add(fillMesh, wireframe, hitMesh, cornerMarkers, anchorMarker, anchorGuide);
        this.raycastObjects.push(hitMesh);
        const entry = {
            id: objectId,
            wireframe,
            fillMesh,
            hitMesh,
            cornerMarkers,
            anchorMarker,
            anchorGuide,
            vertices,
            center,
            anchorPoint,
            focusPoint,
            cameraOffset,
            originalColor: baseColor,
            annotation: { center: center.toArray(), extent: extent.toArray(), rotation: [0, 0, 0] },
            presentation: { anchor: anchorPoint.toArray(), focus: focusPoint.toArray(), cameraOffset: cameraOffset?.toArray() || null },
            visible: this.showBoundingBoxes
        };
        this.objectEntries.set(objectId, entry);
        this.hasBoundingBoxes = true;
        this.modeTag.textContent = "SCENE DATA READY";
        this.updatePlaceholder();
        this.updateEntryVisual(entry);
    }

    resolveObjectId(candidate, objectMetadata) {
        const value = String(candidate || "");
        const match = objectMetadata.find(object => [object.id, object.label, ...(object.aliases || [])].map(String).includes(value));
        return match ? String(match.id) : value;
    }

    highlightObject(objectId, { focus = true } = {}) {
        this.activeObjectId = objectId ? String(objectId) : null;
        this.objectEntries.forEach(entry => this.updateEntryVisual(entry));
        if (!this.activeObjectId || !this.objectEntries.has(this.activeObjectId)) return;
        if (focus) this.focusOnObject(this.objectEntries.get(this.activeObjectId));
    }

    setRelatedObjects(objectIds = []) {
        this.relatedObjectIds = new Set(objectIds.map(String));
        this.objectEntries.forEach(entry => this.updateEntryVisual(entry));
    }

    setHoveredObject(objectId) {
        const normalized = objectId ? String(objectId) : null;
        if (normalized === this.hoveredObjectId) return;
        this.hoveredObjectId = normalized;
        this.objectEntries.forEach(entry => this.updateEntryVisual(entry));
        this.onObjectHovered(normalized);
        if (this.renderer) this.renderer.domElement.style.cursor = normalized ? "pointer" : "grab";
    }

    clearSelection() {
        this.activeObjectId = null;
        this.relatedObjectIds.clear();
        this.objectEntries.forEach(entry => this.updateEntryVisual(entry));
    }

    toggleBoundingBoxes() {
        this.setBoundingBoxesVisible(!this.showBoundingBoxes);
        return this.showBoundingBoxes;
    }

    setBoundingBoxesVisible(visible) {
        this.showBoundingBoxes = Boolean(visible);
        this.objectEntries.forEach(entry => {
            entry.visible = this.showBoundingBoxes;
            this.updateEntryVisual(entry);
        });
    }

    updateEntryVisual(entry) {
        const selected = entry.id === this.activeObjectId;
        const related = this.relatedObjectIds.has(entry.id) && !selected;
        const hovered = entry.id === this.hoveredObjectId && !selected;
        const color = selected ? SELECTED_COLOR : hovered ? HOVER_COLOR : related ? RELATED_COLOR : entry.originalColor;
        entry.wireframe.material.color.setHex(color);
        entry.wireframe.material.opacity = selected ? 1 : hovered ? 1 : related ? 0.98 : 0.92;
        entry.fillMesh.material.color.setHex(color);
        entry.fillMesh.material.opacity = selected ? 0.18 : hovered ? 0.12 : related ? 0.085 : 0.055;
        entry.anchorMarker.material.color.setHex(color);
        entry.anchorMarker.material.opacity = selected ? 1 : hovered ? 1 : related ? 0.95 : 0.9;
        entry.anchorGuide.material.color.setHex(color);
        entry.anchorGuide.material.opacity = selected ? 0.75 : related ? 0.48 : 0.35;
        entry.cornerMarkers.children.forEach(marker => {
            marker.material.color.setHex(color);
            marker.material.opacity = selected ? 1 : hovered ? 1 : related ? 0.95 : 0.86;
        });
        const visible = this.showBoundingBoxes && entry.visible;
        entry.wireframe.visible = visible;
        entry.fillMesh.visible = visible;
        entry.cornerMarkers.visible = visible;
        entry.anchorMarker.visible = visible;
        entry.anchorGuide.visible = visible;
        entry.hitMesh.visible = visible;
    }

    focusOnObject(entry) {
        if (!this.camera || !this.controls) return;
        const target = entry.focusPoint?.clone() || entry.center.clone();
        let position;
        if (entry.cameraOffset) {
            position = target.clone().add(entry.cameraOffset);
        } else {
            const bounds = new THREE.Box3().setFromObject(entry.hitMesh);
            const size = bounds.getSize(new THREE.Vector3());
            const distance = Math.max(Math.max(size.x, size.y, size.z, 0.1) * (this.presentation.camera?.object_distance_scale || 2.8), 1.3);
            const direction = this.camera.getWorldDirection(new THREE.Vector3()).negate();
            position = target.clone().add(direction.multiplyScalar(distance));
        }
        this.flyTo(position, target);
    }

    focusDemoArea({ animate = true } = {}) {
        const configured = this.presentation.camera?.demo_area;
        if (configured?.target && configured?.position) {
            this.applyCameraFov(configured.fov);
            const target = this.toVector(configured.target, this.defaultTarget);
            const position = this.toVector(configured.position, this.defaultPosition);
            if (animate) this.flyTo(position, target);
            else this.setCameraView(position, target);
            return;
        }
        const points = [...this.objectEntries.values()].map(entry => entry.focusPoint || entry.center);
        if (!points.length) return this.frameScene();
        const bounds = new THREE.Box3().setFromPoints(points);
        const target = bounds.getCenter(new THREE.Vector3());
        const size = bounds.getSize(new THREE.Vector3());
        const distance = Math.max(size.length() * 1.5, 3);
        const position = target.clone().add(new THREE.Vector3(0.65, -1, 0.45).normalize().multiplyScalar(distance));
        if (animate) this.flyTo(position, target);
        else this.setCameraView(position, target);
    }

    resetView() {
        this.focusDemoArea({ animate: false });
    }

    applyInitialView() {
        if (this.presentation.camera?.demo_area) this.focusDemoArea({ animate: false });
        else this.frameScene();
    }

    setCameraView(position, target) {
        if (!this.camera || !this.controls) return;
        this.cameraTween = null;
        this.controls.enabled = true;
        this.camera.position.copy(position);
        this.controls.target.copy(target);
        this.controls.update();
    }

    flyTo(position, target) {
        if (!this.camera || !this.controls) return;
        this.cameraTween = {
            started: performance.now(),
            duration: Number(this.presentation.camera?.transition_ms) || 720,
            fromPosition: this.camera.position.clone(),
            fromTarget: this.controls.target.clone(),
            toPosition: position.clone(),
            toTarget: target.clone()
        };
        this.controls.enabled = false;
    }

    updateCameraTween(now) {
        if (!this.cameraTween) return;
        const tween = this.cameraTween;
        const raw = Math.min((now - tween.started) / tween.duration, 1);
        const eased = raw < 0.5 ? 4 * raw * raw * raw : 1 - Math.pow(-2 * raw + 2, 3) / 2;
        this.camera.position.lerpVectors(tween.fromPosition, tween.toPosition, eased);
        this.controls.target.lerpVectors(tween.fromTarget, tween.toTarget, eased);
        this.controls.update();
        if (raw >= 1) {
            this.cameraTween = null;
            this.controls.enabled = true;
        }
    }

    handleClick(event) {
        const objectId = this.raycastObjectAt(event.clientX, event.clientY);
        this.onObjectSelected(objectId, { source: "scene" });
    }

    handlePointerMove(event) {
        this.setHoveredObject(this.raycastObjectAt(event.clientX, event.clientY));
    }

    raycastObjectAt(clientX, clientY) {
        if (!this.renderer || !this.camera || !this.raycastObjects.length) return null;
        const rect = this.renderer.domElement.getBoundingClientRect();
        const mouse = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, this.camera);
        const intersections = raycaster.intersectObjects(this.raycastObjects.filter(object => object.visible), true);
        return intersections.length ? String(intersections[0].object.userData.objectId) : null;
    }

    updatePresentationPoints(objectId, points = {}) {
        const entry = this.objectEntries.get(String(objectId));
        if (!entry) return;
        if (Array.isArray(points.anchor) && points.anchor.every(Number.isFinite)) entry.anchorPoint.set(...points.anchor);
        if (Array.isArray(points.focus) && points.focus.every(Number.isFinite)) entry.focusPoint.set(...points.focus);
        if (Array.isArray(points.cameraOffset) && points.cameraOffset.every(Number.isFinite)) entry.cameraOffset = new THREE.Vector3(...points.cameraOffset);
        entry.presentation = { anchor: entry.anchorPoint.toArray(), focus: entry.focusPoint.toArray(), cameraOffset: entry.cameraOffset?.toArray() || null };
        entry.anchorMarker.position.copy(entry.anchorPoint);
        entry.anchorGuide.geometry.dispose();
        entry.anchorGuide.geometry = new THREE.BufferGeometry().setFromPoints([entry.center, entry.anchorPoint]);
        this.updateEntryVisual(entry);
    }

    addCoordinateAxes(geometry) {
        geometry.computeBoundingBox();
        const bounds = geometry.boundingBox;
        if (!bounds) return;
        const center = bounds.getCenter(new THREE.Vector3());
        const size = bounds.getSize(new THREE.Vector3());
        const axes = new THREE.AxesHelper(Math.max(size.x, size.y, size.z) * 0.12);
        axes.position.copy(center);
        axes.name = "scene-coordinate-axes";
        this.scene.add(axes);
    }

    computePointSize(geometry) {
        const extent = geometry.boundingBox?.getSize(new THREE.Vector3());
        const maxDimension = extent ? Math.max(extent.x, extent.y, extent.z) : 1;
        const scaleAwareSize = THREE.MathUtils.clamp(maxDimension * 0.0002, 0.0005, 0.004);
        const sourceSize = geometry.attributes.size?.array?.[0];
        return Number.isFinite(sourceSize) && sourceSize > 0 ? Math.min(sourceSize, scaleAwareSize) : scaleAwareSize;
    }

    getRenderableBounds() {
        const bounds = new THREE.Box3();
        this.scene.traverse(object => {
            if (object.name === "spot-point-cloud" || object.type === "LineSegments") bounds.expandByObject(object);
        });
        return bounds.isEmpty() ? null : bounds;
    }

    frameScene() {
        if (!this.camera || !this.controls) return;
        const bounds = this.getRenderableBounds();
        if (!bounds) return;
        this.sceneBounds = bounds.clone();
        const center = bounds.getCenter(new THREE.Vector3());
        const size = bounds.getSize(new THREE.Vector3());
        const sphereRadius = Math.max(size.length() * 0.5, 0.1);
        const verticalFov = THREE.MathUtils.degToRad(this.camera.fov);
        const horizontalFov = 2 * Math.atan(Math.tan(verticalFov * 0.5) * this.camera.aspect);
        const fitDistance = Math.max(sphereRadius / Math.tan(verticalFov * 0.5), sphereRadius / Math.tan(horizontalFov * 0.5)) * 1.2;
        const obliqueDirection = new THREE.Vector3(1, -1, 0.65).normalize();
        this.defaultTarget.copy(center);
        this.defaultPosition.copy(center).addScaledVector(obliqueDirection, fitDistance);
        this.camera.up.set(0, 0, 1);
        this.camera.near = Math.max(0.01, fitDistance * 0.01);
        this.camera.far = Math.max(5000, fitDistance + sphereRadius * 4);
        this.camera.updateProjectionMatrix();
        this.setCameraView(this.defaultPosition, this.defaultTarget);
    }

    clearGeometry() {
        this.objectEntries.clear();
        this.raycastObjects = [];
        this.hasPointCloud = false;
        this.hasBoundingBoxes = false;
        if (!this.scene) return;
        const removable = [];
        this.scene.traverse(object => {
            if (object.name === "spot-point-cloud" || object.name === "scene-coordinate-axes" || object.type === "LineSegments" || object.type === "Mesh" || object.type === "Group") removable.push(object);
        });
        removable.forEach(object => {
            if (object.parent) object.parent.remove(object);
            object.geometry?.dispose();
            if (Array.isArray(object.material)) object.material.forEach(material => material.dispose());
            else object.material?.dispose();
        });
        this.updatePlaceholder();
    }

    parseColor(value) {
        if (typeof value === "number") return value;
        if (typeof value === "string") return new THREE.Color(value).getHex();
        if (value && typeof value.hex === "string") return new THREE.Color(value.hex).getHex();
        return DEFAULT_SWITCH_COLOR;
    }

    toVector(value, fallback) {
        return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)
            ? new THREE.Vector3(...value)
            : fallback?.clone?.() || fallback;
    }

    updatePlaceholder() {
        this.placeholder.hidden = !this.hasPointCloud && !this.hasBoundingBoxes;
    }

    setStatus(message) {
        this.placeholder.querySelector("strong").textContent = message;
        this.updatePlaceholder();
    }

    applyCameraFov(fov) {
        if (!this.camera || !Number.isFinite(Number(fov))) return;
        this.camera.fov = Number(fov);
        this.camera.updateProjectionMatrix();
    }

    resize() {
        if (!this.renderer || !this.camera) return;
        const width = Math.max(this.container.clientWidth, 1);
        const height = Math.max(this.container.clientHeight, 1);
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height);
    }

    startAnimation() {
        if (!this.renderer) return;
        const animate = now => {
            this.animationFrame = requestAnimationFrame(animate);
            this.updateCameraTween(now);
            this.controls?.update();
            this.renderer.render(this.scene, this.camera);
        };
        animate(performance.now());
    }
}
