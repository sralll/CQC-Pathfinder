import numpy as np
import heapq
from typing import List, Tuple, Optional

def heuristic(a: Tuple[int, int], b: Tuple[int, int]) -> float:
    return np.hypot(b[0] - a[0], b[1] - a[1])

def a_star(grid: np.ndarray, start: Tuple[int, int], goal: Tuple[int, int]) -> Optional[List[Tuple[int, int]]]:
    if start == goal:
        return [start]

    h, w = grid.shape
    open_list = []
    heapq.heappush(open_list, (heuristic(start, goal), 0, start))
    came_from = {}
    g_score = np.full(grid.shape, np.inf)
    g_score[start[1], start[0]] = 0
    closed_set = set()

    while open_list:
        _, cost, current = heapq.heappop(open_list)
        if current in closed_set:
            continue
        closed_set.add(current)

        if current == goal:
            path = [current]
            while current in came_from:
                current = came_from[current]
                path.append(current)
            return path[::-1]

        for dx in [-1, 0, 1]:
            for dy in [-1, 0, 1]:
                if dx == 0 and dy == 0:
                    continue
                neighbor = (current[0] + dx, current[1] + dy)
                if not (0 <= neighbor[0] < w and 0 <= neighbor[1] < h):
                    continue
                if grid[neighbor[1], neighbor[0]] == 0:
                    continue
                move_cost = np.hypot(dx, dy) * (255 - grid[neighbor[1], neighbor[0]])
                tentative_g = cost + move_cost
                if tentative_g < g_score[neighbor[1], neighbor[0]]:
                    g_score[neighbor[1], neighbor[0]] = tentative_g
                    f_score = tentative_g + heuristic(neighbor, goal)
                    # Push with normal f_score
                    heapq.heappush(open_list, (f_score, tentative_g, neighbor))
                    came_from[neighbor] = current
    return None

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

def get_a_star_turns(path: list):
    if len(path) < 3:
        return path  # Not enough points for meaningful angle analysis

    waypoints = [path[0]]
    prev_vector = np.array(path[1]) - np.array(path[0])
    last_turn_dir = 0
    last_index = 0
    for i in range(1, len(path) - 1):
        curr_vector = np.array(path[i+1]) - np.array(path[i])
        curr_turn_dir = np.sign(prev_vector[0] * curr_vector[1] - prev_vector[1] * curr_vector[0])
        if curr_turn_dir == 0:
            continue
        else:
            if last_turn_dir == curr_turn_dir:
                waypoints.append(path[last_index])
                last_turn_dir = 0
            else:
                last_turn_dir = curr_turn_dir
            last_index = i
        prev_vector = curr_vector
    return waypoints

def simplify_wps(
    waypoints: list[tuple], 
    grid: np.ndarray, 
    min_distance: float = 10
) -> list[tuple]:
    simplified = []
    i = 0
    while i < len(waypoints):
        simplified.append(waypoints[i])
        next_i = i + 1
        for j in range(len(waypoints) - 1, i, -1):
            dist = np.hypot(waypoints[j][0] - waypoints[i][0], waypoints[j][1] - waypoints[i][1])
            if dist < min_distance:
                # Don't skip points that are too close
                continue
            if has_line_of_sight(grid, waypoints[i], waypoints[j]):
                next_i = j
                break
        i = next_i
    print(f"Reduced A* path from {len(waypoints)} to {len(simplified)} waypoints")
    return simplified