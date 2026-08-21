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

## Manual robot-pose tuning

To tune the presentation without changing the scene or evidence logic, edit
`js/robot_actor.js` at `EDITABLE_ROBOT_TUNING`. Angles are radians. You can
also test values directly in the URL, for example:

```text
?robotYawDeg=180&robotRestSh1=-1.40&robotRestEl0=2.00&robotPressSh1=0.00&robotPressEl0=0.00
```

The supported URL overrides are `robotYawDeg`, `robotRestSh1`,
`robotRestEl0`, `robotPressSh1`, and `robotPressEl0`.

To edit the pose directly in the browser, open the demo with `?tune=1`:
`https://dayenajeong.github.io/spot-functional-relation-demo/?tune=1`
(or append `?tune=1` to a local URL). Drag the five sliders for body yaw,
rest-arm shoulder/elbow, and press-arm shoulder/elbow. Changes apply live;
`Copy URL` preserves the selected pose in a shareable URL, and `Reset` returns
to the pose loaded at page start. This panel changes only the presentation
actor and does not modify the point cloud, graph, or evidence sequence.

The panel also exposes Position X and Position Z offsets in scene meters.
Press `Save pose` to store all seven values in this browser; the saved pose
is restored on the next `?tune=1` visit. `Copy URL` creates a shareable pose
that takes precedence over the browser-saved pose.

For keyframe editing, choose `Initial`, `Switch A`, or `Switch B` in the panel,
then click and drag the visible Spot body in the 3D view. `Save keyframes`
stores all three positions in this browser. The press animation keeps the body position fixed and moves only the
arm/gripper a short distance toward the switch before returning; it remains a
presentation-only animation.
