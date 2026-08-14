// Adapted from the FunFact report data contract.
// FunFact attribution: https://github.com/funfact-scenegraph/FunFact

const REQUIRED_STATES = ["INITIAL", "AFTER_SWITCH_A", "AFTER_SWITCH_B"];
const ALLOWED_RELATION_STATES = new Set(["candidate", "removed", "verified"]);

export async function loadDemoData(dataUrl) {
    const response = await fetch(dataUrl);
    if (!response.ok) {
        throw new Error(`Unable to load demo state: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    validateDemoData(data);

    const dataBaseUrl = new URL(".", new URL(dataUrl, window.location.href));
    const manifestUrl = data.scene_manifest
        ? new URL(data.scene_manifest, dataBaseUrl).toString()
        : null;
    const evidenceManifestUrl = data.evidence_manifest
        ? new URL(data.evidence_manifest, dataBaseUrl).toString()
        : null;

    const query = new URLSearchParams(window.location.search);
    const presentationMode = query.get("presentation") === "1"
        || (data.presentation_mode === true && query.get("development") !== "1");

    return {
        ...data,
        manifestUrl,
        evidenceManifestUrl,
        presentationMode,
        objectById: new Map(data.objects.map(object => [object.id, object])),
        aliases: buildAliasMap(data.objects)
    };
}

export async function loadEvidenceManifest(manifestUrl) {
    if (!manifestUrl) {
        return null;
    }

    const response = await fetch(manifestUrl);
    if (!response.ok) {
        throw new Error(`Unable to load evidence manifest: ${response.status} ${response.statusText}`);
    }
    const manifest = await response.json();
    if (!manifest.evidence_json) {
        throw new Error("Evidence manifest must point to evidence_json");
    }

    const evidenceUrl = new URL(manifest.evidence_json, manifestUrl).toString();
    const evidenceResponse = await fetch(evidenceUrl);
    if (!evidenceResponse.ok) {
        throw new Error(`Unable to load evidence JSON: ${evidenceResponse.status} ${evidenceResponse.statusText}`);
    }

    return {
        ...manifest,
        __sourceUrl: manifestUrl,
        __evidenceUrl: evidenceUrl,
        evidence: await evidenceResponse.json()
    };
}

export async function loadSceneManifest(manifestUrl, demoData) {
    if (!manifestUrl) {
        return {
            scene_id: "empty-development-scene",
            pointcloud: null,
            objects: demoData.objects.map(object => ({
                id: object.id,
                label: object.label,
                bbox_file: null,
                color_metadata: null
            }))
        };
    }

    try {
        const response = await fetch(manifestUrl);
        if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`);
        }
        const manifest = await response.json();
        return {
            ...manifest,
            __sourceUrl: manifestUrl
        };
    } catch (error) {
        // Missing geometry must be a valid UI-development state.
        console.warn(`Scene manifest unavailable; continuing without 3D data: ${error.message}`);
        return {
            scene_id: "empty-development-scene",
            pointcloud: null,
            objects: demoData.objects.map(object => ({
                id: object.id,
                label: object.label,
                bbox_file: null,
                color_metadata: null
            }))
        };
    }
}

export function resolveAssetUrl(assetPath, sourceUrl) {
    if (!assetPath || !sourceUrl) {
        return null;
    }
    return new URL(assetPath, sourceUrl).toString();
}

function validateDemoData(data) {
    if (!data || !Array.isArray(data.objects) || !data.states) {
        throw new Error("Demo data must contain objects and states");
    }

    const objectIds = new Set();
    for (const object of data.objects) {
        if (!object.id || !object.label) {
            throw new Error("Every object needs a stable id and display label");
        }
        if (objectIds.has(object.id)) {
            throw new Error(`Duplicate object id: ${object.id}`);
        }
        objectIds.add(object.id);
    }

    for (const stateName of REQUIRED_STATES) {
        const state = data.states[stateName];
        if (!state || !Array.isArray(state.relations)) {
            throw new Error(`State ${stateName} must contain a relations array`);
        }
        for (const relation of state.relations) {
            if (!relation.id || !relation.source || !relation.target || !relation.relation) {
                throw new Error(`Incomplete relation in ${stateName}`);
            }
            if (!objectIds.has(relation.source) || !objectIds.has(relation.target)) {
                throw new Error(`Relation ${relation.id} references an unknown object`);
            }
            if (!ALLOWED_RELATION_STATES.has(relation.state)) {
                throw new Error(`Unsupported relation state: ${relation.state}`);
            }
        }
        if (state.evidence && typeof state.evidence.action_success !== "boolean") {
            throw new Error(`Evidence in ${stateName} must use a boolean action_success`);
        }
    }
}

function buildAliasMap(objects) {
    const aliases = new Map();
    for (const object of objects) {
        aliases.set(object.id, object.id);
        for (const alias of object.aliases || []) {
            aliases.set(String(alias), object.id);
        }
    }
    return aliases;
}
