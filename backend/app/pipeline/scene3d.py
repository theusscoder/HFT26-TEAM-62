"""The 3D reconstruction's data, derived from the footage and checked against it.

  camera   The real CCTV camera (position, orientation, focal length) solved from the road homography, so the 3D scene
           can be viewed from exactly where the footage was shot.
  plate    A clean background: per-pixel median over the clip, ignoring every detection box. Projected from the solved
           camera onto the ground and proxy walls, this is the real place, not a drawing of it.
  tracks   For each road user: size fitted to its detector boxes within its class's real range, vehicle centre (a box's
           bottom edge is the near side, not the middle), smoothed path, heading from motion.
  textures Each vehicle's visible faces, rectified out of its best frame.
  actors   Who each road user is. A person whose box rides on a bike's box is that bike's rider (rule). Qwen vision looks
           at a crop of each one and says what it sees: a person alone on the road on a bike the detector missed, an
           auto-rickshaw the detector called a car. It changes what's drawn, never a measurement.
  fit      Every fitted box is projected back into the frame and compared with what the detector saw (IoU). That number
           is the reconstruction's own test, and the page shows it.

CLI (from backend/): python -m app.pipeline.scene3d hero"""
import json
import math
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np
from scipy.optimize import least_squares
from scipy.ndimage import gaussian_filter1d, median_filter
from scipy.signal import savgol_filter

from .. import llm
from .pursuit import _frames_of as best_views

ROOT = Path(__file__).resolve().parents[3]
PLATE_SAMPLES = 90
MIN_FOV, MAX_FOV = 18.0, 100.0
# length, width, height ranges in metres. Heights include a rider on two wheels.
SIZES = {"bus": ((6.5, 12.0), (2.1, 2.6), (2.6, 3.4)), "truck": ((5.0, 11.0), (2.0, 2.6), (2.4, 3.6)), "car": ((3.4, 5.2), (1.5, 2.0), (1.3, 1.9)),
         "van": ((3.8, 5.6), (1.6, 2.0), (1.7, 2.4)), "auto": ((2.4, 3.1), (1.2, 1.6), (1.5, 1.9)),
         "motorcycle": ((1.7, 2.3), (0.6, 0.9), (1.2, 1.7)), "bicycle": ((1.5, 1.9), (0.5, 0.7), (1.2, 1.7)), "person": ((0.35, 0.5), (0.35, 0.5), (1.45, 1.9))}
REST_KMH = 3.5
REST_MIN_S = 1.0
ROAD_HEADING_LIMIT = math.radians(22)  # how far off the road's line a vehicle driving along it is believed to point
TURN_RATE_LIMIT = {"bus": math.radians(20), "truck": math.radians(20)}
TURN_RATE_DEFAULT = math.radians(40)
ACTOR_LIMIT = 36
ACTOR_THREADS = 6
ACTOR_QUESTION = """This crop is from road CCTV. It is centred on one road user. Answer ONLY with one JSON object:
{"type": "pedestrian|motorcycle_rider|bicycle_rider|car|bus|truck|van|auto_rickshaw|motorcycle|bicycle|other",
 "colour": "<main body colour, one word, or null>", "people_on_it": <number of people riding it, 0 if none or a pedestrian>,
 "uniformed": <true if the person in the centre wears a police or traffic-officer uniform, else false>}
Say motorcycle_rider or bicycle_rider only if you can see the two-wheeler under that person."""
ACTOR_KIND = {"car": "car", "bus": "bus", "truck": "truck", "van": "van", "auto_rickshaw": "auto"}
MIN_MOVE_FOR_HEADING = 1.5
MIN_TRAVEL_FOR_HEADING = 3.0  # less than this and the "motion" is the tracker jittering
TEXTURE_PX_PER_M = 64
MAX_TEXTURED = 10
MIN_FACE_AREA_PX = 900
PERSON_HEIGHT_M = 1.68
MIN_PERSON_SAMPLES = 40
MAX_PERSON_SAMPLES = 500
GROUND_POINT_SIGMA_PX = 12.0  # hand-clicked, on approximate road geometry, sometimes outside the picture
ROLL_SIGMA = 0.03  # radians; street cameras are mounted level, near enough
FOCAL_PRIOR_FOV, FOCAL_PRIOR_SIGMA = 45.0, 0.35  # a weak prior on the lens, in log focal length


def solve_camera(calib: dict, width: int, height: int) -> dict:
    """Zhang's constraints on the plane-to-image homography give the focal length; the same homography gives the pose."""
    img, world = np.float64(calib["img_pts"]), np.float64(calib["world_pts"])
    H_wi, _ = cv2.findHomography(world, img)
    cx, cy = width / 2.0, height / 2.0
    h = np.array([[1, 0, -cx], [0, 1, -cy], [0, 0, 1]], float) @ H_wi
    a, b = h[:, 0], h[:, 1]
    estimates = []
    if abs(a[2] * b[2]) > 1e-12:
        estimates.append(-(a[0] * b[0] + a[1] * b[1]) / (a[2] * b[2]))
    if abs(b[2] ** 2 - a[2] ** 2) > 1e-12:
        estimates.append((a[0] ** 2 + a[1] ** 2 - b[0] ** 2 - b[1] ** 2) / (b[2] ** 2 - a[2] ** 2))
    good = [e for e in estimates if e > 0]
    f_default = height / (2 * math.tan(math.radians(45) / 2))
    f = float(np.exp(np.mean(np.log(good))) ** 0.5) if good else f_default
    fov = 2 * math.degrees(math.atan(height / (2 * f)))
    method = "homography constraints"
    if not MIN_FOV <= fov <= MAX_FOV:
        f, method = f_default, "assumed 45 degree lens (homography gave an implausible one)"
    K = np.array([[f, 0, cx], [0, f, cy], [0, 0, 1]], float)
    A = np.linalg.inv(K) @ H_wi
    lam = 2.0 / (np.linalg.norm(A[:, 0]) + np.linalg.norm(A[:, 1]))
    if (lam * A[:, 2])[2] < 0:
        lam = -lam
    r1, r2, t = lam * A[:, 0], lam * A[:, 1], lam * A[:, 2]
    U, _, Vt = np.linalg.svd(np.column_stack([r1, r2, np.cross(r1, r2)]))
    R = U @ Vt
    if np.linalg.det(R) < 0:
        R = U @ np.diag([1, 1, -1]) @ Vt
    C = -R.T @ t
    if C[2] < 0:  # the mirrored solution puts the camera under the road
        R, t = R @ np.diag([-1, -1, 1]), t
        C = -R.T @ t
    rvec, _ = cv2.Rodrigues(R)
    obj = np.column_stack([world, np.zeros(len(world))])
    ok, rvec, t = cv2.solvePnP(obj, img, K, None, rvec.copy(), t.reshape(3, 1).copy(), useExtrinsicGuess=True, flags=cv2.SOLVEPNP_ITERATIVE)
    R, _ = cv2.Rodrigues(rvec)
    t = t.ravel()
    C = -R.T @ t
    proj, _ = cv2.projectPoints(obj, rvec, t, K, None)
    err = float(np.sqrt(np.mean(np.sum((proj.reshape(-1, 2) - img) ** 2, axis=1))))
    forward, up = R.T @ np.array([0, 0, 1.0]), R.T @ np.array([0, -1.0, 0])
    return {"R": R, "t": t, "K": K, "H_iw": np.linalg.inv(H_wi), "position": [round(float(v), 3) for v in C], "forward": [round(float(v), 5) for v in forward],
            "up": [round(float(v), 5) for v in up], "focal_px": round(f, 1), "fov_deg": round(2 * math.degrees(math.atan(height / (2 * f))), 2),
            "width": width, "height": height, "reproj_err_px": round(err, 2), "method": method}


