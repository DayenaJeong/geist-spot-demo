// Reused/adapted from FunFact's Three.js point-cloud and OBB viewer.
// FunFact attribution: https://github.com/funfact-scenegraph/FunFact

import * as THREE from "three";
import { ConvexGeometry } from "three/addons/geometries/ConvexGeometry.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { PLYLoader } from "three/addons/loaders/PLYLoader.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";

// The Spot PLY is already Y-up. Keep one explicit root so a future alignment
// can be changed in one place without independently rotating annotations.
THREE.Object3D.DEFAULT_UP.set(0, 1, 0);

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
    constructor(container, placeholder, modeTag, {
        onObjectSelected,
        onObjectHovered = () => {},
        debugMode = false,
        annotationMode = false
    }) {
        this.container = container;
        this.placeholder = placeholder;
        this.modeTag = modeTag;
        this.onObjectSelected = onObjectSelected;
        this.onObjectHovered = onObjectHovered;
        this.debugMode = Boolean(debugMode);
        this.annotationMode = Boolean(annotationMode);
        this.annotationController = null;
        this.objectEntries = new Map();
        this.raycastObjects = [];
        this.pointCloud = null;
        this.animationFrame = null;
        this.cameraTween = null;
        this.defaultTarget = new THREE.Vector3(0, 0, 0);
        this.defaultPosition = new THREE.Vector3(0, 1.5, 4);
        this.sceneBounds = null;
        this.pointCloudMetrics = null;
        this.hasPointCloud = false;
        this.hasBoundingBoxes = false;
        this.showBoundingBoxes = true;
        this.activeObjectId = null;
        this.hoveredObjectId = null;
        this.relatedObjectIds = new Set();
        this.presentation = {};
        this.worldMetrics = {};
        this.renderer = null;
        this.camera = null;
        this.controls = null;
        this.transformControls = null;
        this.transformMode = "translate";
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color("#f4f7fa");
        this.worldRoot = new THREE.Group();
        this.worldRoot.name = "worldRoot";
        this.scene.add(this.worldRoot);
        this.debugRoot = new THREE.Group();
        this.debugRoot.name = "world-debug-helpers";
        this.worldRoot.add(this.debugRoot);
        this.debugOverlay = null;

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
        this.camera.up.set(0, 1, 0);
        this.camera.position.copy(this.defaultPosition);
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.screenSpacePanning = false;
        this.controls.rotateSpeed = 0.68;
        this.controls.panSpeed = 0.8;
        this.controls.zoomSpeed = 0.85;
        this.controls.minDistance = 0.35;
        this.controls.maxDistance = 80;
        this.controls.minPolarAngle = THREE.MathUtils.degToRad(14);
        this.controls.maxPolarAngle = THREE.MathUtils.degToRad(82);
        this.controls.mouseButtons = {
            LEFT: THREE.MOUSE.ROTATE,
            MIDDLE: THREE.MOUSE.DOLLY,
            RIGHT: THREE.MOUSE.PAN
        };
        this.controls.target.copy(this.defaultTarget);
        this.controls.update();

        this.transformControls = new TransformControls(this.camera, this.renderer.domElement);
        this.transformControls.visible = false;
        this.transformControls.setSpace("local");
        this.transformControls.addEventListener("dragging-changed", event => {
            if (this.annotationController?.onTransformDragging) this.annotationController.onTransformDragging(event.value);
            this.setOrbitEnabled(!event.value);
        });
        this.transformControls.addEventListener("objectChange", () => {
            if (!this.transformControls.object) return;
            const entry = [...this.objectEntries.values()].find(item => item.group === this.transformControls.object);
            if (!entry) return;
            if (this.transformMode === "rotate") {
                entry.group.rotation.x = 0;
                entry.group.rotation.z = 0;
            }
            this.syncEntryFromTransform(entry);
            this.annotationController?.onSceneChanged?.(entry.id);
        });
        this.scene.add(this.transformControls.getHelper());

        this.scene.add(new THREE.AmbientLight(0xffffff, 1.8));
        this.renderer.domElement.addEventListener("pointerdown", event => this.handlePointerDown(event));
        this.renderer.domElement.addEventListener("pointermove", event => this.handlePointerMove(event));
        this.renderer.domElement.addEventListener("pointerup", event => this.handlePointerUp(event));
        this.renderer.domElement.addEventListener("click", event => this.handleClick(event));
        this.renderer.domElement.addEventListener("pointerleave", () => this.setHoveredObject(null));
        window.addEventListener("resize", () => this.resize());

        if (this.debugMode) this.createDebugOverlay();
    }

    async loadManifest(manifest) {
        this.clearGeometry();
        this.manifest = manifest || null;
        this.presentation = manifest?.presentation || {};
        this.applyWorldAlignment();
        if (!this.renderer || !manifest) {
            this.setStatus("3D scene data not loaded");
            return;
        }

        const manifestUrl = manifest.__sourceUrl || window.location.href;
        const objectMetadata = Array.isArray(manifest.objects) ? manifest.objects : [];
        const pointCloudPromise = manifest.pointcloud
            ? this.loadPointCloud(new URL(manifest.pointcloud, manifestUrl).toString())
            : Promise.resolve(false);
        const boundingBoxes = await this.collectBoundingBoxes(objectMetadata, manifest, manifestUrl);
        boundingBoxes.forEach(record => this.createBoundingBox(record, objectMetadata));
        await pointCloudPromise;
        this.applyWorldAlignment();

        if (!this.hasPointCloud && !this.hasBoundingBoxes) {
            this.setStatus("3D scene data not loaded");
            this.modeTag.textContent = "EMPTY DATA MODE";
        } else {
            this.modeTag.textContent = "SCENE DATA READY";
            this.setStatus("SCENE DATA READY");
            this.applyInitialView();
            this.updateWorldMetrics();
            this.updateDebugHelpers();
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
        return new Promise(resolve => {
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
                this.pointCloud = new THREE.Points(geometry, material);
                this.pointCloud.name = "spot-point-cloud";
                this.pointCloud.frustumCulled = true;
                this.worldRoot.add(this.pointCloud);
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
                this.addCoordinateAxes(geometry);
                resolve(true);
            }, undefined, error => {
                console.warn(`Point cloud unavailable; continuing without it: ${error.message || error}`);
                this.setStatus(this.hasBoundingBoxes ? "Bounding boxes loaded · point cloud unavailable" : "3D scene data not loaded");
                resolve(false);
            });
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
        const extent = new THREE.Box3().setFromPoints(vertices).getSize(new THREE.Vector3());
        const anchorPoint = this.toVector(objectPresentation.anchor, center);
        const focusPoint = this.toVector(objectPresentation.focus, center);
        const cameraOffset = this.toVector(objectPresentation.camera_offset, null);
        const baseColor = this.parseColor(record.color_metadata || objectPresentation.display_color || (objectId === "lamp" ? DEFAULT_LAMP_COLOR : DEFAULT_SWITCH_COLOR));
        const group = new THREE.Group();
        group.name = `${objectId}-bbox-editable`;
        group.position.copy(center);
        const localVertices = vertices.map(vertex => vertex.clone().sub(center));
        const visual = this.createBoxVisual(objectId, record.name || record.label || objectId, localVertices, anchorPoint.clone().sub(center), baseColor, extent);
        Object.values(visual).forEach(object => group.add(object));
        this.worldRoot.add(group);
        this.raycastObjects.push(visual.hitMesh);
        const entry = {
            id: objectId,
            group,
            wireframe: visual.wireframe,
            fillMesh: visual.fillMesh,
            hitMesh: visual.hitMesh,
            cornerMarkers: visual.cornerMarkers,
            anchorMarker: visual.anchorMarker,
            anchorGuide: visual.anchorGuide,
            vertices,
            baseLocalVertices: localVertices.map(vertex => vertex.clone()),
            center,
            extent,
            anchorLocal: anchorPoint.clone().sub(center),
            focusLocal: focusPoint.clone().sub(center),
            anchorPoint,
            focusPoint,
            cameraOffset,
            camera: objectPresentation.camera || null,
            originalColor: baseColor,
            annotation: { center: center.toArray(), extent: extent.toArray(), rotation: [0, 0, 0] },
            presentation: { anchor: anchorPoint.toArray(), focus: focusPoint.toArray(), cameraOffset: cameraOffset?.toArray() || null, camera: objectPresentation.camera || null },
            visible: this.showBoundingBoxes
        };
        this.objectEntries.set(objectId, entry);
        this.hasBoundingBoxes = true;
        this.modeTag.textContent = "SCENE DATA READY";
        this.updatePlaceholder();
        this.updateEntryVisual(entry);
    }

    createBoxVisual(objectId, objectName, localVertices, localAnchor, baseColor, extent) {
        const edgeVertices = [];
        BOX_EDGES.forEach(([start, end]) => edgeVertices.push(localVertices[start], localVertices[end]));
        const lineGeometry = new THREE.BufferGeometry().setFromPoints(edgeVertices);
        const wireframe = new THREE.LineSegments(lineGeometry, new THREE.LineBasicMaterial({ color: baseColor, transparent: true, opacity: 0.92, depthTest: false }));
        wireframe.userData = { objectId, objectName, originalColor: baseColor };
        wireframe.renderOrder = 20;

        const hull = new ConvexGeometry(localVertices);
        const fillMesh = new THREE.Mesh(hull.clone(), new THREE.MeshBasicMaterial({ color: baseColor, transparent: true, opacity: 0.055, depthWrite: false, depthTest: false, side: THREE.DoubleSide }));
        fillMesh.renderOrder = 18;
        const hitMesh = new THREE.Mesh(hull, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, depthTest: false, side: THREE.DoubleSide }));
        hitMesh.renderOrder = 17;
        hitMesh.userData = { objectId, objectName, wireframe };

        const markerRadius = Math.max(Math.max(extent.x, extent.y, extent.z) * 0.075, 0.025);
        const markerGeometry = new THREE.SphereGeometry(markerRadius, 8, 6);
        const markerMaterial = new THREE.MeshBasicMaterial({ color: baseColor, transparent: true, opacity: 0.9, depthWrite: false, depthTest: false });
        const cornerMarkers = new THREE.Group();
        cornerMarkers.name = `${objectId}-bbox-corners`;
        localVertices.forEach(vertex => {
            const marker = new THREE.Mesh(markerGeometry, markerMaterial.clone());
            marker.position.copy(vertex);
            marker.userData.objectId = objectId;
            cornerMarkers.add(marker);
        });
        cornerMarkers.renderOrder = 22;

        const anchorMarker = new THREE.Mesh(new THREE.SphereGeometry(markerRadius * 1.35, 10, 8), new THREE.MeshBasicMaterial({ color: baseColor, transparent: true, opacity: 1, depthWrite: false, depthTest: false }));
        anchorMarker.position.copy(localAnchor);
        anchorMarker.userData.objectId = objectId;
        anchorMarker.renderOrder = 23;
        const anchorGuide = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), localAnchor]), new THREE.LineBasicMaterial({ color: baseColor, transparent: true, opacity: 0.4, depthWrite: false, depthTest: false }));
        anchorGuide.renderOrder = 19;
        return { wireframe, fillMesh, hitMesh, cornerMarkers, anchorMarker, anchorGuide };
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
        entry.anchorGuide.material.color.setHex(color);
        entry.anchorGuide.material.opacity = selected ? 0.75 : related ? 0.48 : 0.35;
        entry.cornerMarkers.children.forEach(marker => {
            marker.material.color.setHex(color);
            marker.material.opacity = selected ? 1 : hovered ? 1 : related ? 0.95 : 0.86;
        });
        const visible = this.annotationMode || (this.showBoundingBoxes && entry.visible);
        entry.wireframe.visible = visible;
        entry.fillMesh.visible = visible;
        entry.cornerMarkers.visible = visible;
        entry.anchorMarker.visible = visible;
        entry.anchorGuide.visible = visible;
        entry.hitMesh.visible = visible;
    }

    focusOnObject(entry) {
        if (!this.camera || !this.controls) return;
        if (entry.camera?.position && entry.camera?.target) {
            this.applyCameraFov(entry.camera.fov);
            this.flyTo(this.toVector(entry.camera.position, this.camera.position), this.toVector(entry.camera.target, this.controls.target));
            return;
        }
        const target = this.entryFocusWorld(entry);
        let position;
        if (entry.cameraOffset) {
            position = target.clone().add(entry.cameraOffset);
        } else {
            const size = entry.extent || new THREE.Vector3(0.3, 0.3, 0.3);
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
        const points = [...this.objectEntries.values()].map(entry => this.entryFocusWorld(entry));
        if (!points.length) return this.frameScene();
        const bounds = new THREE.Box3().setFromPoints(points);
        const target = bounds.getCenter(new THREE.Vector3());
        const size = bounds.getSize(new THREE.Vector3());
        const distance = Math.max(size.length() * 1.5, 3);
        const position = target.clone().add(new THREE.Vector3(0.7, 0.55, 1).normalize().multiplyScalar(distance));
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
        this.camera.up.set(0, 1, 0);
        this.camera.position.copy(position);
        this.controls.target.copy(target);
        this.clampCameraAboveFloor();
        this.controls.update();
        this.updateWorldMetrics();
    }

    flyTo(position, target) {
        if (!this.camera || !this.controls) return;
        const safePosition = position.clone();
        const safeTarget = target.clone();
        const floorY = Number.isFinite(this.worldMetrics.floorY) ? this.worldMetrics.floorY : -Infinity;
        if (Number.isFinite(floorY)) safePosition.y = Math.max(safePosition.y, floorY + 0.12);
        this.cameraTween = {
            started: performance.now(),
            duration: Number(this.presentation.camera?.transition_ms) || 720,
            fromPosition: this.camera.position.clone(),
            fromTarget: this.controls.target.clone(),
            toPosition: safePosition,
            toTarget: safeTarget
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
        this.camera.up.set(0, 1, 0);
        this.clampCameraAboveFloor();
        this.controls.update();
        if (raw >= 1) {
            this.cameraTween = null;
            this.controls.enabled = true;
        }
    }

    handlePointerDown(event) {
        if (this.annotationController?.handlePointerDown?.(event)) return;
    }

    handlePointerMove(event) {
        if (this.annotationController?.handlePointerMove?.(event)) return;
        this.setHoveredObject(this.raycastObjectAt(event.clientX, event.clientY));
    }

    handlePointerUp(event) {
        if (this.annotationController?.handlePointerUp?.(event)) return;
    }

    handleClick(event) {
        if (this.annotationController?.handleClick?.(event)) return;
        const objectId = this.raycastObjectAt(event.clientX, event.clientY);
        this.onObjectSelected(objectId, { source: "scene" });
    }

    setAnnotationController(controller) {
        this.annotationController = controller;
        this.annotationMode = true;
        this.objectEntries.forEach(entry => this.updateEntryVisual(entry));
    }

    setOrbitEnabled(enabled) {
        if (this.controls) this.controls.enabled = Boolean(enabled) && !this.cameraTween;
    }

    setTransformMode(mode, objectId = this.activeObjectId) {
        if (!this.transformControls || !objectId) return;
        const entry = this.objectEntries.get(String(objectId));
        if (!entry) return;
        this.transformMode = mode === "resize" ? "scale" : mode === "rotate" ? "rotate" : "translate";
        this.transformControls.setMode(this.transformMode);
        this.transformControls.setSpace("local");
        if (this.transformMode === "rotate" && this.transformControls.setAxis) this.transformControls.setAxis("Y");
        if (this.transformMode !== "rotate" && this.transformControls.setAxis) this.transformControls.setAxis(null);
        this.transformControls.attach(entry.group);
        this.transformControls.visible = true;
        this.annotationMode = true;
    }

    detachTransformControls() {
        if (!this.transformControls) return;
        this.transformControls.detach();
        this.transformControls.visible = false;
        this.setOrbitEnabled(true);
    }

    raycastObjectAt(clientX, clientY) {
        if (!this.renderer || !this.camera || !this.raycastObjects.length) return null;
        const raycaster = this.makeRaycaster(clientX, clientY);
        const intersections = raycaster.intersectObjects(this.raycastObjects.filter(object => object.visible), true);
        return intersections.length ? String(intersections[0].object.userData.objectId) : null;
    }

    pickPointAt(clientX, clientY, objectId = this.activeObjectId) {
        if (!this.renderer || !this.camera || !this.pointCloud) return null;
        const raycaster = this.makeRaycaster(clientX, clientY);
        const extent = this.pointCloudMetrics?.extent?.length() || 1;
        raycaster.params.Points.threshold = Math.max(extent * 0.008, 0.025);
        const hit = raycaster.intersectObject(this.pointCloud, false)[0];
        if (hit?.point) return hit.point.clone();
        const entry = objectId ? this.objectEntries.get(String(objectId)) : null;
        return entry ? this.intersectCameraPlane(clientX, clientY, this.entryFocusWorld(entry)) : null;
    }

    selectPointCloudRectangle(start, end, objectId = this.activeObjectId) {
        if (!this.pointCloud || !this.renderer || !this.camera) return [];
        const rect = this.renderer.domElement.getBoundingClientRect();
        const left = Math.min(start.x, end.x);
        const right = Math.max(start.x, end.x);
        const top = Math.min(start.y, end.y);
        const bottom = Math.max(start.y, end.y);
        const width = Math.max(right - left, 4);
        const height = Math.max(bottom - top, 4);
        const positions = this.pointCloud.geometry.attributes.position;
        const step = Math.max(1, Math.ceil(positions.count / 180000));
        const candidates = [];
        const sourcePoint = new THREE.Vector3();
        const worldPoint = new THREE.Vector3();
        const projected = new THREE.Vector3();
        for (let index = 0; index < positions.count; index += step) {
            sourcePoint.fromBufferAttribute(positions, index);
            worldPoint.copy(sourcePoint);
            this.worldRoot.localToWorld(worldPoint);
            projected.copy(worldPoint).project(this.camera);
            const screenX = rect.left + (projected.x + 1) * 0.5 * rect.width;
            const screenY = rect.top + (1 - projected.y) * 0.5 * rect.height;
            if (projected.z < -1 || projected.z > 1 || screenX < left || screenX > left + width || screenY < top || screenY > top + height) continue;
            candidates.push({ point: sourcePoint.clone(), depth: this.camera.position.distanceTo(worldPoint) });
        }
        if (!candidates.length) return [];
        candidates.sort((a, b) => a.depth - b.depth);
        const depthRange = candidates[candidates.length - 1].depth - candidates[0].depth; let cutoffIndex = Math.floor(candidates.length * 0.35); for (let i = 8; i < Math.floor(candidates.length * 0.75); i += 1) { const gap = candidates[i + 1].depth - candidates[i].depth; if (gap > Math.max(0.08, depthRange * 0.045)) { cutoffIndex = i; break; } }
        const filtered = candidates.slice(0, cutoffIndex + 1).map(item => item.point);
        return filtered.length >= 8 ? filtered : candidates.slice(0, Math.min(candidates.length, 256)).map(item => item.point);
    }

    intersectCameraPlane(clientX, clientY, point) {
        const raycaster = this.makeRaycaster(clientX, clientY);
        const normal = this.camera.getWorldDirection(new THREE.Vector3());
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point);
        return raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    }

    makeRaycaster(clientX, clientY) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        const mouse = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, this.camera);
        return raycaster;
    }

    showSelectionRectangle(start, end) {
        if (!this.renderer) return;
        if (!this.selectionRectangle) {
            this.selectionRectangle = document.createElement("div");
            this.selectionRectangle.className = "annotation-selection-rectangle";
            this.renderer.domElement.parentElement.appendChild(this.selectionRectangle);
        }
        const canvasRect = this.renderer.domElement.getBoundingClientRect();
        const left = Math.min(start.x, end.x) - canvasRect.left;
        const top = Math.min(start.y, end.y) - canvasRect.top;
        this.selectionRectangle.style.left = `${left}px`;
        this.selectionRectangle.style.top = `${top}px`;
        this.selectionRectangle.style.width = `${Math.abs(end.x - start.x)}px`;
        this.selectionRectangle.style.height = `${Math.abs(end.y - start.y)}px`;
        this.selectionRectangle.hidden = false;
    }

    hideSelectionRectangle() {
        if (this.selectionRectangle) this.selectionRectangle.hidden = true;
    }

    createBoxFromPoints(objectId, sourcePoints) {
        if (!sourcePoints?.length) return false;
        const bounds = new THREE.Box3().setFromPoints(sourcePoints);
        const size = bounds.getSize(new THREE.Vector3());
        const padding = new THREE.Vector3(Math.max(size.x * 0.08, 0.025), Math.max(size.y * 0.08, 0.025), Math.max(size.z * 0.08, 0.025));
        bounds.min.sub(padding);
        bounds.max.add(padding);
        const center = bounds.getCenter(new THREE.Vector3());
        const extent = bounds.getSize(new THREE.Vector3());
        const entry = this.objectEntries.get(String(objectId));
        if (!entry) return false;
        this.setEntryAnnotation(objectId, { center: center.toArray(), extent: extent.toArray(), rotation: [0, 0, 0], anchor: center.toArray(), focus: center.toArray(), cameraOffset: entry.cameraOffset?.toArray() || [0, 0, 0] });
        return true;
    }

    setEntryAnnotation(objectId, annotation) {
        const entry = this.objectEntries.get(String(objectId));
        if (!entry) return false;
        const center = new THREE.Vector3(...annotation.center);
        const extent = new THREE.Vector3(...annotation.extent).max(new THREE.Vector3(0.001, 0.001, 0.001));
        const yaw = Number(annotation.rotation?.[2]) || 0;
        const sourceVertices = boxVertices({ center: center.toArray(), extent: extent.toArray(), rotation: [0, 0, yaw] }).map(point => new THREE.Vector3(...point));
        const localVertices = sourceVertices.map(point => point.clone().sub(center));
        this.replaceBoxGeometry(entry, localVertices, extent);
        entry.group.position.copy(center);
        entry.group.rotation.set(0, THREE.MathUtils.degToRad(yaw), 0);
        entry.group.scale.set(1, 1, 1);
        entry.center.copy(center);
        entry.extent.copy(extent);
        entry.vertices = sourceVertices;
        entry.baseLocalVertices = localVertices.map(point => point.clone());
        entry.annotation = { center: center.toArray(), extent: extent.toArray(), rotation: [0, 0, yaw] };
        const anchor = this.toVector(annotation.anchor, center);
        const focus = this.toVector(annotation.focus, center);
        entry.group.updateMatrix(); entry.group.updateMatrixWorld(true);
        entry.anchorLocal.copy(entry.group.worldToLocal(anchor.clone()));
        entry.focusLocal.copy(entry.group.worldToLocal(focus.clone()));
        entry.cameraOffset = this.toVector(annotation.cameraOffset, entry.cameraOffset);
        entry.camera = annotation.camera || entry.camera || null;
        this.updateAnchorVisual(entry);
        this.syncEntryFromTransform(entry);
        this.updateEntryVisual(entry);
        return true;
    }

    replaceBoxGeometry(entry, localVertices, extent) {
        const edgeVertices = [];
        BOX_EDGES.forEach(([start, end]) => edgeVertices.push(localVertices[start], localVertices[end]));
        entry.wireframe.geometry.dispose();
        entry.wireframe.geometry = new THREE.BufferGeometry().setFromPoints(edgeVertices);
        entry.hitMesh.geometry.dispose();
        entry.hitMesh.geometry = new ConvexGeometry(localVertices);
        const markerRadius = Math.max(Math.max(extent.x, extent.y, extent.z) * 0.075, 0.025);
        entry.cornerMarkers.children.forEach((marker, index) => {
            marker.position.copy(localVertices[index]);
            marker.scale.setScalar(markerRadius / 0.025);
        });
    }

    syncEntryFromTransform(entry) {
        entry.group.updateMatrix(); entry.group.updateMatrixWorld(true);
        const matrix = entry.group.matrix;
        entry.vertices = entry.baseLocalVertices.map(vertex => vertex.clone().applyMatrix4(matrix));
        entry.center.copy(entry.group.position);
        entry.extent.copy(new THREE.Box3().setFromPoints(entry.vertices).getSize(new THREE.Vector3()));
        entry.annotation = { center: entry.center.toArray(), extent: entry.extent.toArray(), rotation: [0, THREE.MathUtils.radToDeg(entry.group.rotation.y), 0] };
        entry.anchorPoint.copy(entry.anchorLocal).applyMatrix4(matrix);
        entry.focusPoint.copy(entry.focusLocal).applyMatrix4(matrix);
        entry.presentation.anchor = entry.anchorPoint.toArray();
        entry.presentation.focus = entry.focusPoint.toArray();
        entry.presentation.cameraOffset = entry.cameraOffset?.toArray() || null;
        this.updateAnchorVisual(entry);
    }

    updatePresentationPoints(objectId, points = {}) {
        const entry = this.objectEntries.get(String(objectId));
        if (!entry) return;
        entry.group.updateMatrix(); entry.group.updateMatrixWorld(true);
        if (Array.isArray(points.anchor) && points.anchor.every(Number.isFinite)) entry.anchorLocal.copy(entry.group.worldToLocal(new THREE.Vector3(...points.anchor)));
        if (Array.isArray(points.focus) && points.focus.every(Number.isFinite)) entry.focusLocal.copy(entry.group.worldToLocal(new THREE.Vector3(...points.focus)));
        if (Array.isArray(points.cameraOffset) && points.cameraOffset.every(Number.isFinite)) entry.cameraOffset = new THREE.Vector3(...points.cameraOffset);
        if (points.camera) entry.camera = points.camera;
        this.syncEntryFromTransform(entry);
        this.updateEntryVisual(entry);
    }

    setPresentationPointFromWorld(objectId, kind, worldPoint) {
        const entry = this.objectEntries.get(String(objectId));
        if (!entry || !worldPoint) return false;
        const sourcePoint = this.worldRoot.worldToLocal(worldPoint.clone());
        this.updatePresentationPoints(objectId, { [kind]: sourcePoint.toArray() });
        return true;
    }

    saveCurrentCamera(objectId) {
        const entry = this.objectEntries.get(String(objectId));
        if (!entry || !this.camera || !this.controls) return null;
        entry.camera = { position: this.camera.position.toArray(), target: this.controls.target.toArray(), fov: this.camera.fov };
        entry.presentation.camera = entry.camera;
        return entry.camera;
    }

    getAnnotation(objectId) {
        const entry = this.objectEntries.get(String(objectId));
        if (!entry) return null;
        this.syncEntryFromTransform(entry);
        return {
            bbox: { center: entry.center.toArray(), extent: entry.extent.toArray(), rotation: entry.annotation.rotation },
            anchor: entry.anchorPoint.toArray(),
            focus: entry.focusPoint.toArray(),
            camera: entry.camera,
            cameraOffset: entry.cameraOffset?.toArray() || [0, 0, 0]
        };
    }

    entryFocusWorld(entry) {
        entry.group.updateMatrixWorld(true);
        return entry.group.localToWorld(entry.focusLocal.clone());
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
        axes.visible = this.debugMode;
        this.debugRoot.add(axes);
    }

    applyWorldAlignment() {
        const alignment = this.presentation.worldAlignment || {};
        const q = Array.isArray(alignment.quaternion) && alignment.quaternion.length === 4 ? alignment.quaternion : [0, 0, 0, 1];
        const t = Array.isArray(alignment.translation) && alignment.translation.length === 3 ? alignment.translation : [0, 0, 0];
        this.worldRoot.position.set(...t);
        this.worldRoot.quaternion.set(...q).normalize();
        this.worldRoot.scale.set(1, 1, 1);
        this.worldRoot.updateMatrixWorld(true);
        this.updateDebugHelpers();
    }

    updateWorldMetrics() {
        const alignment = this.presentation.worldAlignment || {};
        const floorSourceY = Number.isFinite(Number(alignment.floor_y)) ? Number(alignment.floor_y) : (this.pointCloudMetrics?.min.y ?? 0);
        const floorPoint = new THREE.Vector3(0, floorSourceY, 0);
        this.worldRoot.localToWorld(floorPoint);
        const configuredMedian = Number.isFinite(Number(alignment.room_median_y)) ? Number(alignment.room_median_y) : (this.pointCloudMetrics?.center.y ?? floorSourceY);
        const roomPoint = new THREE.Vector3(0, configuredMedian, 0);
        this.worldRoot.localToWorld(roomPoint);
        this.worldMetrics = {
            floorY: floorPoint.y,
            roomMedianY: roomPoint.y,
            cameraY: this.camera?.position.y,
            orbitTargetY: this.controls?.target.y,
            floorNormal: [0, 1, 0]
        };
        this.clampCameraAboveFloor();
        this.updateDebugOverlay();
    }

    clampCameraAboveFloor() {
        if (!this.camera || !this.controls || !Number.isFinite(this.worldMetrics.floorY)) return;
        const minimum = this.worldMetrics.floorY + 0.12;
        if (this.camera.position.y < minimum) this.camera.position.y = minimum;
        if (this.controls.target.y < this.worldMetrics.floorY + 0.04) this.controls.target.y = this.worldMetrics.floorY + 0.04;
        this.camera.up.set(0, 1, 0);
        this.worldMetrics.cameraY = this.camera.position.y;
        this.worldMetrics.orbitTargetY = this.controls.target.y;
    }

    createDebugOverlay() {
        this.debugOverlay = document.createElement("div");
        this.debugOverlay.className = "scene-debug-overlay";
        this.debugOverlay.setAttribute("aria-live", "polite");
        this.container.parentElement.appendChild(this.debugOverlay);
        this.updateDebugOverlay();
    }

    updateDebugOverlay() {
        if (!this.debugOverlay) return;
        const m = this.worldMetrics;
        this.debugOverlay.textContent = `Y-up · floor ${Number(m.floorY ?? 0).toFixed(3)} · camera ${Number(m.cameraY ?? 0).toFixed(3)} · target ${Number(m.orbitTargetY ?? 0).toFixed(3)}`;
    }

    updateDebugHelpers() {
        if (!this.debugRoot) return;
        this.debugRoot.visible = this.debugMode;
        if (!this.debugMode) return;
        const alignment = this.presentation.worldAlignment || {};
        const floorY = Number.isFinite(Number(alignment.floor_y)) ? Number(alignment.floor_y) : (this.pointCloudMetrics?.min.y ?? 0);
        const center = this.pointCloudMetrics?.center?.clone() || new THREE.Vector3();
        const length = Math.max(this.pointCloudMetrics?.extent?.length() * 0.08 || 0.8, 0.5);
        let arrow = this.debugRoot.getObjectByName("world-up-arrow");
        if (!arrow) {
            arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), length, 0x00a878, length * 0.22, length * 0.12);
            arrow.name = "world-up-arrow";
            this.debugRoot.add(arrow);
        }
        arrow.position.set(center.x, floorY, center.z);
        let floorArrow = this.debugRoot.getObjectByName("floor-normal-arrow");
        if (!floorArrow) {
            floorArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), length * 0.8, 0xff7a00, length * 0.18, length * 0.1);
            floorArrow.name = "floor-normal-arrow";
            this.debugRoot.add(floorArrow);
        }
        floorArrow.position.set(center.x + length * 0.8, floorY, center.z);
        let grid = this.debugRoot.getObjectByName("detected-floor-plane");
        if (!grid) {
            grid = new THREE.GridHelper(Math.max(this.pointCloudMetrics?.extent?.x || 4, this.pointCloudMetrics?.extent?.z || 4), 20, 0x718096, 0xcbd5e1);
            grid.name = "detected-floor-plane";
            grid.material.transparent = true;
            grid.material.opacity = 0.3;
            this.debugRoot.add(grid);
        }
        grid.position.set(center.x, floorY + 0.006, center.z);
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
        if (this.pointCloud) bounds.expandByObject(this.pointCloud);
        this.objectEntries.forEach(entry => bounds.expandByObject(entry.group));
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
        const obliqueDirection = new THREE.Vector3(1, 0.72, 1).normalize();
        this.defaultTarget.copy(center);
        this.defaultPosition.copy(center).addScaledVector(obliqueDirection, fitDistance);
        this.defaultPosition.y = Math.max(this.defaultPosition.y, (this.worldMetrics.floorY ?? -Infinity) + 0.3);
        this.camera.up.set(0, 1, 0);
        this.camera.near = Math.max(0.01, fitDistance * 0.01);
        this.camera.far = Math.max(5000, fitDistance + sphereRadius * 4);
        this.camera.updateProjectionMatrix();
        this.setCameraView(this.defaultPosition, this.defaultTarget);
    }

    clearGeometry() {
        this.detachTransformControls();
        this.objectEntries.clear();
        this.raycastObjects = [];
        this.pointCloud = null;
        this.hasPointCloud = false;
        this.hasBoundingBoxes = false;
        this.worldRoot.children.filter(child => child !== this.debugRoot).forEach(child => {
            this.disposeObject(child);
            this.worldRoot.remove(child);
        });
        this.debugRoot.clear();
        this.updatePlaceholder();
    }

    disposeObject(object) {
        object.traverse(child => {
            child.geometry?.dispose();
            if (Array.isArray(child.material)) child.material.forEach(material => material.dispose());
            else child.material?.dispose();
        });
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

    updateAnchorVisual(entry) {
        entry.anchorMarker.position.copy(entry.anchorLocal);
        entry.anchorGuide.geometry.dispose();
        entry.anchorGuide.geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), entry.anchorLocal]);
    }

    updatePlaceholder() {
        this.placeholder.hidden = this.hasPointCloud || this.hasBoundingBoxes;
    }

    setStatus(message) {
        const strong = this.placeholder?.querySelector("strong");
        if (strong) strong.textContent = message;
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
            this.camera?.up.set(0, 1, 0);
            this.clampCameraAboveFloor();
            this.controls?.update();
            this.updateDebugHelpers();
            this.renderer.render(this.scene, this.camera);
        };
        animate(performance.now());
    }
}

function boxVertices(annotation) {
    const [cx, cy, cz] = annotation.center;
    const [sx, sy, sz] = annotation.extent.map(value => value / 2);
    const yaw = (annotation.rotation?.[2] || 0) * Math.PI / 180;
    const local = [[-sx, -sy, -sz], [sx, -sy, -sz], [-sx, sy, -sz], [-sx, -sy, sz], [sx, sy, sz], [-sx, sy, sz], [sx, sy, -sz], [sx, -sy, sz]];
    return local.map(([x, y, z]) => [cx + x * Math.cos(yaw) - y * Math.sin(yaw), cy + x * Math.sin(yaw) + y * Math.cos(yaw), cz + z]);
}
