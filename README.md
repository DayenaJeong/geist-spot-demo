# Spot Functional Graph Verification Demo

Interactive real-robot demonstration of physical functional-relation
verification using Spot, a 3D scene view, and evidence-grounded graph updates.

## Demonstration

- Switch A: successful press, no observable lamp-state change; relation removed.
- Switch B: successful press, observable OFF -> ON lamp-state change; relation verified.
- Click graph nodes or 3D objects to synchronize selection.
- Use Before Verification, After Switch A, and After Switch B to inspect states.
- Use Auto Demo to play the approved evidence sequence without reloading.
- Auto Demo includes the upstream visual Spot-with-Arm asset, moves it to
  each switch, and animates the real arm/gripper visual before the existing
  graph update.

The model is presentation-only; it is not measured Spot telemetry or a
physics simulation. The existing point cloud, graph states, evidence videos,
and object-selection behavior remain unchanged. The model source and
MIT/BSD notices are included under assets/spot/.

## Run locally

~~~bash
python3 -m http.server 9000
~~~

Open the address printed by the local server.

All runtime asset references are relative, so the site works at a domain root
and under a GitHub Pages project subpath.
