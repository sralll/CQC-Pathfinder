import numpy as np
from typing import Tuple, List
from functools import lru_cache
import heapq
import math
from PIL import Image

def heuristic(a: Tuple[int, int], b: Tuple[int, int]) -> float:
    return np.hypot(b[0] - a[0], b[1] - a[1])

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

def has_line_of_sight(grid: np.ndarray, p1: Tuple[int, int], p2: Tuple[int, int]) -> bool:
    for x, y in bresenham_line(p1[0], p1[1], p2[0], p2[1]):
        if grid[y, x] == 0:
            return False
    return True

def signed_angle(v1, v2):
    angle1 = math.atan2(v1[1], v1[0])
    angle2 = math.atan2(v2[1], v2[0])
    angle_deg = math.degrees(angle2 - angle1)

    # Wrap to [-180, +180]
    if angle_deg > 180:
        angle_deg -= 360
    elif angle_deg < -180:
        angle_deg += 360

    return angle_deg

def make_los_cached(grid: np.ndarray):
    @lru_cache(maxsize=100_000)
    def cached_los(p1: Tuple[int, int], p2: Tuple[int, int]) -> bool:
        return has_line_of_sight(grid, p1, p2)
    return cached_los

def make_terrain_los_cached(grid: np.ndarray):
    def get_ref_speed(p: Tuple[int, int]) -> int:
        return grid[p[1], p[0]]

    @lru_cache(maxsize=100_000)
    def cached_terrain_los(p1: Tuple[int, int], p2: Tuple[int, int]) -> bool:
        ref_speed = get_ref_speed(p1)
        for x, y in bresenham_line(p1[0], p1[1], p2[0], p2[1])[1:]:  # Skip first point
            if grid[y, x] != ref_speed:
                return False
        return True

    return cached_terrain_los


def save_grayscale_image(array, filename='visited.png'):
    # Avoid division by zero
    if array.max() > 0:
        norm_array = (array / array.max()) * 255
        print(f"Normalizing array with max value {array.max()}")
    else:
        norm_array = array

    image = Image.fromarray(norm_array.astype(np.uint8), mode='L')  # 'L' for grayscale
    image.save(filename)
    print(f"Image saved as {filename}")

def guided_theta_star(grid, start, goal, waypoints, switch_radius=20, cached_los=None):
    h, w = grid.shape
    open_list = []
    g_score = {start: 0}
    parent = {start: start}
    heapq.heappush(open_list, (heuristic(start, goal), start))
    closed_set = set()

    visited = np.zeros_like(grid)

    guidance_index = 0
    total_waypoints = len(waypoints)

    while open_list:
        _, current = heapq.heappop(open_list)

        visited[current[1], current[0]] += 1

        if current in closed_set:
            continue
        closed_set.add(current)

        if current == goal:
            path = [current]
            while current != parent[current]:
                current = parent[current]
                path.append(current)
            yield {"done": True, "path": path[::-1]}
            save_grayscale_image(visited, 'visited.png')
            return

        # Yield progress when switching waypoint
        while (guidance_index + 1 < total_waypoints and
               np.linalg.norm(np.array(current) - np.array(waypoints[guidance_index])) < switch_radius):
            guidance_index += 1
            yield {
                "waypoint": guidance_index,
                "total": total_waypoints,
                "current": current
            }

        guidance_target = waypoints[guidance_index] if guidance_index < total_waypoints else goal

        for dx in [-1, 0, 1]:
            for dy in [-1, 0, 1]:
                if dx == 0 and dy == 0:
                    continue
                neighbor = (current[0] + dx, current[1] + dy)
                if not (0 <= neighbor[0] < w and 0 <= neighbor[1] < h):
                    continue
                if grid[neighbor[1], neighbor[0]] == 0:
                    continue
                if neighbor in closed_set:
                    continue

                cost = (255 - grid[neighbor[1], neighbor[0]])

                if cached_los(parent[current], neighbor):
                    cand_parent = parent[current]
                    los_path = bresenham_line(cand_parent[0], cand_parent[1], neighbor[0], neighbor[1])
                    ref_speed = grid[cand_parent[1], cand_parent[0]]
                    same_terrain = all(grid[y, x] == ref_speed for x, y in los_path[1:])
                    if same_terrain:
                        distance = np.hypot(neighbor[0] - cand_parent[0], neighbor[1] - cand_parent[1])
                        cand_g = g_score[cand_parent] + distance * cost
                    else:
                        cand_parent = current
                        distance = np.hypot(neighbor[0] - current[0], neighbor[1] - current[1])
                        cand_g = g_score[current] + distance * cost
                else:
                    cand_parent = current
                    penalty = (255 - grid[neighbor[1], neighbor[0]])
                    distance = np.hypot(neighbor[0] - current[0], neighbor[1] - current[1])
                    cand_g = g_score[current] + distance + penalty

                if neighbor not in g_score or cand_g < g_score[neighbor]:
                    g_score[neighbor] = cand_g
                    parent[neighbor] = cand_parent
                    f_score = cand_g + heuristic(neighbor, guidance_target)
                    heapq.heappush(open_list, (f_score, neighbor))

    yield {"error": "No path found"}

def simplify_theta_path(
    path: List[Tuple[int, int]],
    angle_threshold_deg: float = 10.0,
    distance_threshold: float = 5.0
) -> List[Tuple[int, int]]:
    if len(path) < 3:
        return path[:]

    simplified = [path[0]]
    prev_angle_sign = None

    for i in range(1, len(path) - 1):
        p_prev = path[i - 1]
        p_curr = path[i]
        p_next = path[i + 1]

        v1 = (p_curr[0] - p_prev[0], p_curr[1] - p_prev[1])
        v2 = (p_next[0] - p_curr[0], p_next[1] - p_curr[1])

        mag1 = math.hypot(*v1)
        mag2 = math.hypot(*v2)

        if mag1 == 0 or mag2 == 0:
            continue

        # Compute angle and its sign
        angle = signed_angle(v1, v2)
        angle_abs = abs(angle)
        angle_sign = math.copysign(1, angle) if angle_abs >= angle_threshold_deg else prev_angle_sign
        # --- Decision logic ---
        # 1. Keep if either distance is large
        if mag1 > distance_threshold or mag2 > distance_threshold:
            simplified.append(p_curr)

        # 2. Skip if angle is almost zero
        elif angle_abs < angle_threshold_deg:
            continue

        # 3. Keep if angle sign matches previous
        elif angle_sign == prev_angle_sign:
            simplified.append(p_curr)

        # 4. Keep only if distance is large when sign flips
        elif mag1 > distance_threshold or mag2 > distance_threshold:
            simplified.append(p_curr)

        # else: don't keep
        prev_angle_sign = angle_sign

    simplified.append(path[-1])
    return simplified