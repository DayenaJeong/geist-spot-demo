// Exact camera-pose capture for development/annotation mode.
// The saved pose is intentionally kept separate from object annotations and
// is applied only after the existing SceneView load sequence has completed.

export const CAMERA_PRESETS_STORAGE_KEY = "spot-demo-camera-presets-v1";

function finiteArray(value, length) {
    return Array.isArray(value) && value.length === length && value.every(Number.isFinite);
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

export function readCameraPresets() {
    try {
        const value = JSON.parse(localStorage.getItem(CAMERA_PRESETS_STORAGE_KEY) || "{}");
        return value && typeof value === "object" ? value : {};
    } catch {
        return {};
    }
}

export function captureCameraPose(scene) {
    if (!scene?.camera || !scene.controls) return null;
    const camera = scene.camera;
    const controls = scene.controls;
    return {
        camera: {
            position: camera.position.toArray(),
            quaternion: camera.quaternion.toArray(),
            up: camera.up.toArray(),
            fov: camera.fov,
            zoom: camera.zoom
        },
        target: controls.target.toArray(),
        azimuthalAngle: controls.getAzimuthalAngle(),
        polarAngle: controls.getPolarAngle()
    };
}

export function applyCameraPose(scene, pose) {
    if (!scene?.camera || !scene.controls || !pose) return false;
    const cameraPose = pose.camera || pose;
    if (!finiteArray(cameraPose.position, 3) || !finiteArray(cameraPose.quaternion, 4) || !finiteArray(cameraPose.up, 3) || !finiteArray(pose.target, 3)) return false;

    const camera = scene.camera;
    const controls = scene.controls;
    scene.cameraTween = null;
    scene.__exactCameraPoseLock = true;
    controls.enabled = true;
    camera.position.fromArray(cameraPose.position);
    camera.up.fromArray(cameraPose.up);
    camera.quaternion.fromArray(cameraPose.quaternion).normalize();
    if (Number.isFinite(Number(cameraPose.fov))) camera.fov = Number(cameraPose.fov);
    if (Number.isFinite(Number(cameraPose.zoom))) camera.zoom = Number(cameraPose.zoom);
    controls.target.fromArray(pose.target);
    camera.updateProjectionMatrix();
    // Keep the exact captured pose stable. OrbitControls retains internal damping
    // deltas, so applying controls.update() here would move the camera away from
    // the saved state before the user has interacted with the scene.
    scene.__exactCameraPoseLock = true;
    camera.updateMatrixWorld(true);
    scene.updateWorldMetrics?.();
    scene.updateDebugHelpers?.();
    return true;
}

function applyStoredPresentation(manifest, presets) {
    if (!manifest || (!presets.initial && !presets.focus_demo_area)) return manifest;
    const presentation = manifest.presentation || {};
    const camera = presentation.camera || {};
    return {
        ...manifest,
        presentation: {
            ...presentation,
            camera: {
                ...camera,
                ...(presets.initial ? { initial: cloneJson(presets.initial) } : {}),
                ...(presets.focus_demo_area ? { demo_area: cloneJson(presets.focus_demo_area) } : {})
            }
        }
    };
}

export function installCameraCapture(scene, { annotationMode = false } = {}) {
    scene.captureCameraPose = () => captureCameraPose(scene);
    scene.applyCameraPose = pose => applyCameraPose(scene, pose);
    scene.readCameraPresets = readCameraPresets;

    const originalControlsUpdate = scene.controls.update.bind(scene.controls);
    scene.controls.update = (...args) => scene.__exactCameraPoseLock ? false : originalControlsUpdate(...args);

    const originalLoadManifest = scene.loadManifest.bind(scene);
    const originalSetCameraView = scene.setCameraView.bind(scene);
    scene.setCameraView = (...args) => { scene.__exactCameraPoseLock = false; return originalSetCameraView(...args); };
    const originalFlyTo = scene.flyTo.bind(scene);
    scene.flyTo = (...args) => { scene.__exactCameraPoseLock = false; return originalFlyTo(...args); };
    const originalHandlePointerDown = scene.handlePointerDown.bind(scene);
    scene.handlePointerDown = event => { scene.__exactCameraPoseLock = false; return originalHandlePointerDown(event); };
    const originalFocusDemoArea = scene.focusDemoArea.bind(scene);
    scene.focusDemoArea = ({ animate = true } = {}) => {
        const configured = scene.presentation.camera?.demo_area;
        if (configured?.target && configured?.position && (configured.camera?.quaternion || configured.quaternion)) {
            return applyCameraPose(scene, configured);
        }
        return originalFocusDemoArea({ animate });
    };
    scene.loadManifest = async manifest => {
        const presets = readCameraPresets();
        const loadedManifest = applyStoredPresentation(manifest, presets);
        const result = await originalLoadManifest(loadedManifest);
        // This is deliberately the last camera operation in the load wrapper:
        // PLY, world alignment, objects, controls, boxes, and the existing
        // initial view have already completed before this exact pose is applied.
        const latest = readCameraPresets();
        if (latest.initial) applyCameraPose(scene, latest.initial);
        return result;
    };
}

