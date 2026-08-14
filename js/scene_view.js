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

export class SceneView {
    constructor(container, placeholder, modeTag, { onObjectSelected }) {
        this.container = container;
        this.placeholder = placeholder;
        this.modeTag = modeTag;
        this.onObjectSelected = onObjectSelected;
        this.objectEntries = new Map();
        this.raycastObjects = [];
        this.animationFrame = null;
        this.defaultTarget = new THREE.Vector3(0, 0, 0);
        this.defaultPosition = new THREE.Vector3(0, -2.8, 1.8);
        this.sceneBounds = null;
        this.pointCloudMetrics = null;
        this.hasPointCloud = false;
        this.hasBoundingBoxes = false;
        this.renderer = null;
        this.camera = null;
        this.controls = null;
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color("#f4f7fa");

        try {
            this.initializeRenderer();
            this.startAnimation();
        } catch (error) {
            // A missing WebGL implementation should degrade to the explicit empty mode.
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

        this.camera = new THREE.PerspectiveCamera(42, width / height, 0.01, 5000);
        this.camera.up.set(0, 0, 1);
        this.camera.position.copy(this.defaultPosition);
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.06;
        this.controls.screenSpacePanning = true;
        this.controls.target.copy(this.defaultTarget);
        this.controls.update();

        const ambientLight = new THREE.AmbientLight(0xffffff, 1.8);
        this.scene.add(ambientLight);

        this.renderer.domElement.addEventListener("click", event => this.handleClick(event));
        window.addEventListener("resize", () => this.resize());
    }

    async loadManifest(manifest) {
        this.clearGeometry();
        this.manifest = manifest || null;

        if (!this.renderer || !manifest) {
            this.setStatus("3D scene data not loaded");
            return;
        }

        const manifestUrl = manifest.__sourceUrl || window.location.href;
        const objectMetadata = Array.isArray(manifest.objects) ? manifest.objects : [];

        if (manifest.pointcloud) {
            this.loadPointCloud(new URL(manifest.pointcloud, manifestUrl).toString());
        }

        const boundingBoxes = await this.collectBoundingBoxes(objectMetadata, manifest, manifestUrl);
        boundingBoxes.forEach(record => this.createBoundingBox(record, objectMetadata));

        if (!this.hasPointCloud && !this.hasBoundingBoxes) {
            this.setStatus("3D scene data not loaded");
            this.modeTag.textContent = "EMPTY DATA MODE";
        } else {
            this.modeTag.textContent = "SCENE DATA READY";
            this.setStatus("Scene data loaded · click an object to select");
            this.frameScene();
        }
    }

    async collectBoundingBoxes(objectMetadata, manifest, manifestUrl) {
        const records = [];
        if (Array.isArray(manifest.bounding_boxes)) {
            records.push(...manifest.bounding_boxes);
        }

        if (manifest.objects_file) {
            try {
                const objectsUrl = new URL(manifest.objects_file, manifestUrl).toString();
                const response = await fetch(objectsUrl);
                if (!response.ok) {
                    throw new Error(`${response.status} ${response.statusText}`);
                }
                const payload = await response.json();
                const fileObjects = Array.isArray(payload.objects) ? payload.objects : [];
                fileObjects.forEach(object => {
                    if (object && Array.isArray(object.vertices)) {
                        records.push({
                            ...object,
                            id: object.id,
                            name: object.label || object.name || object.id
                        });
                    }
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

            if (!object.bbox_file) {
                continue;
            }

            try {
                const bboxUrl = new URL(object.bbox_file, manifestUrl).toString();
                const response = await fetch(bboxUrl);
                if (!response.ok) {
                    throw new Error(`${response.status} ${response.statusText}`);
                }
                const payload = await response.json();
                const payloadBoxes = Array.isArray(payload.bounding_boxes)
                    ? payload.bounding_boxes
                    : [payload];
                const match = payloadBoxes.find(box => String(box.id) === String(object.id)) || payloadBoxes[0];
                if (match) {
                    records.push({ ...match, id: object.id, name: object.label });
                }
            } catch (error) {
                // One missing object box must not prevent the rest of the demo from running.
                console.warn(`Bounding box unavailable for ${object.id}: ${error.message}`);
            }
        }

        return records;
    }

    loadPointCloud(pointcloudUrl) {
        const loader = new PLYLoader();
        loader.load(pointcloudUrl, geometry => {
            if (geometry.attributes.position === undefined) {
                throw new Error("PLY has no position attribute");
            }

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
            this.frameScene();
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
        const edgeVertices = [];
        BOX_EDGES.forEach(([start, end]) => {
            edgeVertices.push(vertices[start], vertices[end]);
        });

        const lineGeometry = new THREE.BufferGeometry().setFromPoints(edgeVertices);
        const baseColor = this.parseColor(record.color_metadata || 0x6f879a);
        const wireframe = new THREE.LineSegments(lineGeometry, new THREE.LineBasicMaterial({
            color: baseColor,
            transparent: true,
            opacity: 0.82
        }));
        wireframe.userData = {
            objectId,
            objectName: record.name || record.label || objectId,
            originalColor: baseColor
        };

        let hitMesh;
        try {
            const hull = new ConvexGeometry(vertices);
            hitMesh = new THREE.Mesh(hull, new THREE.MeshBasicMaterial({
                transparent: true,
                opacity: 0,
                depthWrite: false,
                side: THREE.DoubleSide
            }));
        } catch (error) {
            console.warn(`Bounding-box raycast mesh unavailable for ${objectId}: ${error.message}`);
            return;
        }

        hitMesh.userData = {
            objectId,
            objectName: record.name || record.label || objectId,
            wireframe
        };
        this.scene.add(wireframe);
        this.scene.add(hitMesh);
        this.raycastObjects.push(hitMesh);
        this.objectEntries.set(objectId, {
            id: objectId,
            wireframe,
            hitMesh,
            center: new THREE.Box3().setFromObject(hitMesh).getCenter(new THREE.Vector3()),
            originalColor: baseColor
        });
        this.hasBoundingBoxes = true;
        this.modeTag.textContent = "SCENE DATA READY";
        this.updatePlaceholder();
    }

    resolveObjectId(candidate, objectMetadata) {
        const value = String(candidate || "");
        const match = objectMetadata.find(object => {
            const aliases = [object.id, object.label, ...(object.aliases || [])].map(String);
            return aliases.includes(value);
        });
        return match ? String(match.id) : value;
    }

    highlightObject(objectId, { focus = true } = {}) {
        this.clearSelection();
        if (!objectId || !this.objectEntries.has(String(objectId))) {
            return;
        }

        const entry = this.objectEntries.get(String(objectId));
        entry.wireframe.material.color.setHex(0x155e91);
        entry.wireframe.material.opacity = 1;
        if (focus) {
            this.focusOnObject(entry);
        }
    }

    clearSelection() {
        this.objectEntries.forEach(entry => {
            entry.wireframe.material.color.setHex(entry.originalColor);
            entry.wireframe.material.opacity = 0.82;
        });
    }

    focusOnObject(entry) {
        if (!this.camera || !this.controls) {
            return;
        }
        const bounds = new THREE.Box3().setFromObject(entry.hitMesh);
        const center = bounds.getCenter(new THREE.Vector3());
        const size = bounds.getSize(new THREE.Vector3());
        const maxDimension = Math.max(size.x, size.y, size.z, 0.1);
        const distance = Math.max(maxDimension * 2.5, 1.5);
        const direction = new THREE.Vector3();
        this.camera.getWorldDirection(direction);
        direction.negate();
        this.camera.position.copy(center.clone().add(direction.multiplyScalar(distance)));
        this.controls.target.copy(center);
        this.controls.update();
    }

    resetView() {
        if (!this.camera || !this.controls) {
            return;
        }
        this.camera.position.copy(this.defaultPosition);
        this.camera.up.set(0, 0, 1);
        this.controls.target.copy(this.defaultTarget);
        this.controls.update();
    }

    handleClick(event) {
        if (!this.renderer || this.raycastObjects.length === 0) {
            return;
        }
        const rect = this.renderer.domElement.getBoundingClientRect();
        const mouse = new THREE.Vector2(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1
        );
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, this.camera);
        const intersections = raycaster.intersectObjects(this.raycastObjects, true);
        if (intersections.length === 0) {
            this.onObjectSelected(null, { source: "scene" });
            return;
        }

        // Raycaster results are sorted by distance; deterministic selection is important for a demo.
        const objectId = String(intersections[0].object.userData.objectId);
        this.onObjectSelected(objectId, { source: "scene" });
    }

    addCoordinateAxes(geometry) {
        geometry.computeBoundingBox();
        const bounds = geometry.boundingBox;
        if (!bounds) {
            return;
        }
        const center = bounds.getCenter(new THREE.Vector3());
        const size = bounds.getSize(new THREE.Vector3());
        const axisLength = Math.max(size.x, size.y, size.z) * 0.12;
        const axes = new THREE.AxesHelper(axisLength);
        axes.position.copy(center);
        axes.name = "scene-coordinate-axes";
        this.scene.add(axes);
    }

    computePointSize(geometry) {
        const extent = geometry.boundingBox?.getSize(new THREE.Vector3());
        const maxDimension = extent ? Math.max(extent.x, extent.y, extent.z) : 1;
        const scaleAwareSize = THREE.MathUtils.clamp(maxDimension * 0.0002, 0.0005, 0.004);
        const sourceSize = geometry.attributes.size?.array?.[0];
        if (Number.isFinite(sourceSize) && sourceSize > 0) {
            return Math.min(sourceSize, scaleAwareSize);
        }
        return scaleAwareSize;
    }

    getRenderableBounds() {
        const bounds = new THREE.Box3();
        this.scene.traverse(object => {
            if (object.name === "spot-point-cloud" || object.type === "LineSegments") {
                bounds.expandByObject(object);
            }
        });
        return bounds.isEmpty() ? null : bounds;
    }

    frameScene() {
        if (!this.camera || !this.controls) {
            return;
        }
        const bounds = this.getRenderableBounds();
        if (!bounds) {
            return;
        }

        this.sceneBounds = bounds.clone();
        const center = bounds.getCenter(new THREE.Vector3());
        const size = bounds.getSize(new THREE.Vector3());
        const sphereRadius = Math.max(size.length() * 0.5, 0.1);
        const verticalFov = THREE.MathUtils.degToRad(this.camera.fov);
        const horizontalFov = 2 * Math.atan(Math.tan(verticalFov * 0.5) * this.camera.aspect);
        const verticalFitDistance = sphereRadius / Math.tan(verticalFov * 0.5);
        const horizontalFitDistance = sphereRadius / Math.tan(horizontalFov * 0.5);
        const fitDistance = Math.max(verticalFitDistance, horizontalFitDistance) * 1.2;
        const obliqueDirection = new THREE.Vector3(1, -1, 0.65).normalize();

        this.defaultTarget.copy(center);
        this.defaultPosition.copy(center).addScaledVector(obliqueDirection, fitDistance);
        this.camera.up.set(0, 0, 1);
        this.camera.near = Math.max(0.01, fitDistance * 0.01);
        this.camera.far = Math.max(5000, fitDistance + sphereRadius * 4);
        this.camera.updateProjectionMatrix();
        this.camera.position.copy(this.defaultPosition);
        this.controls.target.copy(this.defaultTarget);
        this.controls.update();
    }

    clearGeometry() {
        this.objectEntries.clear();
        this.raycastObjects = [];
        this.hasPointCloud = false;
        this.hasBoundingBoxes = false;
        if (!this.scene) {
            return;
        }
        const removable = [];
        this.scene.traverse(object => {
            if (object.name === "spot-point-cloud" || object.name === "scene-coordinate-axes" || object.type === "LineSegments" || object.type === "Mesh") {
                removable.push(object);
            }
        });
        removable.forEach(object => {
            if (object.parent) {
                object.parent.remove(object);
            }
            object.geometry?.dispose();
            if (Array.isArray(object.material)) {
                object.material.forEach(material => material.dispose());
            } else {
                object.material?.dispose();
            }
        });
        this.updatePlaceholder();
    }

    parseColor(value) {
        if (typeof value === "number") {
            return value;
        }
        if (typeof value === "string") {
            return new THREE.Color(value).getHex();
        }
        if (value && typeof value.hex === "string") {
            return new THREE.Color(value.hex).getHex();
        }
        return 0x6f879a;
    }

    updatePlaceholder() {
        const shouldShow = !this.hasPointCloud && !this.hasBoundingBoxes;
        this.placeholder.hidden = !shouldShow;
    }

    setStatus(message) {
        this.placeholder.querySelector("strong").textContent = message;
        this.updatePlaceholder();
    }

    resize() {
        if (!this.renderer || !this.camera) {
            return;
        }
        const width = Math.max(this.container.clientWidth, 1);
        const height = Math.max(this.container.clientHeight, 1);
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height);
    }

    startAnimation() {
        if (!this.renderer) {
            return;
        }
        const animate = () => {
            this.animationFrame = requestAnimationFrame(animate);
            this.controls?.update();
            this.renderer.render(this.scene, this.camera);
        };
        animate();
    }
}