def content_box(frame: np.ndarray) -> tuple[int, int, int, int]:
    """Where the picture actually is, inside any black bars. The lens centre is the middle of this, not of the file."""
    lit = frame.max(axis=2) > 16
    cols, rows = np.where(lit.mean(axis=0) > 0.1)[0], np.where(lit.mean(axis=1) > 0.1)[0]
    if not len(cols) or not len(rows):
        return 0, 0, frame.shape[1], frame.shape[0]
    return int(cols[0]), int(rows[0]), int(cols[-1]) + 1, int(rows[-1]) + 1


def person_samples(ui: dict, box: tuple[int, int, int, int]) -> np.ndarray:
    """Feet and head pixels of upright people, whole in frame. Each one is a known height standing on the road."""
    x0, y0, x1, y1 = box
    out = []
    for tr in ui["tracks"]:
        if tr["class"] != "person":
            continue
        for q in tr["points"][::4]:
            b = q["box"]
            w, h = b[2] - b[0], b[3] - b[1]
            if q.get("conf", 1) < 0.5 or h < 40 or h < 1.5 * w or b[0] < x0 + 3 or b[1] < y0 + 3 or b[2] > x1 - 3 or b[3] > y1 - 3:
                continue
            out.append([(b[0] + b[2]) / 2, b[3], b[1], h])
    arr = np.array(out)
    if len(arr) > MAX_PERSON_SAMPLES:
        arr = arr[np.linspace(0, len(arr) - 1, MAX_PERSON_SAMPLES).astype(int)]
    return arr


def refine_camera(calib: dict, samples: np.ndarray, box: tuple[int, int, int, int]) -> dict | None:
    """Fit focal length and pose to the clicked road points and to every person's height at once. Four clicks alone
    leave the focal length weakly fixed; hundreds of people of known height don't. Robust, since some are mid-stride or sitting."""
    img, world = np.float64(calib["img_pts"]), np.float64(calib["world_pts"])
    obj = np.column_stack([world, np.zeros(len(world))])
    cx, cy = (box[0] + box[2]) / 2.0, (box[1] + box[3]) / 2.0
    span = box[3] - box[1]
    f_prior = math.log(span / (2 * math.tan(math.radians(FOCAL_PRIOR_FOV) / 2)))

    def unpack(p):
        f = math.exp(p[6])
        return p[:3], p[3:6], np.array([[f, 0, cx], [0, f, cy], [0, 0, 1]], float), f

    def residuals(p):
        rvec, t, K, f = unpack(p)
        R, _ = cv2.Rodrigues(rvec)
        ground = (cv2.projectPoints(obj, rvec, t, K, None)[0].reshape(-1, 2) - img).ravel() / GROUND_POINT_SIGMA_PX
        Rt = R.T
        C = -Rt @ t
        rays = Rt @ np.column_stack([(samples[:, 0] - cx) / f, (samples[:, 1] - cy) / f, np.ones(len(samples))]).T
        lam = -C[2] / np.where(np.abs(rays[2]) < 1e-6, 1e-6, rays[2])
        feet = (C.reshape(3, 1) + rays * lam).T
        feet[:, 2] = PERSON_HEIGHT_M
        head = K @ (R @ feet.T + t.reshape(3, 1))
        z = np.where(np.abs(head[2]) < 1e-6, 1e-6, head[2])
        scale = 0.12 * np.maximum(samples[:, 3], 20)
        # Heights pin the camera's height and tilt. A box's centre says nothing about lean, so "up" comes from the roll prior.
        priors = np.array([R[0, 2] / ROLL_SIGMA, (p[6] - f_prior) / FOCAL_PRIOR_SIGMA]) * math.sqrt(len(samples)) / 4
        return np.concatenate([ground, (head[1] / z - samples[:, 2]) / scale, priors])

    best = None
    for fov in (25, 35, 45, 55, 65, 75):
        f = span / (2 * math.tan(math.radians(fov) / 2))
        K = np.array([[f, 0, cx], [0, f, cy], [0, 0, 1]], float)
        ok, rvec, t = cv2.solvePnP(obj, img, K, None, flags=cv2.SOLVEPNP_IPPE)
        if not ok:
            continue
        R, _ = cv2.Rodrigues(rvec)
        if (-R.T @ t.ravel())[2] <= 0:
            continue
        p0 = np.concatenate([rvec.ravel(), t.ravel(), [math.log(f)]])
        res = least_squares(residuals, p0, loss="soft_l1", f_scale=1.0, max_nfev=200)
        if (-cv2.Rodrigues(res.x[:3])[0].T @ res.x[3:6])[2] > 0 and (best is None or res.cost < best.cost):
            best = res
    if best is None:
        return None
    rvec, t, K, f = unpack(best.x)
    R, _ = cv2.Rodrigues(rvec)
    return {"R": R, "t": t, "K": K, "f": f, "rvec": rvec}


