"""OWNER: P4 (+P2). Hit-and-run: exit vector + speed range -> toll arrival windows -> partial plate match.

TODO
- road graph (hand-made GeoJSON or osmnx) with toll nodes; path length per toll
- window = [dist / v_max, dist / v_min] after exit time
- filter toll_logs.csv: time in window -> plate regex (partial, ? = any) -> vehicle class/colour
- return funnel counts for the UI animation
"""
import re


def plate_regex(partial: str) -> re.Pattern:
    return re.compile("^" + partial.replace(" ", "").replace("?", ".") + "$")
