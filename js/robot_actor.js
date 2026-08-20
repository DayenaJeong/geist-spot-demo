import * as THREE from "three";

/**
 * Presentation-only Spot proxy.
 *
 * The actor is deliberately procedural and illustrative: it interpolates
 * between scene-derived poses and shows a restrained press cue. It does not
 * represent measured Spot telemetry or a physics simulation.
 */
const UP = new THREE.Vector3(0, 1, 0);

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function easeInOut(value) {
    const t = clamp(value, 0, 1);
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function box(width, height, depth, material, position = [0, 0, 0]) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
    mesh.position.set(...position);
    mesh.renderOrder = 55;
    return mesh;
}

export class RobotActor {
    constructor() {
        this.root = new THREE.Group();
        this.root.name = "illustrative-spot-actor";
        this.root.visible = false;
        this.root.renderOrder = 55;

        this.targetMarker = new THREE.Group();
        this.targetMarker.name = "spot-interaction-target";
        this.targetMarker.visible = false;
        this.targetMarker.renderOrder = 58;

        this.targets = {};
        this.activeTargetId = null;
        this.motion = null;
        this.pressAnimation = null;
        this.motionResolve = null;
        this.configured = false;
        this.floorY = 0;
        this.robotScale = 1;
        this.currentPose = null;
        this.legGroups = [];

        this.buildProxy();
    }