def finish_camera(R, t, K, f, calib, width, height, content, method, n_people=0) -> dict:
    world, img = np.float64(calib["world_pts"]), np.float64(calib["img_pts"])
    obj = np.column_stack([world, np.zeros(len(world))])
    rvec = cv2.Rodrigues(R)[0]
    proj = cv2.projectPoints(obj, rvec, t, K, None)[0].reshape(-1, 2)
    err = float(np.sqrt(np.mean(np.sum((proj - img) ** 2, axis=1))))
    H_wi = K @ np.column_stack([R[:, 0], R[:, 1], t])
    C = -R.T @ t
    forward, up = R.T @ np.array([0, 0, 1.0]), R.T @ np.array([0, -1.0, 0])
    return {"R": R, "t": t, "K": K, "H_iw": np.linalg.inv(H_wi), "position": [round(float(v), 3) for v in C], "forward": [round(float(v), 5) for v in forward],
            "up": [round(float(v), 5) for v in up], "focal_px": round(float(f), 1), "fov_deg": round(2 * math.degrees(math.atan(height / (2 * f))), 2),
            "cx": round(float(K[0, 2]), 1), "cy": round(float(K[1, 2]), 1), "content": list(content), "width": width, "height": height,
            "reproj_err_px": round(err, 2), "method": method, "people_used": n_people}


def align_to_road(cam: dict, calib: dict) -> tuple[dict, dict]:
    """Keep the solved camera's lens, tilt and height, and turn and shift its ground plane onto the road map's axes, so
    "along the road" means the same in both. Whatever scale difference remains is reported, not hidden: the camera's
    scale comes from people's heights, the map's from an assumed lane width and crossing length."""
    H_map, _ = cv2.findHomography(np.float64(calib["img_pts"]), np.float64(calib["world_pts"]))
    x0, y0, x1, y1 = cam["content"]
    road_top = y0 + 0.35 * (y1 - y0)
    grid = np.float64([[u, v] for u in np.linspace(x0 + 20, x1 - 20, 12) for v in np.linspace(road_top, y1 - 10, 10)])
    hom = np.column_stack([grid, np.ones(len(grid))])

    def apply(H):
        w = (H @ hom.T).T
        return w[:, :2] / w[:, 2:3]

    a, b = apply(cam["H_iw"]), apply(H_map)
    ac, bc = a.mean(axis=0), b.mean(axis=0)
    U, _, Vt = np.linalg.svd((a - ac).T @ (b - bc))
    A = Vt.T @ U.T
    if np.linalg.det(A) < 0:
        Vt[-1] *= -1
        A = Vt.T @ U.T
    shift = bc - A @ ac
    A3 = np.eye(3)
    A3[:2, :2] = A
    C = np.array(cam["position"], float)
    C_new = A3 @ C + np.array([shift[0], shift[1], 0.0])
    R_new = cam["R"] @ A3.T
    t_new = -R_new @ C_new
    aligned = apply(np.linalg.inv(cam["K"] @ np.column_stack([R_new[:, 0], R_new[:, 1], t_new])))
    # Scale along each map axis: how far the map says two points are apart, against the camera.
    ratio = lambda k: float(np.polyfit(aligned[:, k] - aligned[:, k].mean(), b[:, k] - b[:, k].mean(), 1)[0])
    check = {"map_vs_camera_across_road": round(ratio(0), 2), "map_vs_camera_along_road": round(ratio(1), 2)}
    return {"R": R_new, "t": t_new}, check


def from_map(calib: dict, cam: dict, xy: list[float]) -> list[float]:
    """A point on the road map (impact, witness) → the same place on the camera's ground."""
    H_map_wi, _ = cv2.findHomography(np.float64(calib["world_pts"]), np.float64(calib["img_pts"]))
    p = H_map_wi @ np.array([xy[0], xy[1], 1.0])
    if p[2] <= 1e-9:
        return [float(xy[0]), float(xy[1])]
    g = to_ground(cam, p[0] / p[2], p[1] / p[2])
    return [round(float(g[0]), 3), round(float(g[1]), 3)]


def project(cam: dict, pts: np.ndarray) -> np.ndarray:
    c = cam["K"] @ (cam["R"] @ pts.T + cam["t"].reshape(3, 1))
    z = np.where(np.abs(c[2]) < 1e-6, 1e-6, c[2])
    return (c[:2] / z).T


def to_ground(cam: dict, u: float, v: float) -> np.ndarray:
    w = cam["H_iw"] @ np.array([u, v, 1.0])
    return w[:2] / w[2]


def corners(x: float, y: float, yaw: float, L: float, W: float, Hg: float) -> np.ndarray:
    """yaw = world heading, 0 = +y. Eight corners of the vehicle's box."""
    fx, fy, rx, ry = math.sin(yaw), math.cos(yaw), math.cos(yaw), -math.sin(yaw)
    out = []
    for s in (1, -1):
        for w in (1, -1):
            for h in (0.0, Hg):
                out.append([x + s * L / 2 * fx + w * W / 2 * rx, y + s * L / 2 * fy + w * W / 2 * ry, h])
    return np.array(out)


def proj_box(cam: dict, x, y, yaw, L, W, Hg) -> list[float]:
    p = project(cam, corners(x, y, yaw, L, W, Hg))
    return [float(p[:, 0].min()), float(p[:, 1].min()), float(p[:, 0].max()), float(p[:, 1].max())]


def clipped(box: list[float], content) -> list[float]:
    """What the camera can actually show of a box, for comparing with a detector cut off by the picture's edge."""
    return [max(box[0], content[0]), max(box[1], content[1]), min(box[2], content[2]), min(box[3], content[3])]


