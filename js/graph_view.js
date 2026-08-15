// Interactive vis-network scene-graph renderer.

const NODE_COLORS = {
    background: "#e8f1f8",
    border: "#1f5a85",
    highlight: {
        background: "#cfe5f5",
        border: "#0d426a"
    }
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
            shape: "box",
            margin: 13,
            color: NODE_COLORS,
            font: {
                face: "Arial",
                size: 17,
                color: "#16334a"
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
        const common = {
            id: relation.id,
            from: relation.source,
            to: relation.target,
            relationState: relation.state,
            interaction: relation.relation,
            smooth: { type: "continuous" },
            font: {
                face: "Arial",
                size: 14,
                align: "middle",
                strokeWidth: 0
            }
        };

        if (relation.state === "removed") {
            return {
                ...common,
                label: "×  REMOVED",
                title: "Relation removed: no observable lamp-state change",
                color: { color: "#b9c0c8", highlight: "#ad5e68" },
                font: { ...common.font, color: "#9b4d58", background: "#f7f8fa" },
                width: 2,
                dashes: [8, 8],
                arrows: { to: { enabled: false }, from: { enabled: false } }
            };
        }

        if (relation.state === "verified") {
            return {
                ...common,
                label: `${relation.relation}\nVERIFIED`,
                title: "Verified: successful press caused Lamp OFF -> ON",
                color: { color: "#25834f", highlight: "#16653b" },
                font: { ...common.font, color: "#207346", background: "#f4fbf6" },
                width: 3,
                dashes: false,
                arrows: { to: { enabled: true, scaleFactor: 0.85 } }
            };
        }

        return {
            ...common,
            label: `${relation.relation} ?`,
            title: "Candidate relation awaiting physical verification",
            color: { color: "#2b78ad", highlight: "#15557f" },
            font: { ...common.font, color: "#23658e" },
            width: 2,
            dashes: false,
            arrows: { to: { enabled: true, scaleFactor: 0.8 } }
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
            layout: { improvedLayout: true, hierarchical: { enabled: false } },
            nodes: { shape: "box", borderWidth: 1.5, shadow: false },
            edges: {
                arrows: { to: { enabled: true, scaleFactor: 0.8 } },
                smooth: { type: "continuous" },
                selectionWidth: 1.5
            },
            physics: {
                enabled: true,
                solver: "barnesHut",
                barnesHut: { springLength: 150, springConstant: 0.018, damping: 0.24, avoidOverlap: 0.2 },
                stabilization: { iterations: 120 }
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
