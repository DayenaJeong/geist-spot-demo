# Spot Functional Graph Verification Demo

Interactive real-robot demonstration of physical functional-relation
verification using Spot, a 3D scene view, and evidence-grounded graph updates.

## Demonstration

- Switch A: successful press, no observable lamp-state change; relation removed.
- Switch B: successful press, observable OFF -> ON lamp-state change; relation verified.
- Click graph nodes or 3D objects to synchronize selection.
- Use Before Verification, After Switch A, and After Switch B to inspect states.
- Use Auto Demo to play the approved evidence sequence without reloading.
- Auto Demo includes a lightweight illustrative Spot proxy that walks to each
  switch and shows a short press cue before the existing graph update.

The proxy is presentation-only; it is not a measured Spot trajectory or a
physics simulation. The existing point cloud, graph states, evidence videos,
and object-selection behavior remain unchanged.

## Run locally

~~~bash
python3 -m http.server 9000
~~~

Open the address printed by the local server.

All runtime asset references are relative, so the site works at a domain root
and under a GitHub Pages project subpath.
