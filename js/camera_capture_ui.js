import { CAMERA_PRESETS_STORAGE_KEY, readCameraPresets } from "./camera_capture.js";

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}
function presentationPose(pose) {
    return {
        position: pose.camera.position,
        quaternion: pose.camera.quaternion,
        up: pose.camera.up,
        fov: pose.camera.fov,
        zoom: pose.camera.zoom,
        target: pose.target,
        camera: pose.camera,
        azimuthalAngle: pose.azimuthalAngle,
        polarAngle: pose.polarAngle
    };
}

function downloadJson(filename, payload) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
}

function presentationPayload(scene, slot, pose) {
    const configuredCamera = scene.presentation?.camera || {};
    const camera = {
        ...configuredCamera,
        ...(slot === "initial" ? { initial: pose } : { demo_area: pose })
    };
    return {
        version: 4,
        coordinateFrame: "aligned_world",
        sourceCoordinateFrame: "scene.ply",
        worldAlignment: clone(scene.presentation?.worldAlignment || { enabled: true, quaternion: [0, 0, 0, 1], translation: [0, 0, 0] }),
        camera
    };
}

export function setupCameraCaptureControls({ panel, scene, status }) {
    const section = document.createElement("div");
    section.className = "camera-capture-controls";
    section.innerHTML = `
        <div class="camera-capture-heading">
            <span class="annotation-tool-label">Exact presentation camera</span>
            <span class="camera-capture-note">reads the current rendered Three.js pose</span>
        </div>
        <div class="camera-capture-actions">
            <button type="button" data-camera-action="save-initial">Save Current View as Default</button>
            <button type="button" data-camera-action="save-focus">Save as Focus Demo Area</button>
            <button type="button" data-camera-action="copy">Copy Camera Preset</button>
        </div>
        <textarea data-camera-json readonly spellcheck="false" aria-label="Captured camera preset JSON" placeholder="Captured camera pose JSON appears here"></textarea>`;
    const insertionPoint = panel.querySelector(".annotation-instructions");
    panel.insertBefore(section, insertionPoint || panel.firstChild);
    const output = section.querySelector("[data-camera-json]");
    function showPose(pose) {
        output.value = pose ? JSON.stringify(pose, null, 2) : "";
        return pose;
    }

    function capture() {
        const pose = scene.captureCameraPose?.();
        if (!pose) status.textContent = "Camera pose is not available yet";
        else showPose(pose);
        return pose;
    }

    function save(slot) {
        const pose = capture();
        if (!pose) return null;
        scene.applyCameraPose?.(pose);
        const storedPose = presentationPose(pose);
        const presets = readCameraPresets();
        presets[slot === "initial" ? "initial" : "focus_demo_area"] = storedPose;
        localStorage.setItem(CAMERA_PRESETS_STORAGE_KEY, JSON.stringify(presets, null, 2));
        scene.presentation.camera = {
            ...(scene.presentation.camera || {}),
            ...(slot === "initial" ? { initial: storedPose } : { demo_area: storedPose })
        };
        const payload = presentationPayload(scene, slot, storedPose);
        downloadJson("scene_presentation_camera_capture.json", payload);
        status.textContent = slot === "initial"
            ? "Exact current view saved as the default; JSON downloaded"
            : "Exact current view saved as Focus Demo Area; JSON downloaded";
        window.__spotDemo.cameraCapture = { pose, storedPose, slot, payload };
        return pose;
    }

    async function copy() {
        const pose = capture();
        if (!pose) return null;
        const value = JSON.stringify(pose, null, 2);
        try {
            await navigator.clipboard.writeText(value);
            status.textContent = "Camera preset copied to clipboard";
        } catch {
            output.focus();
            output.select();
            document.execCommand("copy");
            status.textContent = "Camera preset selected for copying";
        }
        return pose;
    }

    section.querySelector('[data-camera-action="save-initial"]').addEventListener("click", () => save("initial"));
    section.querySelector('[data-camera-action="save-focus"]').addEventListener("click", () => save("focus_demo_area"));
    section.querySelector('[data-camera-action="copy"]').addEventListener("click", copy);

    window.__spotDemo.cameraCapture = { panel: section, capture, saveInitial: () => save("initial"), saveFocus: () => save("focus_demo_area"), copy, output };
    return { panel: section, capture, saveInitial: () => save("initial"), saveFocus: () => save("focus_demo_area"), copy, output };
}

