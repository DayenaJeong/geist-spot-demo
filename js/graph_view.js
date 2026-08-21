// Interactive vis-network scene-graph renderer.

const NODE_PALETTES = {
    switch: {
        background: "#f7fbfe",
        border: "#4d86ad",
        highlight: { background: "#e2f0f8", border: "#1f5d84" }
    },
    lamp: {
        background: "#fffaf0",
        border: "#b58a37",
        highlight: { background: "#fff1c9", border: "#8f6a22" }
    },
    default: {
        background: "#f7fafc",
        border: "#7a8d9b",
        highlight: { background: "#e9f0f4", border: "#425b6c" }
    }
};

const NODE_SHADOW = {
    enabled: true,
    color: "rgba(21, 48, 71, 0.16)",
    size: 9,
    x: 0,
    y: 4
};

export class GraphView {
    constructor(container, { onNodeSelected }) {
        if (!window.vis) {
            throw new Error("vis-network did not load");
        }

        this.container = container;
        this.onNodeSelected = onNodeSelected;
        this.nodes = new window.vis.DataSet();
        this.edges = new window.vis.DataSet();
        this.edgeStyles = new Map();
        this.network = new window.vis.Network(container, {
            nodes: this.nodes,
            edges: this.edges
        }, this.networkOptions());

        this.network.on("click", params => {
            const nodeId = params.nodes.length > 0 ? String(params.nodes[0]) : null;
            this.onNodeSelected(nodeId, { source: "graph" });
        });

        this.network.once("stabilizationIterationsDone", () => this.network.fit({ animation: false }));
    }

    render(objects, relations) {
        const nodeData = objects.map(object => ({
            id: object.id,
            label: object.label,
            title: `${object.label} · ${object.type || "object"}`,
            level: object.type === "lamp" ? 1 : 0,
            shape: "box",
            margin: { top: 12, right: 18, bottom: 12, left: 18 },
            borderWidth: 1.5,
            shapeProperties: { borderRadius: 11 },
            shadow: NODE_SHADOW,
            color: NODE_PALETTES[object.type] || NODE_PALETTES.default,
            font: {
                face: "Segoe UI, Arial, sans-serif",
                size: 16,
                color: "#17364d",
                bold: { color: "#123d5a", size: 16, face: "Segoe UI, Arial, sans-serif" }
            }
        }));

        const edgeData = relations.map(relation => this.styleRelation(relation));
        this.edgeStyles = new Map(edgeData.map(edge => [edge.id, edge]));
        this.nodes.clear();
        this.edges.clear();
        this.nodes.add(nodeData);
        this.edges.add(edgeData);
        this.network.fit({ animation: { duration: 350, easingFunction: "easeInOutQuad" } });
    }

    styleRelation(relation) {
        const labelLift = relation.state === "removed" ? -14 : 14;
        const common = {
            id: relation.id,
            from: relation.source,
            to: relation.target,
            relationState: relation.state,
            interaction: relation.relation,
            smooth: false,
            font: {
                face: "Segoe UI, Arial, sans-serif",
                size: 12,
                align: "horizontal",
                vadjust: labelLift,
                strokeWidth: 4,
                strokeColor: "#fbfdfe",
                color: "#526879",
                background: "none"
            }
        };

        if (relation.state === "removed") {
            return {
                ...common,
                label: "removed",
                title: "Relation removed: no observable lamp-state change",
                color: { color: "#b9c0c8", highlight: "#ad5e68" },
                font: { ...common.font, color: "#9b4d58", background: "none" },
                width: 2,
                dashes: [8, 8],
                arrows: { to: { enabled: false }, from: { enabled: false } }
            };
        }

        if (relation.state === "verified") {
            return {
                ...common,
                label: `${relation.relation}  ·  verified`,
                title: "Verified: successful press caused Lamp OFF -> ON",
                color: { color: "#25834f", highlight: "#16653b" },
                font: { ...common.font, color: "#207346", background: "none" },
                width: 3,
                dashes: false,
                arrows: { to: { enabled: true, scaleFactor: 1.0 } }
            };
        }

        return {
            ...common,
            label: relation.relation,
            title: "Candidate relation awaiting physical verification",
            color: { color: "#2b78ad", highlight: "#15557f" },
            font: { ...common.font, color: "#23658e", background: "none" },
            width: 2.5,
            dashes: false,
            arrows: { to: { enabled: true, scaleFactor: 1.0 } }
        };
    }

    selectNode(objectId, { focus = true } = {}) {
        if (!objectId || !this.nodes.get(objectId)) {
            this.network.unselectAll();
            return;
        }

        this.network.selectNodes([objectId]);
        if (focus) {
            this.network.focus(objectId, {
                animation: { duration: 400, easingFunction: "easeInOutQuad" }
            });
        }
    }

    highlightRelations(objectId) {
        if (!objectId) {
            this.clearRelationHighlight();
            return;
        }
        const updates = [...this.edgeStyles.values()].map(edge => {
            const active = edge.from === objectId || edge.to === objectId;
            if (!active) return edge;
            return {
                ...edge,
                width: Math.max(Number(edge.width) || 2, 4),
                color: {
                    ...(edge.color || {}),
                    color: this.activeRelationColor(edge.relationState)
                },
                font: { ...(edge.font || {}), size: 15 }
            };
        });
        this.edges.update(updates);
    }

    clearRelationHighlight() {
        this.edges.update([...this.edgeStyles.values()]);
    }

    activeRelationColor(state) {
        if (state === "removed") return "#ad5e68";
        if (state === "verified") return "#16653b";
        return "#15557f";
    }

    clearSelection() {
        this.network.unselectAll();
        this.clearRelationHighlight();
    }

    fit() {
        this.network.fit({ animation: { duration: 350, easingFunction: "easeInOutQuad" } });
    }

    networkOptions() {
        return {
            layout: {
                improvedLayout: true,
                hierarchical: {
                    enabled: true,
                    direction: "LR",
                    sortMethod: "directed",
                    levelSeparation: 170,
                    nodeSpacing: 110,
                    treeSpacing: 140
                }
            },
            nodes: {
                shape: "box",
                borderWidth: 1.5,
                shadow: NODE_SHADOW,
                chosen: true
            },
            edges: {
                arrows: { to: { enabled: true, scaleFactor: 0.72 } },
                smooth: { type: "cubicBezier", forceDirection: "horizontal", roundness: 0.28 },
                selectionWidth: 2,
                hoverWidth: 1.2,
                arrowStrikethrough: false
            },
            physics: {
                enabled: false,
                stabilization: { iterations: 0 }
            },
            interaction: {
                hover: true,
                tooltipDelay: 220,
                dragNodes: true,
                zoomView: true,
                dragView: true
            }
        };
    }
}
