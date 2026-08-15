// Standalone application entry point.
// Graph and 3D rendering are adapted from FunFact's Interactive Scene Explorer.
// FunFact attribution: https://github.com/funfact-scenegraph/FunFact

import { loadDemoData, loadEvidenceManifest, loadSceneManifest } from "./data_adapter.js";
import { GraphView } from "./graph_view.js";
import { SceneView } from "./scene_view.js?v=lamp-state-visible-20260815";
import { StateController } from "./state_controller.js?v=lamp-state-visible-20260815";
import { setupAnnotationMode } from "./annotation_mode.js";

import { installCameraCapture } from "./camera_capture.js";
const DATA_URL = "./data/demo_state.json";

async function main() {
    const data = await loadDemoData(DATA_URL);
    const query = new URLSearchParams(window.location.search);
    const annotationMode = query.get("annotate") === "1";
    const debugMode = query.get("debug") === "1" && !data.presentationMode;
    data.annotationMode = annotationMode;
    if (annotationMode) data.presentationMode = false;
    document.body.dataset.presentationMode = String(data.presentationMode);
    const elements = getElements();
    const graph = new GraphView(elements.network, {
        onNodeSelected: (objectId, metadata) => controller.onObjectSelected(objectId, metadata)
    });
    const scene = new SceneView(elements.sceneCanvas, elements.scenePlaceholder, elements.sceneModeTag, {
        onObjectSelected: (objectId, metadata) => controller.onObjectSelected(objectId, metadata),
        onObjectHovered: objectId => controller.onObjectHovered(objectId),
        debugMode,
        annotationMode
    });
    installCameraCapture(scene, { annotationMode });
    const refreshLayout = () => window.requestAnimationFrame(() => {
        graph.fit();
        scene.resize();
    });
    const media = setupEvidenceMedia(elements, refreshLayout);
    const controller = new StateController({
        data: { ...data, loadManifest: loadSceneManifest, loadEvidenceManifest },
        graph,
        scene,
        elements,
        media
    });

    window.__spotDemo = { controller, graph, scene };
    window.addEventListener("resize", refreshLayout, { passive: true });
    if ("ResizeObserver" in window) {
        const resizeObserver = new ResizeObserver(refreshLayout);
        resizeObserver.observe(elements.appShell);
        resizeObserver.observe(elements.workspace);
        resizeObserver.observe(elements.mediaRegion);
        window.__spotDemo.resizeObserver = resizeObserver;
    }
    await controller.start();
    const requestedState = query.get("state");
    if (requestedState && data.states[requestedState]) controller.setState(requestedState, { fromAuto: true });
    if (data.annotationMode) setupAnnotationMode({ data, scene });
}

function getElements() {
    return {
        appShell: document.querySelector(".app-shell"),
        workspace: document.querySelector(".workspace"),
        network: document.getElementById("network"),
        sceneCanvas: document.getElementById("sceneCanvas"),
        scenePlaceholder: document.getElementById("scenePlaceholder"),
        sceneModeTag: document.getElementById("sceneModeTag"),
        evidencePanel: document.getElementById("evidencePanel"),
        evidenceContent: document.getElementById("evidenceContent"),
        transitionMessage: document.getElementById("transitionMessage"),
        stateButtons: [...document.querySelectorAll(".state-button")],
        currentStateLabel: document.getElementById("currentStateLabel"),
        autoDemoButton: document.getElementById("autoDemoButton"),
        resetViewButton: document.getElementById("resetViewButton"),
        focusDemoAreaButton: document.getElementById("focusDemoAreaButton"),
        showBoxesButton: document.getElementById("showBoxesButton"),
        selectionStatus: document.getElementById("selectionStatus"),
        sceneSelectionCard: document.getElementById("sceneSelectionCard"),
        sceneSelectionLabel: document.getElementById("sceneSelectionLabel"),
        sceneSelectionMeta: document.getElementById("sceneSelectionMeta"),
        mediaRegion: document.getElementById("mediaRegion"),
        mediaGrid: document.getElementById("mediaGrid"),
        mediaMode: document.getElementById("mediaMode")
    };
}

function setupEvidenceMedia(elements, onLayoutChanged = () => {}) {
    const { mediaRegion, mediaGrid, mediaMode } = elements;
    function applyLayout() {
        const selectedMode = mediaMode.value;
        mediaGrid.dataset.layout = selectedMode;
        mediaGrid.querySelectorAll(".video-panel").forEach(panel => {
            panel.hidden = selectedMode === "graph-3d" || (selectedMode !== "pair" && panel.dataset.mediaKey !== selectedMode);
        });
    }
    mediaMode.addEventListener("change", applyLayout);
    return {
        render(items, { autoplay = false, playAll = false } = {}) {
            mediaGrid.innerHTML = "";
            if (!items || items.length === 0) {
                mediaRegion.hidden = true;
                return Promise.resolve();
            }
            mediaRegion.hidden = false;
            mediaMode.value = items.length > 1 ? "pair" : items[0].key;
            const playbackReady = [];
            items.forEach(item => {
                const wrapper = document.createElement("div");
                wrapper.className = "video-panel";
                wrapper.dataset.mediaKey = item.key;
                const title = document.createElement("span");
                title.textContent = item.label;
                const video = document.createElement("video");
                const shouldAutoplay = autoplay && (item.autoplay || playAll);
                const hideControls = document.body.dataset.presentationMode === "true" && document.body.dataset.autoDemo === "true" && autoplay;
                video.controls = !hideControls;
                video.preload = shouldAutoplay ? "auto" : "metadata";
                video.playsInline = true;
                video.src = item.source;
                wrapper.append(title, video);
                mediaGrid.appendChild(wrapper);
                if (shouldAutoplay) {
                    video.muted = true;
                    let resolved = false;
                    const playbackPromise = new Promise(resolve => {
                        const resolveOnce = () => {
                            if (resolved) return;
                            resolved = true;
                            video.removeEventListener("playing", resolveOnce);
                            resolve();
                        };
                        video.addEventListener("playing", resolveOnce, { once: true });
                        window.setTimeout(resolveOnce, 2500);
                    });
                    playbackReady.push(playbackPromise);
                    const startPlayback = () => video.play().then(() => {}, () => {}).catch(() => {});
                    video.addEventListener("loadedmetadata", startPlayback, { once: true });
                    if (video.readyState >= 1) startPlayback();
                    window.setTimeout(startPlayback, 120);
                }
            });
            applyLayout();
            window.requestAnimationFrame(onLayoutChanged);
            return Promise.all(playbackReady);
        },
        clear() {
            mediaGrid.innerHTML = "";
            mediaRegion.hidden = true;
            return Promise.resolve();
        }
    };
}

main().catch(error => {
    console.error(error);
    const message = document.createElement("div");
    message.className = "boot-error";
    message.textContent = `Viewer could not initialize: ${error.message}`;
    document.body.appendChild(message);
});
