"""How the impact rule does on scenarios it wasn't built from: every DeepAccident mini scenario, including the
no-crash versions. Speeds are simulator truth, so this tests the rule, not the CV. Reads labels and meta only,
never the dataset's .pkl files.

    python scripts/holdout_impact.py path/to/DeepAccident_mini.zip [threshold_g]

Last result at 5 g, leaving out Town02 scenario00013: 3 of 11 collisions caught, 0 false alarms in 61 vehicles.
It finds hard crashes. Soft contacts, and sequences that end at the moment of contact, show no spike."""
import sys
import zipfile

AGENTS = {"ego": "ego_vehicle", "other": "other_vehicle", "ego_behind": "ego_vehicle_behind", "other_behind": "other_vehicle_behind"}
FRAME_DT_S = 0.1
SKIP = "Town02_type001_subtype0001_scenario00013"


def main(path: str, threshold: float) -> None:
    hits = misses = alarms = quiet = 0
    with zipfile.ZipFile(path) as z:
        names = [i.filename for i in z.infolist() if not i.is_dir()]
        for meta_name in sorted(n for n in names if "/meta/" in n and SKIP not in n):
            kind, scenario = meta_name.split("/")[0], meta_name.split("/")[-1][:-4]
            meta = z.read(meta_name).decode().splitlines()
            colliding = set(meta[1].split(":")[1].split()) - {"none"}
            for agent, folder in AGENTS.items():
                labels = sorted(n for n in names if n.startswith(f"{kind}/{folder}/label/{scenario}/"))
                speeds = []
                for name in labels:
                    vx, vy = map(float, z.read(name).decode().splitlines()[0].split()[:2])
                    speeds.append((vx**2 + vy**2) ** 0.5 * 3.6)
                if len(speeds) < 2:
                    continue
                peak = max(abs(speeds[i] - speeds[i - 1]) / FRAME_DT_S / 3.6 / 9.81 for i in range(1, len(speeds)))
                detected = peak >= threshold
                if "accident" in kind and agent in colliding:
                    hits, misses = hits + detected, misses + (not detected)
                else:
                    alarms, quiet = alarms + detected, quiet + (not detected)
    print(f"at {threshold} g: caught {hits} of {hits + misses} collisions, {alarms} false alarms in {alarms + quiet} vehicles")


if __name__ == "__main__":
    main(sys.argv[1], float(sys.argv[2]) if len(sys.argv) > 2 else 5.0)
