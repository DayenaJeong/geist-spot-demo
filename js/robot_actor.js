import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

/**
 * Presentation-only actor backed by the real visual Spot + Arm asset from
 * rai-opensource/spot_description.  This module contains no physics,
 * telemetry, or replacement primitive robot geometry.
 */
const ROS_TO_THREE = new THREE.Quaternion(-0.5, -0.5, -0.5, 0.5);
const UP = new THREE.Vector3(0, 1, 0);
const SPOT_BODY_LENGTH = 0.87244;

// EDIT THIS BLOCK to tune the presentation pose yourself.  Angles are radians.
// The URL parameters below override these values without editing the file:
//   robotYawDeg, robotRestSh1, robotRestEl0, robotPressSh1, robotPressEl0,
//   robotOffsetX, robotOffsetZ
const EDITABLE_ROBOT_TUNING = {
    yawOffsetDeg: 0,
    restArmPose: {
        arm_sh0: 0.0,
        arm_sh1: 0.0524,
        arm_el0: 0.0349,
        arm_el1: 0.0,
        arm_wr0: 0.0,
        arm_wr1: 0.0,
        arm_f1x: -0.55
    },
    pressArmPose: {
        arm_sh0: 0.0,
        arm_sh1: -0.5061,
        arm_el0: 0.5760,
        arm_el1: 0.0,
        arm_wr0: 0.0,
        arm_wr1: 0.0,
        arm_f1x: -0.30
    },
    positionOffsetX: 0.0,
    positionOffsetZ: 0.0
};

function readRobotTuning() {
    const params = typeof window === "undefined" ? null : new URLSearchParams(window.location.search);
    let saved = {};
    if (typeof window !== "undefined") {
        try {
            saved = JSON.parse(window.localStorage.getItem("geistSpotPoseTuning") || "{}");
        } catch {
            saved = {};
        }
    }
    const number = (key, fallback) => {
        const urlValue = Number(params?.get(key));
        if (Number.isFinite(urlValue)) return urlValue;
        const savedValue = Number(saved?.[key]);
        return Number.isFinite(savedValue) ? savedValue : fallback;
    };
    const parsePosePosition = value => {
        const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : null;
        return values && values.length === 3 && values.every(item => Number.isFinite(Number(item)))
            ? values.map(Number)
            : null;
    };
    const savedPosePosition = (urlKey, name) => parsePosePosition(params?.get(urlKey)) || parsePosePosition(saved?.posePositions?.[name]);
    return {
        yawOffsetRad: THREE.MathUtils.degToRad(number("robotYawDeg", EDITABLE_ROBOT_TUNING.yawOffsetDeg)),
        restArmPose: {
            ...EDITABLE_ROBOT_TUNING.restArmPose,
            arm_sh1: number("robotRestSh1", EDITABLE_ROBOT_TUNING.restArmPose.arm_sh1),
            arm_el0: number("robotRestEl0", EDITABLE_ROBOT_TUNING.restArmPose.arm_el0)
        },
        pressArmPose: {
            ...EDITABLE_ROBOT_TUNING.pressArmPose,
            arm_sh1: number("robotPressSh1", EDITABLE_ROBOT_TUNING.pressArmPose.arm_sh1),
            arm_el0: number("robotPressEl0", EDITABLE_ROBOT_TUNING.pressArmPose.arm_el0)
        },
        positionOffsetX: number("robotOffsetX", EDITABLE_ROBOT_TUNING.positionOffsetX),
        positionOffsetZ: number("robotOffsetZ", EDITABLE_ROBOT_TUNING.positionOffsetZ),
        manualPosePositions: {
            start: savedPosePosition("robotPoseStart", "start"),
            switch_A: savedPosePosition("robotPoseA", "switch_A"),
            switch_B: savedPosePosition("robotPoseB", "switch_B")
        }
    };
}

const ACTIVE_ROBOT_TUNING = readRobotTuning();