def iou(a, b) -> float:
    ix, iy = max(0.0, min(a[2], b[2]) - max(a[0], b[0])), max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def centre_from_box(cam: dict, box, yaw, L, W, Hg, seed=None) -> tuple[float, float]:
    """Slide the fitted box on the road until its projected bottom edge sits where the detector's does."""
    bc = ((box[0] + box[2]) / 2, box[3])
    target = to_ground(cam, *bc)
    x, y = (seed if seed is not None else target)
    for _ in range(3):
        b = proj_box(cam, x, y, yaw, L, W, Hg)
        now = to_ground(cam, (b[0] + b[2]) / 2, b[3])
        x, y = x + (target[0] - now[0]), y + (target[1] - now[1])
    return float(x), float(y)


def truncated(box, width, height, margin=3) -> bool:
    return box[0] < margin or box[1] < margin or box[2] > width - margin or box[3] > height - margin


def kind_of(track: dict, large: set) -> str:
    if track["class"] == "car" and track["id"] in large:
        return "bus"
    return track["class"] if track["class"] in SIZES else "car"


def headings(xs: np.ndarray, ys: np.ndarray) -> np.ndarray | None:
    """Heading from the last confident movement, held while the vehicle is slow, back-filled before it first moves."""
    out = np.full(len(xs), np.nan)
    anchor = 0
    for i in range(1, len(xs)):
        d = math.hypot(xs[i] - xs[anchor], ys[i] - ys[anchor])
        if d >= MIN_MOVE_FOR_HEADING:
            out[i] = math.atan2(xs[i] - xs[anchor], ys[i] - ys[anchor])
            while anchor < i and math.hypot(xs[i] - xs[anchor + 1], ys[i] - ys[anchor + 1]) >= MIN_MOVE_FOR_HEADING:
                anchor += 1
    known = np.where(~np.isnan(out))[0]
    if not len(known) or math.hypot(xs[-1] - xs[0], ys[-1] - ys[0]) < MIN_TRAVEL_FOR_HEADING and float(np.hypot(xs - xs[0], ys - ys[0]).max()) < MIN_TRAVEL_FOR_HEADING:
        return None
    unwrapped = np.unwrap(out[known])
    return np.interp(np.arange(len(xs)), known, unwrapped)


def find_riders(ui_tracks: list[dict]) -> dict[str, str]:
    """A person is a rider if their box stays on one bike's box: over it horizontally, feet within it. Rule, not model."""
    bikes = {t["id"]: {round(q["t"], 2): q["box"] for q in t["points"]} for t in ui_tracks if t["class"] in ("motorcycle", "bicycle")}
    out = {}
    for t in ui_tracks:
        if t["class"] != "person":
            continue
        best, best_share = None, 0.0
        for bid, boxes in bikes.items():
            shared = hits = 0
            for q in t["points"]:
                b = boxes.get(round(q["t"], 2))
                if b is None:
                    continue
                shared += 1
                p = q["box"]
                mid, bw, bh = (p[0] + p[2]) / 2, b[2] - b[0], b[3] - b[1]
                if b[0] - 0.15 * bw <= mid <= b[2] + 0.15 * bw and b[1] <= p[3] <= b[3] + 0.15 * bh:
                    hits += 1
            share = hits / shared if shared else 0.0
            if shared >= max(8, 0.35 * len(t["points"])) and share > best_share:
                best, best_share = bid, share
        if best and best_share >= 0.6:
            out[t["id"]] = best
    return out


def classify_actors(case_dir: Path, case: dict, tracks: list[dict], key: list) -> dict:
    """Show Qwen a crop of each road user worth asking about. Failure just means nothing is overridden."""
    out_dir = case_dir / "scene"
    ranked = sorted(tracks, key=lambda t: (t["id"] not in key, -len(t["points"])))[:ACTOR_LIMIT]

    def ask(t):
        views = best_views(case_dir, case, t, 1)
        if not views:
            return t["id"], None
        crop = views[0]["crop"]
        if crop.shape[1] < 320:
            k = 320 / crop.shape[1]
            crop = cv2.resize(crop, None, fx=k, fy=k, interpolation=cv2.INTER_CUBIC)
        path = out_dir / f"actor_{t['id']}.jpg"
        cv2.imwrite(str(path), crop, [cv2.IMWRITE_JPEG_QUALITY, 90])
        try:
            r = llm.chat_json([{"role": "user", "content": [{"type": "text", "text": ACTOR_QUESTION}, llm.image_part(path)]}], model=llm.VISION_MODEL)
            return t["id"], r["data"]
        except Exception:
            return t["id"], None

    with ThreadPoolExecutor(ACTOR_THREADS) as pool:
        return {tid: a for tid, a in pool.map(ask, ranked) if a}


def identify(case_dir: Path) -> dict:
    """Ask once per case, before fusion, because fusion needs to know who a witness's "the policeman" can be."""
    case = json.loads((case_dir / "case.json").read_text(encoding="utf-8"))
    ui = json.loads((case_dir / "tracks_ui.json").read_text())
    metric = json.loads((case_dir / "tracks_metric.json").read_text())
    ent = json.loads((case_dir / "entities.json").read_text()) if (case_dir / "entities.json").exists() else {}
    known = {t["id"] for t in metric["tracks"]}
    (case_dir / "scene").mkdir(exist_ok=True)
    actors = classify_actors(case_dir, case, [t for t in ui["tracks"] if t["id"] in known], [ent.get("primary"), *ent.get("involved", [])])
    (case_dir / "vision_actors.json").write_text(json.dumps(actors, indent=1))
    return actors


def rest_mask(xs: np.ndarray, ys: np.ndarray, v: np.ndarray, ts: np.ndarray) -> np.ndarray:
    """When a road user is really stopped. Occlusion moves a box's bottom edge, so the speed trace can't be taken alone,
    and a vehicle that never truly went anywhere is at rest throughout, however much its box twitched."""
    n = len(ts)
    dt = float(np.median(np.diff(ts))) if n > 1 else 0.05
    win = max(3, int(round(1.0 / dt)) | 1)
    slow = median_filter(v, size=win, mode="nearest") < REST_KMH
    if float(np.mean(v < 6)) >= 0.8 and float(np.hypot(np.percentile(xs, 95) - np.percentile(xs, 5), np.percentile(ys, 95) - np.percentile(ys, 5))) < 4.0:
        return np.ones(n, bool)
    # Short runs either way are noise: close gaps, then drop brief stops.
    i = 0
    while i < n:
        j = i
        while j + 1 < n and slow[j + 1] == slow[i]:
            j += 1
        if not slow[i] and (ts[j] - ts[i]) < 0.4 and i > 0 and j < n - 1:
            slow[i:j + 1] = True
        i = j + 1
    i = 0
    while i < n:
        j = i
        while j + 1 < n and slow[j + 1] == slow[i]:
            j += 1
        if slow[i] and (ts[j] - ts[i]) < REST_MIN_S:
            slow[i:j + 1] = False
        i = j + 1
    return slow


