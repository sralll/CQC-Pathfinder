from django.core.files.storage import default_storage


from typing import Tuple, Optional
from collections import deque 
from typing import Union
from PIL import Image
import numpy as np

from .a_star import a_star

def bresenham_line(x0, y0, x1, y1):
    points = []
    dx = abs(x1 - x0)
    dy = -abs(y1 - y0)
    sx = 1 if x0 < x1 else -1
    sy = 1 if y0 < y1 else -1
    err = dx + dy
    while True:
        points.append((x0, y0))
        if x0 == x1 and y0 == y1:
            break
        e2 = 2 * err
        if e2 >= dy:
            err += dy
            x0 += sx
        if e2 <= dx:
            err += dx
            y0 += sy
    return points

def circular_mask(radius):
    """Returns a list of (dx, dy) offsets in a circular disk of given radius."""
    r2 = radius ** 2
    return [(dx, dy) for dx in range(-radius, radius+1)
                     for dy in range(-radius, radius+1)
                     if dx*dx + dy*dy <= r2]

def generate_corridor_mask_numpy(waypoints, grid_shape, radius=3):
    """Generate a binary mask covering a corridor along waypoint lines."""
    h, w = grid_shape
    mask = np.zeros((h, w), dtype=np.uint8)
    disk = circular_mask(radius)

    for (x0, y0), (x1, y1) in zip(waypoints, waypoints[1:]):
        line_points = bresenham_line(int(x0), int(y0), int(x1), int(y1))
        for x, y in line_points:
            for dx, dy in disk:
                nx, ny = x + dx, y + dy
                if 0 <= nx < w and 0 <= ny < h:
                    mask[ny, nx] = 1  # Note: (row, col) = (y, x)

    return mask

def load_mask(data):
    filename = data.get("filename")

    mask_path = f"masks/mask_{filename}.png"

    if not default_storage.exists(mask_path):
        return None, f"Keine Maske für Karte gefunden."

    with default_storage.open(mask_path, 'rb') as f:
        mask = Image.open(f).convert("L")

    return mask, None

def extract_subgrid(
    grid: np.ndarray,
    start: Union[tuple[int, int], dict],
    goal: Union[tuple[int, int], dict],
    routes: Optional[list] = None,
    margin: int = 25
) -> tuple[np.ndarray, tuple[int, int], tuple[int, int], tuple[int, int], Optional[list]]:
    h, w = grid.shape

    # Handle JSON-style dicts
    if isinstance(start, dict):
        start = (start["x"], start["y"])
    if isinstance(goal, dict):
        goal = (goal["x"], goal["y"])

    x_vals = [start[0], goal[0]]
    y_vals = [start[1], goal[1]]

    x_min = max(min(x_vals) - margin, 0)
    x_max = min(max(x_vals) + margin, w - 1)
    y_min = max(min(y_vals) - margin, 0)
    y_max = min(max(y_vals) + margin, h - 1)

    subgrid = grid[y_min:y_max+1, x_min:x_max+1].copy()

    # Optional: block subgrid edges to prevent escaping
    subgrid[0, :] = 0
    subgrid[-1, :] = 0
    subgrid[:, 0] = 0
    subgrid[:, -1] = 0

    # Shift coordinates
    start_sub = (start[0] - x_min, start[1] - y_min)
    goal_sub = (goal[0] - x_min, goal[1] - y_min)

    # Adjust route points to subgrid coordinates
    if routes:
        adjusted_routes = []
        for route in routes:
            adjusted_rP = [
                {
                    "x": int(p["x"] - x_min),
                    "y": int(p["y"] - y_min)
                }
                for p in route.get("rP", [])
            ]
            adjusted_routes.append({**route, "rP": adjusted_rP})
    else:
        adjusted_routes = None

    return subgrid, (x_min, y_min), start_sub, goal_sub, adjusted_routes