const JOINT_AXES = {
    arm_sh0: new THREE.Vector3(0, 0, 1),
    arm_sh1: new THREE.Vector3(0, 1, 0),
    arm_el0: new THREE.Vector3(0, 1, 0),
    arm_el1: new THREE.Vector3(1, 0, 0),
    arm_wr0: new THREE.Vector3(0, 1, 0),
    arm_wr1: new THREE.Vector3(1, 0, 0),
    arm_f1x: new THREE.Vector3(0, 1, 0)
};

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function easeInOut(value) {
    const t = clamp(value, 0, 1);
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function clonePose(pose) {
    return {
        position: pose.position.clone(),
        yaw: pose.yaw
    };
}

export class RobotActor {
    constructor() {
        this.root = new THREE.Group();
        this.root.name = "spot-with-arm-actor";
        this.root.visible = false;
        this.root.renderOrder = 55;

        // Kept separate from the robot root so the world-space target ring is
        // not rotated or scaled by the robot's locomotion pose.
        this.targetMarker = new THREE.Group();
        this.targetMarker.name = "spot-interaction-target";
        this.targetMarker.visible = false;
        this.targetMarker.renderOrder = 58;
        const ringMaterial = new THREE.MeshBasicMaterial({
            color: 0xf0b429,
            transparent: true,
            opacity: 0.78,
            side: THREE.DoubleSide,
            depthTest: false
        });
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.13, 0.155, 32), ringMaterial);
        ring.rotation.x = -Math.PI / 2;
        ring.renderOrder = 58;
        this.targetMarker.add(ring);
        this.targetRing = ring;

        this.loader = new GLTFLoader();
        this.modelRoot = null;
        this.joints = new Map();
        this.modelReady = false;
        this.loadError = null;
        this.configured = false;
        this.floorY = 0;
        this.robotScale = 1;
        this.targets = {};
        this.activeTargetId = null;
        this.motion = null;
        this.pressAnimation = null;
        this.motionResolve = null;
        this.currentPose = null;
        this.yawOffsetRad = ACTIVE_ROBOT_TUNING.yawOffsetRad;
        this.restArmPose = { ...ACTIVE_ROBOT_TUNING.restArmPose };
        this.pressArmPose = { ...ACTIVE_ROBOT_TUNING.pressArmPose };
        this.positionOffset = new THREE.Vector3(
            ACTIVE_ROBOT_TUNING.positionOffsetX,
            0,
            ACTIVE_ROBOT_TUNING.positionOffsetZ
        );
        this.manualPosePositions = {};
        Object.entries(ACTIVE_ROBOT_TUNING.manualPosePositions || {}).forEach(([name, value]) => {
            this.manualPosePositions[name] = value ? new THREE.Vector3(...value) : null;
        });
        this.pressPoints = {};

        this.loadModel();
    }

    loadModel() {
        const assetUrl = new URL("../assets/spot/spot_with_arm.glb", import.meta.url).toString();
        this.loader.load(
            assetUrl,
            gltf => {
                this.modelRoot = gltf.scene;
                this.modelRoot.name = "rai-spot-with-arm-visual";
                this.modelRoot.quaternion.copy(ROS_TO_THREE);
                this.modelRoot.traverse(object => {
                    if (!object.isMesh) return;
                    object.castShadow = false;
                    object.receiveShadow = false;
                    object.frustumCulled = true;
                    object.renderOrder = 50;
                });
                this.root.add(this.modelRoot);
                this.modelRoot.traverse(object => {
                    if (!object.name || !JOINT_AXES[object.name]) return;
                    this.joints.set(object.name, object);
                });
                this.modelReady = true;
                this.applyArmPose(this.restArmPose);
                this.updateVisibility();
            },
            undefined,
            error => {
                this.loadError = error;
                this.modelReady = false;
                console.error("Spot visual asset failed to load; no procedural fallback is used.", error);
            }
        );
    }

    updateVisibility() {
        this.root.visible = Boolean(this.configured && this.modelReady);
    }

    applyArmPose(pose) {
        Object.entries(JOINT_AXES).forEach(([name, axis]) => {
            const joint = this.joints.get(name);
            if (!joint) return;
            const angle = Number(pose[name] ?? 0);
            joint.quaternion.setFromAxisAngle(axis, angle);
        });
    }

    interpolateArmPose(amount) {
        const pose = {};
        Object.keys(this.restArmPose).forEach(name => {
            pose[name] = THREE.MathUtils.lerp(this.restArmPose[name], this.pressArmPose[name], amount);
        });
        return pose;
    }

    getTuning() {
        return {
            yawOffsetDeg: THREE.MathUtils.radToDeg(this.yawOffsetRad),
            restSh1: this.restArmPose.arm_sh1,
            restEl0: this.restArmPose.arm_el0,
            pressSh1: this.pressArmPose.arm_sh1,
            pressEl0: this.pressArmPose.arm_el0,
            offsetX: this.positionOffset.x,
            offsetZ: this.positionOffset.z,
            posePositions: this.getManualPosePositions()
        };
    }

    getManualPosePositions() {
        return Object.fromEntries(Object.entries(this.manualPosePositions).map(([name, position]) => [
            name,
            position ? position.toArray().map(value => Number(value.toFixed(4))) : null
        ]));
    }

    selectEditablePose(name) {
        const poseName = ["start", "switch_A", "switch_B"].includes(name) ? name : "start";
        this.editablePoseName = poseName;
        const pose = this.targets[poseName];
        if (!pose || !this.configured) return false;
        this.cancelAnimation();
        this.root.position.copy(pose.position);
        this.root.rotation.y = pose.yaw;
        this.currentPose = clonePose(pose);
        this.applyArmPose(this.restArmPose);
        return true;
    }

    setEditablePosePosition(name, position) {
        const pose = this.targets[name];
        if (!pose || !position) return false;
        pose.position.copy(position);
        pose.position.y = this.floorY;
        this.manualPosePositions[name] = pose.position.clone();
        if (this.editablePoseName === name) {
            this.root.position.copy(pose.position);
            this.currentPose = clonePose(pose);
        }
        return true;
    }

    setTuning({ yawOffsetDeg, restSh1, restEl0, pressSh1, pressEl0, offsetX, offsetZ } = {}) {
        if (Number.isFinite(yawOffsetDeg)) this.yawOffsetRad = THREE.MathUtils.degToRad(yawOffsetDeg);
        if (Number.isFinite(restSh1)) this.restArmPose.arm_sh1 = restSh1;
        if (Number.isFinite(restEl0)) this.restArmPose.arm_el0 = restEl0;
        if (Number.isFinite(pressSh1)) this.pressArmPose.arm_sh1 = pressSh1;
        if (Number.isFinite(pressEl0)) this.pressArmPose.arm_el0 = pressEl0;
        if (Number.isFinite(offsetX)) this.positionOffset.x = offsetX;
        if (Number.isFinite(offsetZ)) this.positionOffset.z = offsetZ;
        this.applyArmPose(this.restArmPose);
        if (this.configured && this.objectEntries) {
            const activeTarget = this.activeTargetId;
            const editablePose = this.editablePoseName;
            this.configure({ objectEntries: this.objectEntries, floorY: this.floorY });
            if (editablePose) this.selectEditablePose(editablePose);
            if (activeTarget) this.setTarget(activeTarget);
        }
    }

    configure({ objectEntries, floorY = 0 } = {}) {
        this.objectEntries = objectEntries;
        const entryA = objectEntries?.get("switch_A");
        const entryB = objectEntries?.get("switch_B");
        const lamp = objectEntries?.get("lamp");
        if (!entryA || !entryB) {
            this.configured = false;
            this.root.visible = false;
            this.targetMarker.visible = false;
            return false;
        }

        const focusOf = entry => entry.group.localToWorld(entry.focusLocal.clone());
        const centerA = focusOf(entryA);
        const centerB = focusOf(entryB);
        const midpoint = centerA.clone().add(centerB).multiplyScalar(0.5);
        const lampPoint = lamp ? focusOf(lamp) : midpoint.clone().add(new THREE.Vector3(0, 0, 1));
        const towardLamp = lampPoint.clone().sub(midpoint);
        towardLamp.y = 0;
        if (towardLamp.lengthSq() < 1e-6) towardLamp.set(0, 0, 1);
        towardLamp.normalize();

        const switchExtent = Math.max(
            entryA.extent?.x || 0,
            entryA.extent?.y || 0,
            entryA.extent?.z || 0,
            entryB.extent?.x || 0,
            entryB.extent?.y || 0,
            entryB.extent?.z || 0,
            0.08
        );

        // Keep the source model's recognizable proportions while fitting the
        // controlled demo area.  The scale is a scene presentation scale,
        // not a claim about measured robot placement.
        const desiredBodyLength = clamp(switchExtent * 6.4, 0.62, 0.78);
        this.robotScale = desiredBodyLength / SPOT_BODY_LENGTH;
        this.floorY = Number.isFinite(Number(floorY)) ? Number(floorY) : 0;

        const makePose = (position, lookAt) => {
            const ground = position.clone();
            ground.y = this.floorY;
            const direction = lookAt.clone().sub(ground);
            direction.y = 0;
            if (direction.lengthSq() < 1e-6) direction.set(0, 0, 1);
            direction.normalize();
            return {
                position: ground,
                yaw: Math.atan2(direction.x, direction.z) + this.yawOffsetRad
            };
        };

        const switchDistance = clamp(0.84 * this.robotScale, 0.56, 0.78);
        const poseA = makePose(centerA.clone().addScaledVector(towardLamp, switchDistance), centerA);
        const poseB = makePose(centerB.clone().addScaledVector(towardLamp, switchDistance), centerB);
        const perpendicular = new THREE.Vector3(-towardLamp.z, 0, towardLamp.x);
        const startPosition = midpoint.clone()
            .addScaledVector(towardLamp, switchDistance * 1.7)
            .addScaledVector(perpendicular, switchDistance * 1.2);
        const startPose = makePose(startPosition, midpoint);

        const positionOffset = this.positionOffset.clone();
        positionOffset.y = 0;
        [startPose, poseA, poseB].forEach(pose => pose.position.add(positionOffset));
        this.targets = { start: startPose, switch_A: poseA, switch_B: poseB };
        Object.entries(this.manualPosePositions).forEach(([name, position]) => {
            if (position && this.targets[name]) this.targets[name].position.copy(position);
        });
        this.pressPoints = { switch_A: centerA.clone(), switch_B: centerB.clone() };
        this.root.scale.setScalar(this.robotScale);
        this.targetMarker.scale.setScalar(this.robotScale);
        this.root.position.copy(startPose.position);
        this.root.rotation.y = startPose.yaw;
        this.currentPose = clonePose(startPose);
        this.configured = true;
        this.applyArmPose(this.restArmPose);
        this.setTarget(null);
        this.updateVisibility();
        return true;
    }

    setTarget(objectId) {
        this.activeTargetId = objectId ? String(objectId) : null;
        const target = this.activeTargetId === "switch_A"
            ? this.targets.switch_A
            : this.activeTargetId === "switch_B"
                ? this.targets.switch_B
                : null;
        this.targetMarker.visible = Boolean(target && this.configured);
        if (!target) return;
        this.targetMarker.position.copy(target.position);
        this.targetMarker.position.y = this.floorY + 0.012;
        this.targetMarker.scale.setScalar(this.robotScale);
    }

    reset() {
        this.cancelAnimation();
        if (!this.configured) return;
        const start = this.targets.start;
        this.root.position.copy(start.position);
        this.root.rotation.y = start.yaw;
        this.currentPose = clonePose(start);
        this.applyArmPose(this.restArmPose);
        this.setTarget(null);
        this.updateVisibility();
    }

    cancelAnimation() {
        if (this.motionResolve) this.motionResolve(false);
        this.motionResolve = null;
        this.motion = null;
        this.pressAnimation = null;
        this.applyArmPose(this.restArmPose);
    }

    moveTo(targetName, { duration = 1200 } = {}) {
        if (!this.configured || !this.modelReady) return Promise.resolve(false);
        const target = this.targets[targetName] || this.targets.start;
        this.cancelAnimation();
        const start = {
            position: this.root.position.clone(),
            yaw: this.root.rotation.y
        };
        const end = {
            position: target.position.clone(),
            yaw: target.yaw
        };
        if (start.position.distanceTo(end.position) < 1e-4 && Math.abs(start.yaw - end.yaw) < 1e-4) {
            this.root.position.copy(end.position);
            this.root.rotation.y = end.yaw;
            this.currentPose = clonePose(end);
            return Promise.resolve(true);
        }
        this.motion = {
            started: performance.now(),
            duration: Math.max(Number(duration) || 1, 1),
            start,
            end
        };
        return new Promise(resolve => {
            this.motionResolve = resolve;
        });
    }

    press(targetName, { duration = 760 } = {}) {
        if (!this.configured || !this.modelReady) return Promise.resolve(false);
        this.setTarget(targetName);
        this.cancelAnimation();
        this.pressAnimation = {
            started: performance.now(),
            duration: Math.max(Number(duration) || 1, 1)
        };
        return new Promise(resolve => {
            this.motionResolve = resolve;
        });
    }

    update(now) {
        if (!this.configured || !this.modelReady) return;

        if (this.motion) {
            const animation = this.motion;
            const progress = Math.min((now - animation.started) / animation.duration, 1);
            const eased = easeInOut(progress);
            this.root.position.lerpVectors(animation.start.position, animation.end.position, eased);
            this.root.position.y += Math.sin(progress * Math.PI) * 0.018 * this.robotScale;
            this.root.rotation.y = THREE.MathUtils.lerp(animation.start.yaw, animation.end.yaw, eased);
            if (progress >= 1) {
                this.root.position.copy(animation.end.position);
                this.root.rotation.y = animation.end.yaw;
                this.currentPose = clonePose(animation.end);
                const resolve = this.motionResolve;
                this.motionResolve = null;
                this.motion = null;
                resolve?.(true);
            }
        }

        if (this.pressAnimation) {
            const animation = this.pressAnimation;
            const progress = Math.min((now - animation.started) / animation.duration, 1);
            let amount;
            if (progress < 0.28) {
                amount = easeInOut(progress / 0.28);
            } else if (progress < 0.68) {
                amount = 1;
            } else {
                amount = easeInOut((1 - progress) / 0.32);
            }
            this.applyArmPose(this.interpolateArmPose(amount));
            if (progress >= 1) {
                this.applyArmPose(this.restArmPose);
                this.pressAnimation = null;
                const resolve = this.motionResolve;
                this.motionResolve = null;
                resolve?.(true);
            }
        }

        if (this.targetMarker.visible) {
            const pulse = 1 + Math.sin(now * 0.006) * 0.08;
            this.targetMarker.scale.setScalar(this.robotScale * pulse);
        }
    }
}