def steady_heading(yaws: np.ndarray, ts: np.ndarray, rest: np.ndarray, kind: str, axis: float | None) -> np.ndarray:
    """Heading that behaves like a vehicle: it follows the road unless the vehicle truly left its line, turns no faster
    than that vehicle can, and doesn't change at all while the vehicle is stopped."""
    y = np.unwrap(yaws)
    if axis is not None and kind != "person":
        mean = float(np.mean(y))
        dev = (mean - axis + math.pi / 2) % math.pi - math.pi / 2
        if abs(dev) < math.radians(25):  # travelling along the road, in either direction
            line = mean - dev
            y = line + np.clip(y - line, -ROAD_HEADING_LIMIT, ROAD_HEADING_LIMIT)
    moving = np.where(~rest)[0]
    if len(moving):
        idx = np.arange(len(y))
        y = np.interp(idx, moving, y[moving])   # holds the last moving heading through every stop
    dt = float(np.median(np.diff(ts))) if len(ts) > 1 else 0.05
    win = int(round(1.5 / dt)) | 1
    if len(y) > win:
        y = savgol_filter(y, win, 2)
    rate = TURN_RATE_LIMIT.get(kind, TURN_RATE_DEFAULT)
    for i in range(1, len(y)):
        limit = rate * max(float(ts[i] - ts[i - 1]), 1e-3)  # per real frame gap, so uneven sampling can't sneak a spin through
        y[i] = y[i - 1] + np.clip(y[i] - y[i - 1], -limit, limit)
    return y