def inflate_obstacles(grid: np.ndarray, radius: int = 1, dilation_block: int = 100) -> np.ndarray: # tune
    h, w = grid.shape
    inflated_grid = grid.copy()

    for y in range(h):
        for x in range(w):
            # Only consider non-obstacle pixels
            if grid[y, x] != 0:
                # Check neighbors within radius
                for dy in range(-radius, radius + 1):
                    for dx in range(-radius, radius + 1):
                        ny, nx = y + dy, x + dx
                        if 0 <= ny < h and 0 <= nx < w:
                            if grid[ny, nx] == 0:
                                inflated_grid[y, x] = dilation_block
                                break
                    else:
                        continue
                    break

    return inflated_grid

def move_to_nearest_free(grid: np.ndarray, point: Tuple[int, int]) -> Optional[Tuple[int, int]]:
    h, w = grid.shape
    x0, y0 = point

    if not (0 <= x0 < w and 0 <= y0 < h):
        return None  # Outside grid
    if grid[y0, x0] != 0:
        return (x0, y0)  # Already free

    visited = np.zeros((h, w), dtype=bool)
    queue = deque([(x0, y0)])

    directions = [(-1, 0), (1, 0), (0, -1), (0, 1),
                  (-1, -1), (-1, 1), (1, -1), (1, 1)]  # 8-connectivity

    while queue:
        x, y = queue.popleft()
        for dx, dy in directions:
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and not visited[ny, nx]:
                visited[ny, nx] = True
                if grid[ny, nx] != 0:
                    return (nx, ny)  # Found nearest free cell
                queue.append((nx, ny))

    return None  # No reachable free cell found

def euclidean(p1, p2):
    return np.linalg.norm(np.array(p1) - np.array(p2))

def draw_route_mask(
    subgrid: np.ndarray,
    routes: list,
    start: tuple[int, int],
    ziel: tuple[int, int],
    width: int = 5
) -> np.ndarray:
    total_distance = euclidean(start, ziel)
    output = subgrid.copy()

    if routes is None or len(routes) == 0:
        return subgrid

    for route in routes:
        route_points = [(pt['x'], pt['y']) for pt in route['rP']]
        for i in range(len(route_points) - 1):
            p1 = route_points[i]
            p2 = route_points[i + 1]
            line_pixels = bresenham_line(p1[0], p1[1], p2[0], p2[1])
            for px, py in line_pixels:
                dist_start = euclidean((px, py), start)
                dist_end = euclidean((px, py), ziel)
                if dist_start / total_distance < 0.4 or dist_end / total_distance < 0.4: #tune
                    continue
                if 0 <= px < output.shape[1] and 0 <= py < output.shape[0]:
                    radius = int(min(dist_start, dist_end) / 7) #tune
                    y_min = max(0, py - radius)
                    y_max = min(output.shape[0], py + radius + 1)
                    x_min = max(0, px - radius)
                    x_max = min(output.shape[1], px + radius + 1)

                    yy, xx = np.ogrid[y_min:y_max, x_min:x_max]
                    mask = (xx - px)**2 + (yy - py)**2 <= radius**2
                    output[y_min:y_max, x_min:x_max][mask] = 0
    return output

def find_path_with_margin_growth(
    grid: np.ndarray,
    start: Tuple[int, int],
    goal: Tuple[int, int],
    routes: list,
    initial_margin: int = 50,
    max_margin: int = 400,
    step: int = 50
):
    margin = initial_margin
    path = None
    last_exception = None

    while margin <= max_margin:
        try:
            subgrid, offset, start_cP, ziel_cP, routes_cP = extract_subgrid(
                grid=grid,
                start=start,
                goal=goal,
                routes=routes,
                margin=margin,
            )

            subgrid = draw_route_mask(subgrid, routes_cP, start_cP, ziel_cP, width=25)
            start_cP = move_to_nearest_free(subgrid, start_cP)
            ziel_cP = move_to_nearest_free(subgrid, ziel_cP)

            path = a_star(subgrid, start_cP, ziel_cP)
            if path is not None:
                print(f"Path found with margin {margin}")
                return path, subgrid, offset, start_cP, ziel_cP
        except Exception as e:
            last_exception = e

        print(f"No path found with margin {margin}, increasing...")
        margin += step

    # After loop, if still no path
    print("Failed to find a path with all margin sizes.")
    if last_exception:
        print("Last error:", last_exception)
    return None, None, None, None, None