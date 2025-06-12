import json
import os

def extract_pathfinding_inputs(request):
    if request.method != "POST":
        return {"error": "POST required"}, 405

    try:
        data = json.loads(request.body)

        start = data.get("start")
        ziel = data.get("ziel")
        map_file = data.get("mapFile")
        routes = data.get("route", [])  # Optional, default to empty list

        if not start or not ziel or not map_file:
            return {"error": "Missing start, ziel, or mapFile"}, 400

        train_scale = 0.710
        start_x = int(start["x"] / train_scale)
        start_y = int(start["y"] / train_scale)
        ziel_x = int(ziel["x"] / train_scale)
        ziel_y = int(ziel["y"] / train_scale)

        # Scale route points
        scaled_routes = []
        for route in routes:
            rP = route.get("rP", [])
            scaled_rP = [
                {
                    "x": int(pt["x"] / train_scale),
                    "y": int(pt["y"] / train_scale)
                } for pt in rP
            ]
            scaled_routes.append({**route, "rP": scaled_rP})

        filename = os.path.splitext(os.path.basename(map_file))[0]

        return {
            "start": (start_x, start_y),
            "ziel": (ziel_x, ziel_y),
            "filename": filename,
            "routes": scaled_routes
        }, 200

    except Exception as e:
        return {"error": f"Exception occurred: {str(e)}"}, 500