def steady_path(cx: np.ndarray, cy: np.ndarray, rest: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """A stopped vehicle stays put at the median of where it was seen. A moving one gets outliers removed, then smoothing."""
    x, y = median_filter(cx, size=7, mode="nearest"), median_filter(cy, size=7, mode="nearest")
    if len(x) >= 21:
        x, y = savgol_filter(x, 21, 2), savgol_filter(y, 21, 2)
    i, n = 0, len(x)
    while i < n:
        j = i
        while j + 1 < n and rest[j + 1] == rest[i]:
            j += 1
        if rest[i]:
            x[i:j + 1], y[i:j + 1] = np.median(cx[i:j + 1]), np.median(cy[i:j + 1])
        i = j + 1
    # Ease in and out of each stop, without letting it wander.
    sx, sy = gaussian_filter1d(x, 3, mode="nearest"), gaussian_filter1d(y, 3, mode="nearest")
    edge = gaussian_filter1d(rest.astype(float), 3, mode="nearest")
    fixed = edge > 0.995
    return np.where(fixed, x, sx), np.where(fixed, y, sy)


def road_axis(tracks: list[dict]) -> float | None:
    """The direction traffic actually moves along, modulo 180 degrees, from every vehicle that really travelled."""
    angles = []
    for tr in tracks:
        if tr["class"] not in ("car", "bus", "truck", "motorcycle"):
            continue
        xs, ys = np.array([p["x"] for p in tr["points"]]), np.array([p["y"] for p in tr["points"]])
        dx, dy = xs[-1] - xs[0], ys[-1] - ys[0]
        if math.hypot(dx, dy) >= 8:
            angles.append(2 * math.atan2(dx, dy))
    if not angles:
        return None
    return math.atan2(float(np.mean(np.sin(angles))), float(np.mean(np.cos(angles)))) / 2


def fit_track(cam: dict, track: dict, ui_track: dict, kind: str, width: int, height: int, axis: float | None = None) -> dict:
    boxes = {round(q["t"], 3): q["box"] for q in ui_track["points"]}
    pts = track["points"]
    ts = np.array([p["t"] for p in pts])
    box_of = [boxes.get(round(float(t), 3)) for t in ts]
    x0, y0, x1, y1 = cam["content"]
    # Sides and bottom must be in the picture to place it. A roof cut off by the top of the picture is fine.
    usable = [i for i, b in enumerate(box_of) if b is not None and b[0] >= x0 + 3 and b[2] <= x1 - 3 and b[3] <= y1 - 3]
    whole = [i for i in usable if box_of[i][1] >= y0 + 3]
    # Positions on the solved camera's own ground, from the pixels. Speeds stay those of the calibrated tracks.
    idx = np.arange(len(ts))
    feet = np.full((len(ts), 2), np.nan)
    for i, b in enumerate(box_of):
        if b is not None and b[3] <= y1 - 3:
            feet[i] = to_ground(cam, (b[0] + b[2]) / 2, b[3])
    if np.isnan(feet).all():
        feet = np.column_stack([[p["x"] for p in pts], [p["y"] for p in pts]])
    for k in (0, 1):
        good = ~np.isnan(feet[:, k])
        feet[:, k] = np.interp(idx, idx[good], feet[good, k])
    pad = lambda a: np.convolve(np.pad(a, (2, 2), mode="edge"), np.ones(5) / 5, mode="valid")
    xs, ys = pad(feet[:, 0]), pad(feet[:, 1])
    speeds = np.array([p["v_kmh"] for p in pts], float)
    # People shift and step without getting anywhere, and that is real, so only vehicles get locked in place when stopped.
    rest = rest_mask(xs, ys, speeds, ts) if kind != "person" else np.zeros(len(ts), bool)
    yaws = headings(xs, ys) if not rest.all() else None
    moved = yaws is not None
    if moved:
        # A person standing still keeps facing the same way, even while their box twitches.
        dt = float(np.median(np.diff(ts))) if len(ts) > 1 else 0.05
        hold = rest if kind != "person" else median_filter(speeds, size=max(3, int(round(1.0 / dt)) | 1), mode="nearest") < 2.5
        yaws = steady_heading(yaws, ts, hold, kind, axis)
    (lr, wr, hr) = SIZES[kind]
    area = lambda i: (box_of[i][2] - box_of[i][0]) * (box_of[i][3] - box_of[i][1])
    # The largest views, preferring those whole in the picture, but a bus may never be.
    sample = (sorted(whole, key=area, reverse=True)[:6] + sorted(usable, key=area, reverse=True)[:4])[:8]

    def score(L, W, Hg, yaw_at):
        vals = []
        for i in sample:
            cx, cy = centre_from_box(cam, box_of[i], yaw_at(i), L, W, Hg)
            vals.append(iou(clipped(proj_box(cam, cx, cy, yaw_at(i), L, W, Hg), cam["content"]), box_of[i]))
        return float(np.mean(vals)) if vals else 0.0

    mid = (sum(lr) / 2, sum(wr) / 2, sum(hr) / 2)
    yaw_fixed = 0.0
    if not moved and sample and kind != "person":
        # A parked vehicle gives no motion to read heading from, so take the orientation that explains its box best.
        options = [axis + d for d in np.radians([0, -12, 12, -25, 25])] if axis is not None else np.linspace(0, math.pi, 12, endpoint=False)
        yaw_fixed = float(max(options, key=lambda a: score(*mid, lambda i: a)))
    yaw_at = (lambda i: float(yaws[i])) if moved else (lambda i: yaw_fixed)
    L, W, Hg = mid
    if sample and kind != "person":
        best = (-1.0, mid)
        for l in np.linspace(*lr, 5):
            for w in np.linspace(*wr, 3):
                for h in np.linspace(*hr, 4):
                    s = score(l, w, h, yaw_at)
                    if s > best[0]:
                        best = (s, (float(l), float(w), float(h)))
        L, W, Hg = best[1]
    elif sample:
        Hg = max(np.linspace(*hr, 6), key=lambda h: score(L, W, h, yaw_at))

    # Vehicle centre per frame; frames the detector cut off keep the offset of their neighbours.
    off = np.full((len(ts), 2), np.nan)
    for i in usable:
        cx, cy = centre_from_box(cam, box_of[i], yaw_at(i), L, W, Hg)
        off[i] = (cx - xs[i], cy - ys[i])
    if np.isnan(off).all():
        off[:] = 0.0
    for k in (0, 1):
        good = ~np.isnan(off[:, k])
        off[:, k] = np.interp(idx, idx[good], off[good, k])
    cx, cy = steady_path(xs + off[:, 0], ys + off[:, 1], rest)
    ious = [iou(clipped(proj_box(cam, float(cx[i]), float(cy[i]), yaw_at(i), L, W, Hg), cam["content"]), box_of[i]) for i in usable]
    return {"id": track["id"], "class": track["class"], "kind": kind, "colour_name": track.get("colour_name"), "colour": track.get("colour"),
            "dims": {"length": round(L, 2), "width": round(W, 2), "height": round(Hg, 2)}, "heading_from": "motion" if moved else "box shape", "at_rest_share": round(float(rest.mean()), 2),
            "iou": round(float(np.mean(ious)), 3) if ious else None, "n_checked": len(ious),
            "points": [{"t": round(float(ts[i]), 3), "x": round(float(cx[i]), 3), "y": round(float(cy[i]), 3), "yaw": round(yaw_at(i), 4),
                        "v_kmh": pts[i]["v_kmh"], "v_sigma": pts[i]["v_sigma"]} for i in range(len(ts))]}


def road_model(calib: dict, cam: dict, fitted: list[dict], impact: list[float] | None, axis: float | None) -> dict:
    """Where the road is, on the camera's ground: from the calibrated layout when known, else from where vehicles drove."""
    f = calib.get("features", {})
    cw, zebra, divider = f.get("carriageway", {}).get("x"), f.get("zebra", {}).get("y"), f.get("divider", {}).get("x")
    if cw:
        ymid = (zebra[0] + zebra[1]) / 2 if zebra else 0.0
        a, b = np.array(from_map(calib, cam, [cw[0], ymid])), np.array(from_map(calib, cam, [cw[1], ymid]))
        c, across = (a + b) / 2, (b - a) / (np.linalg.norm(b - a) or 1)
        along = np.array([-across[1], across[0]])
        if along[1] < 0:
            along = -along
        local = lambda xy: (float(np.dot(np.array(xy) - c, across)), float(np.dot(np.array(xy) - c, along)))
        out = {"axis": round(math.atan2(along[0], along[1]), 4), "cx": round(float(c[0]), 3), "cy": round(float(c[1]), 3), "half": round(float(np.linalg.norm(b - a)) / 2, 2), "divider": None, "zebra": None}
        if divider:
            out["divider"] = sorted(round(local(from_map(calib, cam, [x, ymid]))[0], 2) for x in divider)
        if zebra:
            xmid = (cw[0] + cw[1]) / 2
            out["zebra"] = [round(local(from_map(calib, cam, [xmid, y]))[1], 2) for y in zebra]
        return out
    a = axis if axis is not None else 0.0
    rx, ry = math.cos(a), -math.sin(a)
    across_vals = [p["x"] * rx + p["y"] * ry for t in fitted if t["kind"] != "person" for p in t["points"]]
    lo, hi = np.percentile(across_vals, [3, 97]) if across_vals else (-4.0, 4.0)
    centre = (lo + hi) / 2
    ix, iy = impact or [0.0, 0.0]
    along_at = ix * math.sin(a) + iy * math.cos(a)
    return {"axis": round(a, 4), "cx": round(float(centre * rx + along_at * math.sin(a)), 3), "cy": round(float(centre * ry + along_at * math.cos(a)), 3),
            "half": round(float(max(3.0, (hi - lo) / 2 + 1.0)), 2), "divider": None, "zebra": None}


def clean_plate(video: Path, ui: dict, fps: float, t0: float, width: int, height: int) -> np.ndarray:
    """Per-pixel median over the clip, skipping pixels under any detection box. Never-uncovered pixels get inpainted."""
    cap = cv2.VideoCapture(str(video))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    boxes_at: dict[int, list] = {}
    for tr in ui["tracks"]:
        for q in tr["points"]:
            boxes_at.setdefault(int(round((q["t"] + t0) * fps)), []).append(q["box"])
    frames, masks = [], []
    for idx in np.linspace(0, max(total - 1, 0), PLATE_SAMPLES).astype(int):
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(idx))
        ok, img = cap.read()
        if not ok:
            continue
        mask = np.zeros(img.shape[:2], bool)
        near = next((boxes_at[k] for k in (idx, idx - 1, idx + 1, idx - 2, idx + 2) if k in boxes_at), [])
        for b in near:
            pad = int(0.06 * max(b[2] - b[0], b[3] - b[1]))
            mask[max(0, int(b[1]) - pad):int(b[3]) + pad, max(0, int(b[0]) - pad):int(b[2]) + pad] = True
        frames.append(img)
        masks.append(mask)
    cap.release()
    # Only keep the picture area, so a long clip fits in memory.
    stack = np.stack(frames).astype(np.uint16)
    covered = np.stack(masks)
    stack[covered] = 999
    stack.sort(axis=0)
    counts = (~covered).sum(axis=0)
    pick = np.clip(counts // 2, 0, len(frames) - 1)
    plate = np.take_along_axis(stack, pick[None, :, :, None].repeat(3, axis=3), axis=0)[0]
    never = counts == 0
    plate[never] = 0
    plate = plate.astype(np.uint8)
    if never.any():
        plate = cv2.inpaint(plate, never.astype(np.uint8) * 255, 7, cv2.INPAINT_TELEA)
    return plate


def face_quads(x, y, yaw, L, W, Hg) -> dict[str, np.ndarray]:
    """Corners in the order three.js's box UVs expect: u0v1, u1v1, u1v0, u0v0, seen from outside. Local +X = right, -Z = forward."""
    fx, fy, rx, ry = math.sin(yaw), math.cos(yaw), math.cos(yaw), -math.sin(yaw)

    def w(lx, ly, lz):  # three.js local axes: X right, Y up, Z backward
        return [x + lx * rx - lz * fx, y + lx * ry - lz * fy, ly]

    a, b, h = W / 2, L / 2, Hg
    return {"px": np.array([w(a, h, b), w(a, h, -b), w(a, 0, -b), w(a, 0, b)]), "nx": np.array([w(-a, h, -b), w(-a, h, b), w(-a, 0, b), w(-a, 0, -b)]),
            "py": np.array([w(-a, h, -b), w(a, h, -b), w(a, h, b), w(-a, h, b)]), "pz": np.array([w(-a, h, b), w(a, h, b), w(a, 0, b), w(-a, 0, b)]),
            "nz": np.array([w(a, h, -b), w(-a, h, -b), w(-a, 0, -b), w(a, 0, -b)])}


def textures(cam: dict, fitted: dict, ui_track: dict, video: Path, t0: float, fps: float, out_dir: Path) -> dict:
    """Rectify the visible faces out of the frame where the vehicle is largest and fully in view."""
    w_px, h_px = cam["width"], cam["height"]
    boxes = {round(q["t"], 3): q["box"] for q in ui_track["points"]}
    cands = [p for p in fitted["points"] if round(p["t"], 3) in boxes and not truncated(boxes[round(p["t"], 3)], w_px, h_px)]
    if not cands:
        return {}
    area = lambda p: (boxes[round(p["t"], 3)][2] - boxes[round(p["t"], 3)][0]) * (boxes[round(p["t"], 3)][3] - boxes[round(p["t"], 3)][1])
    p = max(cands, key=area)
    cap = cv2.VideoCapture(str(video))
    cap.set(cv2.CAP_PROP_POS_FRAMES, int(round((p["t"] + t0) * fps)))
    ok, img = cap.read()
    cap.release()
    if not ok:
        return {}
    d = fitted["dims"]
    C = np.array(cam["position"])
    out = {}
    for name, quad in face_quads(p["x"], p["y"], p["yaw"], d["length"], d["width"], d["height"]).items():
        n = np.cross(quad[3] - quad[0], quad[1] - quad[0])
        n = n / (np.linalg.norm(n) or 1)
        centre = quad.mean(axis=0)
        view = C - centre
        # Faces are stored facing outwards; keep those turned towards the camera.
        if np.dot(n, view / np.linalg.norm(view)) < 0.12:
            continue
        src = project(cam, quad).astype(np.float32)
        if cv2.contourArea(src) < MIN_FACE_AREA_PX:
            continue
        tw = int(min(512, max(32, np.linalg.norm(quad[1] - quad[0]) * TEXTURE_PX_PER_M)))
        th = int(min(512, max(32, np.linalg.norm(quad[3] - quad[0]) * TEXTURE_PX_PER_M)))
        M = cv2.getPerspectiveTransform(src, np.float32([[0, 0], [tw, 0], [tw, th], [0, th]]))
        tex = cv2.warpPerspective(img, M, (tw, th), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
        fname = f"tex_{fitted['id']}_{name}.jpg"
        cv2.imwrite(str(out_dir / fname), tex, [cv2.IMWRITE_JPEG_QUALITY, 88])
        out[name] = fname
    return {"faces": out, "from_t": p["t"]} if out else {}


def run(case_dir: Path) -> dict | None:
    if not (case_dir / "tracks_metric.json").exists() or not (case_dir / "calibration.json").exists():
        return None
    case = json.loads((case_dir / "case.json").read_text(encoding="utf-8"))
    calib = json.loads((case_dir / "calibration.json").read_text())
    metric = json.loads((case_dir / "tracks_metric.json").read_text())
    ui = json.loads((case_dir / "tracks_ui.json").read_text())
    ent = json.loads((case_dir / "entities.json").read_text()) if (case_dir / "entities.json").exists() else {}
    vision = json.loads((case_dir / "vision.json").read_text()) if (case_dir / "vision.json").exists() else {}
    width, height = case["video"]["width"], case["video"]["height"]
    video, fps, t0 = case_dir / "evidence" / "cctv.mp4", case["video"]["fps"], case["t0_video_s"]
    out_dir = case_dir / "scene"
    out_dir.mkdir(exist_ok=True)

    plate = clean_plate(video, ui, fps, t0, width, height)
    cv2.imwrite(str(out_dir / "plate.jpg"), plate, [cv2.IMWRITE_JPEG_QUALITY, 92])
    content = content_box(plate)
    first = solve_camera(calib, width, height)
    samples = person_samples(ui, content)
    refined = refine_camera(calib, samples, content) if len(samples) >= MIN_PERSON_SAMPLES else None
    if refined:
        cam = finish_camera(refined["R"], refined["t"], refined["K"], refined["f"], calib, width, height, content, "road points plus person heights", len(samples))
    else:
        cam = finish_camera(first["R"], first["t"], first["K"], first["focal_px"], calib, width, height, content, first["method"])
    aligned, scale_check = align_to_road(cam, calib)
    cam = finish_camera(aligned["R"], aligned["t"], cam["K"], cam["focal_px"], calib, width, height, content, cam["method"], cam["people_used"])

    ui_by_id = {t["id"]: t for t in ui["tracks"]}
    large, key = set(ent.get("large", [])), [ent.get("primary"), *ent.get("involved", [])]
    if vision.get("primary_type") in ("bus", "truck") and ent.get("primary"):
        large.add(ent["primary"])
    fitted = []
    axis = road_axis(metric["tracks"])
    riders = {p: b for p, b in find_riders(ui["tracks"]).items() if p not in key}
    on_bike: dict[str, int] = {}
    for b in riders.values():
        on_bike[b] = on_bike.get(b, 0) + 1
    actors = identify(case_dir)
    from_vision = 0
    for tr in metric["tracks"]:
        if tr["id"] not in ui_by_id or tr["id"] in riders or len(tr["points"]) < 6:
            continue
        kind = kind_of(tr, large)
        vision_drawn = False
        a = actors.get(tr["id"]) or {}
        said = a.get("type")
        people = on_bike.get(tr["id"], 0)
        if tr["class"] == "person" and said in ("motorcycle_rider", "bicycle_rider") and tr["id"] not in key:
            kind, people = ("motorcycle" if said == "motorcycle_rider" else "bicycle"), max(1, int(a.get("people_on_it") or 1))
            from_vision += 1
            vision_drawn = True
        elif tr["class"] in ("car", "bus", "truck") and said in ACTOR_KIND and tr["id"] != ent.get("primary"):
            kind = ACTOR_KIND[said]
        elif tr["class"] in ("motorcycle", "bicycle"):
            people = max(people, int(a.get("people_on_it") or 0) if isinstance(a.get("people_on_it"), (int, float)) else 0)
        f = fit_track(cam, tr, ui_by_id[tr["id"]], kind, width, height, axis)
        f["riders"] = min(people, 3)
        if vision_drawn:  # its detector box only covers the person, so it can't test a whole bike's fit
            f["iou"], f["n_checked"] = None, 0
        if a:
            f["vlm"] = {"type": said, "colour": a.get("colour")}
            if tr["class"] != "person" and isinstance(a.get("colour"), str) and a["colour"].lower() in ("white", "silver", "grey", "gray", "black", "red", "blue", "green", "yellow", "orange", "brown"):
                f["colour_name"] = a["colour"].lower().replace("gray", "grey")
        if tr["id"] == ent.get("primary") and vision.get("primary_colour"):
            f["colour_name"] = vision["primary_colour"]
        fitted.append(f)
    order = sorted((f for f in fitted if f["kind"] != "person"), key=lambda f: (f["id"] not in key, -f["dims"]["length"], -len(f["points"])))
    for f in order[:MAX_TEXTURED]:
        f["texture"] = textures(cam, f, ui_by_id[f["id"]], video, t0, fps, out_dir)
    checked = [f for f in fitted if f["iou"] is not None]
    keyed = [f for f in checked if f["id"] in key]
    weigh = lambda fs: round(sum(f["iou"] * f["n_checked"] for f in fs) / max(1, sum(f["n_checked"] for f in fs)), 3)
    people = [f["dims"]["height"] for f in fitted if f["kind"] == "person" and f["n_checked"] > 30]
    camera = {k: cam[k] for k in ("position", "forward", "up", "focal_px", "fov_deg", "cx", "cy", "content", "width", "height", "reproj_err_px", "method", "people_used")}
    camera["height_m"] = camera["position"][2]
    camera["R"], camera["t"], camera["K"] = cam["R"].round(6).tolist(), cam["t"].round(4).tolist(), cam["K"].round(3).tolist()
    witnesses = json.loads((case_dir / "witnesses.json").read_text(encoding="utf-8")) if (case_dir / "witnesses.json").exists() else {}
    impact = from_map(calib, cam, ent["impact_xy"]) if ent.get("impact_xy") else None
    res = {"camera": camera, "plate": "plate.jpg", "tracks": fitted, "scale_check": scale_check, "impact": impact,
           "actors": {"model": llm.VISION_MODEL if actors else None, "asked": len(actors), "riders_on_tracked_bikes": len(riders), "riders_seen_by_vision": from_vision}, "road": road_model(calib, cam, fitted, impact, axis),
           "witnesses": {w: from_map(calib, cam, m["position_m"]) for w, m in witnesses.items() if m.get("position_m")},
           "fit": {"iou_key": weigh(keyed) if keyed else None, "iou_all": weigh(checked) if checked else None, "frames_checked": sum(f["n_checked"] for f in checked),
                   "median_person_height_m": round(float(np.median(people)), 2) if people else None},
           "note": "Boxes are fitted to detector boxes and re-projected to test them. Positions inherit the calibration's uncertainty."}
    (case_dir / "scene3d.json").write_text(json.dumps(res))
    return res


if __name__ == "__main__":
    r = run(ROOT / "data" / "cases" / sys.argv[1])
    if not r:
        sys.exit("no calibrated tracks for that case")
    print(json.dumps(r["camera"], indent=1))
    print(json.dumps(r["fit"], indent=1))
    for f in sorted(r["tracks"], key=lambda f: -len(f["points"]))[:14]:
        print(f"{f['id']:16} {f['kind']:11} L{f['dims']['length']:5} W{f['dims']['width']:5} H{f['dims']['height']:5} iou={f['iou']} n={f['n_checked']} heading={f['heading_from']} tex={list((f.get('texture') or {}).get('faces', {}))}")