    buildProxy() {
        const bodyMaterial = new THREE.MeshBasicMaterial({ color: 0x172f43, transparent: true, opacity: 0.98, depthTest: false });
        const panelMaterial = new THREE.MeshBasicMaterial({ color: 0x3f8fc4, transparent: true, opacity: 0.98, depthTest: false });
        const legMaterial = new THREE.MeshBasicMaterial({ color: 0x6b7f8f, transparent: true, opacity: 0.98, depthTest: false });
        const jointMaterial = new THREE.MeshBasicMaterial({ color: 0xd5e1e8, transparent: true, opacity: 0.98, depthTest: false });
        const accentMaterial = new THREE.MeshBasicMaterial({ color: 0xf0b429, transparent: true, opacity: 0.98, depthTest: false });

        const body = box(0.34, 0.16, 0.24, bodyMaterial, [0, 0.28, 0]);
        const topPanel = box(0.20, 0.055, 0.15, panelMaterial, [0, 0.39, 0]);
        const head = box(0.14, 0.10, 0.12, bodyMaterial, [0, 0.35, 0.15]);
        const sensor = new THREE.Mesh(new THREE.SphereGeometry(0.026, 10, 8), accentMaterial);
        sensor.position.set(0, 0.36, 0.225);
        sensor.renderOrder = 57;
        this.root.add(body, topPanel, head, sensor);

        const legOffsets = [
            [-1, -1], [1, -1], [-1, 1], [1, 1]
        ];
        legOffsets.forEach(([side, front], index) => {
            const leg = new THREE.Group();
            leg.position.set(side * 0.125, 0.22, front * 0.075);
            leg.name = `spot-leg-${index + 1}`;
            const upper = box(0.045, 0.13, 0.045, legMaterial, [0, -0.065, 0]);
            const lower = box(0.04, 0.11, 0.04, jointMaterial, [side * 0.025, -0.16, front * 0.012]);
            const foot = box(0.075, 0.035, 0.095, bodyMaterial, [side * 0.025, -0.235, front * 0.018]);
            leg.add(upper, lower, foot);
            this.root.add(leg);
            this.legGroups.push(leg);
        });

        const pressCueMaterial = new THREE.LineBasicMaterial({
            color: 0xf0b429,
            transparent: true,
            opacity: 0.95,
            depthTest: false
        });
        const pressCueGeometry = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 0, 0),
            new THREE.Vector3(0, 0, 0.42)
        ]);
        this.pressCue = new THREE.Group();
        this.pressCue.name = "spot-press-cue";
        this.pressCue.position.set(0, 0.335, 0.14);
        this.pressCue.add(new THREE.Line(pressCueGeometry, pressCueMaterial));
        const pressTip = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), accentMaterial);
        pressTip.position.set(0, 0, 0.42);
        this.pressCue.add(pressTip);
        this.pressCue.visible = false;
        this.root.add(this.pressCue);

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
    }

    configure({ objectEntries, floorY = 0 } = {}) {
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
        const desiredBodyWidth = clamp(switchExtent * 3.2, 0.24, 0.48);
        this.robotScale = desiredBodyWidth / 0.34;
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
                yaw: Math.atan2(direction.x, direction.z)
            };
        };

        const switchDistance = clamp(0.52 * this.robotScale, 0.42, 0.72);
        const poseA = makePose(centerA.clone().addScaledVector(towardLamp, switchDistance), centerA);
        const poseB = makePose(centerB.clone().addScaledVector(towardLamp, switchDistance), centerB);
        const perpendicular = new THREE.Vector3(-towardLamp.z, 0, towardLamp.x);
        const startPosition = midpoint.clone()
            .addScaledVector(towardLamp, switchDistance * 1.7)
            .addScaledVector(perpendicular, switchDistance * 1.2);
        const startPose = makePose(startPosition, midpoint);

        this.targets = { start: startPose, switch_A: poseA, switch_B: poseB };
        this.root.scale.setScalar(this.robotScale);
        this.targetMarker.scale.setScalar(this.robotScale);
        this.root.position.copy(startPose.position);
        this.root.rotation.y = startPose.yaw;
        this.currentPose = { position: startPose.position.clone(), yaw: startPose.yaw };
        this.configured = true;
        this.root.visible = true;
        this.setTarget(null);
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
    }

    reset() {
        this.cancelAnimation();
        if (!this.configured) return;
        const start = this.targets.start;
        this.root.visible = true;
        this.root.position.copy(start.position);
        this.root.rotation.y = start.yaw;
        this.currentPose = { position: start.position.clone(), yaw: start.yaw };
        this.pressCue.visible = false;
        this.setTarget(null);
    }

    cancelAnimation() {
        if (this.motionResolve) this.motionResolve(false);
        this.motionResolve = null;
        this.motion = null;
        this.pressAnimation = null;
        this.pressCue.visible = false;
    }

    moveTo(targetName, { duration = 1200 } = {}) {
        if (!this.configured) return Promise.resolve(false);
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
            this.currentPose = { position: end.position.clone(), yaw: end.yaw };
            return Promise.resolve(true);
        }
        this.pressCue.visible = false;
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
        if (!this.configured) return Promise.resolve(false);
        this.setTarget(targetName);
        this.cancelAnimation();
        this.pressAnimation = {
            started: performance.now(),
            duration: Math.max(Number(duration) || 1, 1)
        };
        this.pressCue.visible = true;
        return new Promise(resolve => {
            this.motionResolve = resolve;
        });
    }

    update(now) {
        if (!this.configured) return;
        if (this.motion) {
            const animation = this.motion;
            const progress = Math.min((now - animation.started) / animation.duration, 1);
            const eased = easeInOut(progress);
            this.root.position.lerpVectors(animation.start.position, animation.end.position, eased);
            this.root.position.y += Math.sin(progress * Math.PI) * 0.025 * this.robotScale;
            this.root.rotation.y = THREE.MathUtils.lerp(animation.start.yaw, animation.end.yaw, eased);
            this.animateLegs(progress);
            if (progress >= 1) {
                this.root.position.copy(animation.end.position);
                this.currentPose = { position: animation.end.position.clone(), yaw: animation.end.yaw };
                const resolve = this.motionResolve;
                this.motionResolve = null;
                this.motion = null;
                resolve?.(true);
            }
        } else {
            this.animateLegs(0);
        }

        if (this.pressAnimation) {
            const animation = this.pressAnimation;
            const progress = Math.min((now - animation.started) / animation.duration, 1);
            const pulse = progress < 0.5 ? easeInOut(progress * 2) : easeInOut((1 - progress) * 2);
            this.pressCue.scale.set(1, 1, 0.46 + pulse * 0.54);
            this.pressCue.visible = true;
            if (progress >= 1) {
                this.pressCue.visible = false;
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

    animateLegs(progress) {
        const walking = Boolean(this.motion);
        const phase = walking ? Math.sin(progress * Math.PI * 8) * 0.16 : 0;
        this.legGroups.forEach((leg, index) => {
            const sign = index % 2 === 0 ? 1 : -1;
            leg.rotation.z = phase * sign;
        });
    }
}
