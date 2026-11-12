#!/usr/bin/env python3
"""
Compiles Natural Earth boundaries into the compact offline map Terra Nota draws.

    python3 tools/build_map.py <folder with the two .geojson files> web/data

Inputs (public domain, naturalearthdata.com), the versions with large lakes cut
out, so the Great Lakes, Victoria, Baikal and the rest are water, not land:
    ne_10m_admin_0_countries_lakes.geojson
    ne_10m_admin_1_states_provinces_lakes.geojson
(The plain files without "_lakes" still work, but then lakes are drawn as land.)

Standard library only. The steps that matter:

  1. Every ring from both files goes into one shared topology, so a border is a
     single arc no matter how many shapes use it. Each arc is simplified once,
     which is why neighbouring shapes never show gaps or slivers between them.
  2. Shapes are merged by cancelling arcs that run both ways inside a group. That
     turns 232 UK council areas into 4 nations, and also heals the seam Natural
     Earth leaves at 180 degrees through Russia and Fiji.
  3. Output is longitude and latitude on an integer grid, written as compact
     SVG-style path text. The app projects it to Equal Earth itself, because the
     map turns as you scroll sideways and the projection centre moves with it.
     Simplification is measured in Equal Earth area, so detail is even everywhere.
"""
import heapq
import json
import math
import os
import re
import sys
import unicodedata
from collections import Counter, defaultdict

# ---------------------------------------------------------------- projection
CUT = -169.0        # where stored longitudes start: the Bering Strait splits almost nothing
GRID = 0.002        # output grid, in degrees (about 220 m)

# Three levels of detail: (Visvalingam area threshold in square map units, smallest
# ring kept in map units). A map unit is one degree of longitude at the equator.
# The app picks a level by zoom.
LEVELS = [(8e-3, 0.30), (6.75e-4, 0.08), (1.6e-5, 0.006)]

# Equal Earth (Šavrič, Patterson & Jenny, 2018).
A1, A2, A3, A4 = 1.340264, -0.081106, 0.000893, 0.003796
EE_M = math.sqrt(3) / 2


def ee_theta(lat):
    return math.asin(EE_M * math.sin(math.radians(lat)))


def ee_factor(lat):
    """x = longitude * factor. Normalised so the equator is one unit per degree."""
    t = ee_theta(lat)
    t2 = t * t
    t6 = t2 * t2 * t2
    return 2 * math.sqrt(3) * math.cos(t) / (3 * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2)))


EE_F0 = ee_factor(0)


def ee_y(lat):
    """Equal Earth y in the same units as x, north positive."""
    t = ee_theta(lat)
    t2 = t * t
    t6 = t2 * t2 * t2
    return math.degrees(t * (A1 + A2 * t2 + t6 * (A3 + A4 * t2))) / EE_F0


def ee_point(lon, lat):
    return lon * ee_factor(lat) / EE_F0, ee_y(lat)


def grid_lonlat(x, y):
    return x * GRID + CUT, 90 - y * GRID


# -------------------------------------------------------------- what's what
# The 197 counted countries: 193 UN members, plus Vatican City, Palestine, Kosovo
# and Taiwan. Natural Earth's own TYPE field gets close; these lists settle the rest.
NOT_SOVEREIGN = {'SOL', 'CYN', 'SXM', 'HKG', 'MAC', 'GRL', 'CUW', 'ABW', 'JEY', 'GGY', 'IMN', 'ALD'}
ALSO_SOVEREIGN = {'ISR', 'KAZ', 'CUB', 'PSX', 'KOS'}
# Slivers folded into the country that surrounds them.
MERGE_INTO = {'KAB': 'KAZ', 'USG': 'CUB', 'ESB': 'CYP', 'WSB': 'CYP', 'CNM': 'CYP'}
# Drawn as land, but not something you'd tick off.
NOT_SELECTABLE = {'KAS', 'SPI', 'BRT', 'BRI', 'BJN', 'SER', 'SCR', 'PGA', 'CSI', 'ATC', 'CLP'}

COUNTRY_NAMES = {
    'USA': 'United States', 'SRB': 'Serbia', 'TZA': 'Tanzania', 'SWZ': 'Eswatini',
    'BHS': 'Bahamas', 'MAC': 'Macau', 'HKG': 'Hong Kong', 'TLS': 'Timor-Leste',
    'COG': 'Republic of the Congo', 'COD': 'DR Congo', 'ALD': 'Åland',
    'VAT': 'Vatican City', 'FSM': 'Micronesia', 'STP': 'São Tomé and Príncipe',
    'IOA': 'Christmas & Cocos Islands', 'PSX': 'Palestine', 'SAH': 'Western Sahara',
    'ATF': 'French Southern Lands', 'UMI': 'US Minor Outlying Islands',
    'SGS': 'South Georgia', 'HMD': 'Heard & McDonald Islands',
    'VIR': 'US Virgin Islands', 'BLM': 'Saint Barthélemy', 'CUW': 'Curaçao',
}
CONTINENT_FIX = {
    'ATF': 'Antarctica', 'HMD': 'Antarctica', 'SGS': 'South America', 'IOT': 'Asia',
    'SYC': 'Africa', 'MUS': 'Africa', 'SHN': 'Africa', 'MDV': 'Asia',
    'CYP': 'Europe', 'CYN': 'Europe',
}
# Where the camera goes for a country, when "its biggest pieces" isn't the answer.
# (west, south, east, north) in degrees.
FOCUS = {
    'USA': (-125.5, 24, -66.5, 49.5), 'FRA': (-5.5, 41, 10, 51.5), 'NOR': (4, 57.5, 32, 71.5),
    'NLD': (3.2, 50.6, 7.4, 53.7), 'ESP': (-18.5, 27.5, 4.6, 44), 'PRT': (-10, 36.8, -6, 42.3),
    'AUS': (112, -44.5, 154.5, -10), 'NZL': (165.5, -47.6, 179, -34),
    'CHL': (-76, -56.5, -66, -17), 'ECU': (-81.5, -5.2, -75, 1.7), 'ZAF': (16, -35, 33.5, -22),
    'RUS': (19, 41, 191, 78), 'GBR': (-9, 49.7, 2.2, 61), 'DNK': (7.8, 54.4, 15.5, 58),
    'KIR': (172, -3, 177, 4), 'FJI': (176.8, -19.4, 182, -16),
}

# ------------------------------------------------- state and province handling
NO_STATES_UNDER_KM2 = 3000      # city-states don't need their parishes ticked off
NO_STATES = {'ATA', 'KAB', 'USG', 'ESB', 'WSB', 'CNM'}
# Countries whose finest unit is too fine: roll up to the named field instead.
GROUP_BY = {
    'GBR': 'geonunit', 'SVN': 'region', 'LVA': 'region', 'PHL': 'region', 'UGA': 'region',
    'ITA': 'region', 'FRA': 'region', 'MKD': 'region', 'AZE': 'region', 'ESP': 'region',
    'HUN': 'region', 'BFA': 'region', 'KOS': 'region', 'GIN': 'region',
}
# Hand-merges, in the language of the final name.
MERGE_STATES = {
    'AUS': {'Jervis Bay Territory': 'New South Wales', 'Lord Howe Island': 'New South Wales',
            'Macquarie Island': 'Tasmania'},
    'NZL': {'Three Kings Islands': 'Northland', 'Auckland Islands': 'Subantarctic Islands',
            'Campbell Islands': 'Subantarctic Islands', 'Antipodes Islands': 'Subantarctic Islands',
            'Snares Islands': 'Subantarctic Islands', 'Bounty Islands': 'Subantarctic Islands'},
    'IRL': {'Dún Laoghaire–Rathdown': 'Dublin', 'Fingal': 'Dublin', 'South Dublin': 'Dublin',
            'North Tipperary': 'Tipperary', 'South Tipperary': 'Tipperary'},
}
STATE_NAMES = {
    'MEX': {'Distrito Federal': 'Mexico City', 'México': 'State of Mexico'},
    'BRA': {'Federal': 'Federal District'},
    'GRC': {'Centre Macedonia': 'Central Macedonia', 'West Macedonia': 'Western Macedonia',
            'East Macedonia and Thrace': 'Eastern Macedonia and Thrace', 'Thessalia': 'Thessaly',
            'West Greece': 'Western Greece'},
    'DNK': {'Hovedstaden': 'Capital Region'},
    'IRL': {'Laoighis': 'Laois'},
    'NZL': {'Marlborough District': 'Marlborough', 'Nelson City': 'Nelson',
            'Tasman District': 'Tasman', 'Gisborne District': 'Gisborne',
            'Manawatu-Wanganui': 'Manawatū-Whanganui',
            'Chatham Islands Territory': 'Chatham Islands'},
    'ITA': {'Piemonte': 'Piedmont', 'Lombardia': 'Lombardy', 'Toscana': 'Tuscany',
            'Sardegna': 'Sardinia', "Valle d'Aosta": 'Aosta Valley',
            'Trentino-Alto Adige': 'Trentino-South Tyrol'},
    'ESP': {'Cataluña': 'Catalonia', 'Andalucía': 'Andalusia', 'País Vasco': 'Basque Country',
            'Valenciana': 'Valencia', 'Islas Baleares': 'Balearic Islands',
            'Canary Is.': 'Canary Islands', 'Foral de Navarra': 'Navarre',
            'Castilla y León': 'Castile and León', 'Castilla-La Mancha': 'Castile-La Mancha',
            'Aragón': 'Aragon'},
    'FRA': {'Bretagne': 'Brittany', 'Normandie': 'Normandy', 'Corse': 'Corsica',
            'Guyane française': 'French Guiana', "Provence-Alpes-Côte-d'Azur": "Provence-Alpes-Côte d'Azur"},
    'PHL': {'Dinagat Islands (Region XIII)': 'Caraga (Region XIII)',
            'Autonomous Region in Muslim Mindanao (ARMM)': 'Bangsamoro (BARMM)'},
    'DEU': {'Free Hanseatic Bremen': 'Bremen'},
    'UKR': {'Kiev City': 'Kyiv City', 'Kiev': 'Kyiv Oblast', "L'viv": 'Lviv', 'Odessa': 'Odesa'},
}
UNIT_WORDS = {
    'state': 'States', 'province': 'Provinces', 'prefecture': 'Prefectures', 'region': 'Regions',
    'county': 'Counties', 'department': 'Departments', 'district': 'Districts',
    'canton': 'Cantons', 'governorate': 'Governorates', 'emirate': 'Emirates',
    'municipality': 'Municipalities', 'parish': 'Parishes',
}
UNIT_OVERRIDE = {'GBR': 'Nations', 'CAN': 'Provinces & territories', 'AUS': 'States & territories',
                 'USA': 'States', 'DEU': 'States', 'POL': 'Voivodeships', 'RUS': 'Federal subjects',
                 'IND': 'States & territories', 'CHN': 'Provinces'}

# ------------------------------------------------------------ point encoding
# A vertex is one int, snapped to 0.0001 degrees, which makes the file-to-file
# comparison exact and keeps two million vertices in memory cheaply.
SNAP = 10000
XO, YO, YS = 3_000_000, 1_000_000, 1 << 22


def enc(lon, lat):
    return (round(lon * SNAP) + XO) * YS + round(lat * SNAP) + YO


def dec(p):
    return (p // YS - XO) / SNAP, (p % YS - YO) / SNAP


def ring_km2(points):
    """Spherical area of a closed lon/lat ring."""
    total = 0.0
    n = len(points) - 1
    for i in range(n):
        before = points[i - 1 if i else n - 1]      # not points[-1]: that's the closing copy of points[0]
        total += math.radians(points[i + 1][0] - before[0]) * math.sin(math.radians(points[i][1]))
    return abs(total) * 6371.0088 ** 2 / 2


def prepare(geometry):
    """GeoJSON geometry -> (rings of encoded vertices, area in km2), unwrapped past the cut."""
    polygons = geometry['coordinates'] if geometry['type'] == 'MultiPolygon' else [geometry['coordinates']]
    rings, area = [], 0.0
    for polygon in polygons:
        outer = [tuple(p[:2]) for p in polygon[0]]
        lons = [p[0] for p in outer]
        if max(lons) - min(lons) > 300:
            rings.append(clean(polar_ring(outer)))
            continue
        shift = 360 if (min(lons) + max(lons)) / 2 < CUT else 0
        for index, ring in enumerate(polygon):
            points = [(p[0] + shift, p[1]) for p in ring]
            area += ring_km2(points) * (1 if index == 0 else -1)
            rings.append(clean(points))
    return [r for r in rings if len(r) >= 4], area


def polar_ring(outer):
    """Antarctica circles the pole. Natural Earth closes it with a detour down 180
    degrees and along the pole. This keeps just the coast, running east from CUT
    for exactly 360 degrees, and closes it along CUT+360, the pole and CUT. The
    app recognises a ring that wide and re-cuts it wherever the map edge is."""
    body = outer[:-1]
    seam = [i for i, (lon, lat) in enumerate(body) if abs(abs(lon) - 180) < 1e-9 or lat <= -89.999]
    first, last = seam[0], seam[-1]
    assert seam == list(range(first, last + 1)), 'expected one run of seam points'
    coast = body[last:] + body[:first + 1]             # (-180, lat) ... east ... (180, lat)
    for i in range(len(coast) - 1):
        (a_lon, a_lat), (b_lon, b_lat) = coast[i], coast[i + 1]
        if a_lon <= CUT < b_lon:
            t = (CUT - a_lon) / (b_lon - a_lon)
            start = (CUT, a_lat + t * (b_lat - a_lat))
            east = coast[i + 1:]                       # CUT ... 180
            west = [(lon + 360, lat) for lon, lat in coast[1:i + 1]]   # 180 ... CUT+360
            run = [start] + east + west + [(CUT + 360, start[1])]
            return run + [(CUT + 360, -90.0), (CUT, -90.0), start]
    raise AssertionError('coast never crosses the cut')


def clean(points):
    out = []
    for lon, lat in points:
        p = enc(lon, lat)
        if not out or out[-1] != p:
            out.append(p)
    if out and out[0] != out[-1]:
        out.append(out[0])
    return out


# ------------------------------------------------------------------- topology
class Topology:
    def __init__(self):
        self.neighbours = {}
        self.junctions = set()
        self.arcs = []
        self.index = {}

    def scan(self, ring):
        n = len(ring) - 1
        seen, junctions = self.neighbours, self.junctions
        for i in range(n):
            a, p, b = ring[i - 1 if i else n - 1], ring[i], ring[i + 1]
            pair = (a, b) if a < b else (b, a)
            known = seen.get(p)
            if known is None:
                seen[p] = pair
            elif known != pair:
                junctions.add(p)

    def add_arc(self, points):
        """Register a directed arc, returns a signed reference (~id means reversed)."""
        forward = tuple(points)
        backward = forward[::-1]
        ref = self.index.get(forward)
        if ref is not None:
            return ref
        ref = self.index.get(backward)
        if ref is not None:
            return ~ref
        ref = len(self.arcs)
        self.arcs.append(forward)
        self.index[forward] = ref
        return ref

    def split(self, ring):
        """Closed ring -> list of signed arc refs."""
        body = ring[:-1]
        cuts = [i for i, p in enumerate(body) if p in self.junctions]
        if not cuts:
            # A free-standing loop. Canonicalise it so an island drawn by both
            # files (with different start points or winding) is still one arc.
            start = body.index(min(body))
            body = body[start:] + body[:start]
            if body[1] > body[-1]:
                body = [body[0]] + body[1:][::-1]
            return [self.add_arc(body + [body[0]])]
        first = cuts[0]
        body = body[first:] + body[:first]
        cuts = [c - first for c in cuts]
        refs = []
        for a, b in zip(cuts, cuts[1:] + [len(body)]):
            refs.append(self.add_arc(body[a:b] + [body[b % len(body)]]))
        return refs

    def ends(self, ref):
        arc = self.arcs[ref if ref >= 0 else ~ref]
        return (arc[0], arc[-1]) if ref >= 0 else (arc[-1], arc[0])


def dissolve(topology, ring_lists):
    """Union of shapes: arcs travelled both ways are interior and vanish."""
    used = Counter()
    for ring in ring_lists:
        for ref in ring:
            used[ref] += 1
    keep = []
    for ref, count in used.items():
        opposite = used.get(~ref, 0)
        # Keep whichever direction wins. Equal counts cancel out.
        keep.extend([ref] * max(0, count - opposite))
    by_start = defaultdict(list)
    for ref in keep:
        by_start[topology.ends(ref)[0]].append(ref)
    rings = []
    for ref in keep:
        start, end = topology.ends(ref)
        if ref not in by_start[start]:
            continue
        by_start[start].remove(ref)
        chain = [ref]
        while end != start:
            options = by_start.get(end)
            if not options:
                break
            nxt = options.pop()
            chain.append(nxt)
            end = topology.ends(nxt)[1]
        if end == start:
            rings.append(chain)
    return rings


# --------------------------------------------------------------- simplification
def visvalingam(xs, ys):
    """Effective area of every vertex of an open polyline. Endpoints are infinite."""
    n = len(xs)
    area = [math.inf] * n
    if n < 3:
        return area
    prev = list(range(-1, n - 1))
    nxt = list(range(1, n + 1))
    current = [0.0] * n

    def triangle(a, b, c):
        return abs((xs[a] - xs[c]) * (ys[b] - ys[a]) - (xs[a] - xs[b]) * (ys[c] - ys[a])) / 2

    heap = []
    for i in range(1, n - 1):
        current[i] = triangle(i - 1, i, i + 1)
        heap.append((current[i], i))
    heapq.heapify(heap)
    floor = 0.0
    while heap:
        value, i = heapq.heappop(heap)
        if current[i] != value:
            continue
        current[i] = -1.0
        floor = max(floor, value)
        area[i] = floor
        p, q = prev[i], nxt[i]
        nxt[p], prev[q] = q, p
        for j in (p, q):
            if 0 < j < n - 1:
                current[j] = triangle(prev[j], j, nxt[j])
                heapq.heappush(heap, (current[j], j))
    return area


def arc_weights(arc):
    """Visvalingam weights measured in Equal Earth map units. The projection is
    equal-area, so a triangle's area doesn't depend on where the map is centred."""
    lon, lat, xs, ys = [], [], [], []
    for p in arc:
        x, y = dec(p)
        lon.append(x)
        lat.append(y)
        ex, ey = ee_point(x, y)
        xs.append(ex)
        ys.append(ey)
    if arc[0] != arc[-1]:
        return lon, lat, visvalingam(xs, ys)
    # Closed loop: pin the vertex furthest from the start so it can't collapse.
    far = max(range(len(arc)), key=lambda i: (xs[i] - xs[0]) ** 2 + (ys[i] - ys[0]) ** 2)
    first = visvalingam(xs[:far + 1], ys[:far + 1])
    second = visvalingam(xs[far:], ys[far:])
    return lon, lat, first[:-1] + second


class Simplified:
    def __init__(self, topology):
        self.topology = topology
        self.coords = {}

    def arc_points(self, ref, threshold):
        index = ref if ref >= 0 else ~ref
        key = (index, threshold)
        points = self.coords.get(key)
        if points is None:
            if index not in self.coords:
                self.coords[index] = arc_weights(self.topology.arcs[index])
            lon, lat, weight = self.coords[index]
            points = [(lon[i], lat[i]) for i in range(len(lon)) if weight[i] >= threshold]
            self.coords[key] = points
        return points if ref >= 0 else points[::-1]

    def ring_points(self, ring, threshold):
        out = []
        for ref in ring:
            points = self.arc_points(ref, threshold)
            out.extend(points[1:] if out else points)
        return out


def quantise(points):
    out = []
    for lon, lat in points:
        q = (round((lon - CUT) / GRID), round((90 - lat) / GRID))
        if not out or out[-1] != q:
            out.append(q)
    if len(out) > 1 and out[0] == out[-1]:
        out.pop()
    return out


def number_pair(dx, dy):
    return f"{dx}{dy}" if dy < 0 else f"{dx} {dy}"


def to_path(rings):
    parts = []
    for ring in rings:
        x, y = ring[0]
        pairs = []
        for nx, ny in ring[1:]:
            pairs.append(number_pair(nx - x, ny - y))
            x, y = nx, ny
        body = ''
        for pair in pairs:
            body += pair if pair.startswith('-') or not body else ' ' + pair
        parts.append(f"M{ring[0][0]} {ring[0][1]}l{body}z")
    return ''.join(parts)


def shape(simplified, rings, threshold, min_ring, keep_largest):
    """Rings of arcs -> quantised rings at one level of detail."""
    out = []
    largest, largest_size = None, -1.0
    for ring in rings:
        points = simplified.ring_points(ring, threshold)
        if len(points) < 3:
            points = simplified.ring_points(ring, 0)
        size = ring_size(points)
        q = quantise(points)
        if len(q) < 3:
            q = quantise(simplified.ring_points(ring, 0))
        if len(q) < 3:
            continue
        if size > largest_size:
            largest, largest_size = q, size
        if size >= min_ring:
            out.append(q)
    if not out and keep_largest and largest:
        out = [largest]
    return out


def ring_size(points):
    """Larger side of a lon/lat ring's box, in map units."""
    lons = [p[0] for p in points]
    lats = [p[1] for p in points]
    middle = (min(lats) + max(lats)) / 2
    return max((max(lons) - min(lons)) * ee_factor(middle) / EE_F0, ee_y(max(lats)) - ee_y(min(lats)))


def r3(value):
    return round(value, 3)


def lon_span(intervals):
    """Smallest arc of longitude covering every [west, east] interval, as
    (west, east) with west in [-180, 180) and east > west, possibly past 180.
    The USA, for one, runs from the far Aleutians east to Maine."""
    if any(e - w >= 359.9 for w, e in intervals):
        return -180.0, 180.0
    # Mark half-degree bins round the circle, find the widest empty run, and cut
    # the circle in the middle of it.
    bins = [False] * 720
    for w, e in intervals:
        for b in range(math.floor(w * 2), math.ceil(e * 2) + 1):
            bins[b % 720] = True
    if all(bins):
        return -180.0, 180.0
    best_len, best_mid, run = 0, 0.0, 0
    for b in range(720 * 2):                    # twice round, so a run can wrap
        if bins[b % 720]:
            run = 0
            continue
        run += 1
        if run > best_len and run <= 720:
            best_len, best_mid = run, (b - run / 2) / 2
    cut = best_mid
    shifted = [(cut + (w - cut) % 360, cut + (w - cut) % 360 + (e - w)) for w, e in intervals]
    west = min(s[0] for s in shifted)
    east = max(s[1] for s in shifted)
    offset = (west + 180) // 360 * 360
    return west - offset, east - offset


def bounds(rings):
    """[west, south, east, north] in degrees for grid rings."""
    intervals, south, north = [], 90.0, -90.0
    for ring in rings:
        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        intervals.append((min(xs) * GRID + CUT, max(xs) * GRID + CUT))
        north = max(north, 90 - min(ys) * GRID)
        south = min(south, 90 - max(ys) * GRID)
    west, east = lon_span(intervals)
    return [r3(west), r3(south), r3(east), r3(north)]


def planar_area(ring):
    return abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:] + ring[:1]))) / 2


def focus_box(country_id, rings):
    if country_id in FOCUS:
        return list(FOCUS[country_id])
    sized = sorted(((planar_area(r), r) for r in rings), key=lambda t: -t[0])
    total = sum(a for a, _ in sized) or 1
    chosen = [r for a, r in sized if a >= total * 0.05] or [sized[0][1]]
    return bounds(chosen)


# ------------------------------------------------------------- label anchors
def signed_distance(px, py, edges):
    """Distance from a point to the nearest edge; negative when outside."""
    inside = False
    best = math.inf
    for ax, ay, bx, by in edges:
        if (ay > py) != (by > py) and px < (bx - ax) * (py - ay) / (by - ay) + ax:
            inside = not inside
        dx, dy = bx - ax, by - ay
        length = dx * dx + dy * dy
        t = ((px - ax) * dx + (py - ay) * dy) / length if length else 0.0
        t = 0.0 if t < 0 else 1.0 if t > 1 else t
        ex, ey = ax + t * dx - px, ay + t * dy - py
        d = ex * ex + ey * ey
        if d < best:
            best = d
    return math.sqrt(best) if inside else -math.sqrt(best)


# Equal Earth map units per kilometre. One number works everywhere because the
# projection is equal-area.
UNITS_PER_KM = math.sqrt((ee_y(0.5) - ee_y(-0.5)) / 110.574 / 111.32)


def lat_of_ee_y(y):
    low, high = -90.0, 90.0
    for _ in range(60):
        mid = (low + high) / 2
        if ee_y(mid) < y:
            low = mid
        else:
            high = mid
    return (low + high) / 2


def label_anchor(rings, hint=None):
    """The point deepest inside a shape's main ring (Mapbox's polylabel idea),
    measured on Equal Earth centred on the shape, which is how the app shows a
    place you're looking at. Natural Earth's own label point wins when it sits
    nearly as deep. Returns lon, lat and the distance to the nearest edge in
    km, which tells the app how much room a name has before it needs a leader."""
    def grid_to_deg(ring):
        return [grid_lonlat(x, y) for x, y in ring]

    main = max(rings, key=planar_area)
    main_deg = grid_to_deg(main)
    lons = [p[0] for p in main_deg]
    lats = [p[1] for p in main_deg]
    west, east, south, north = min(lons), max(lons), min(lats), max(lats)
    centre = (west + east) / 2

    def project(lon, lat):
        return (lon - centre) * ee_factor(lat) / EE_F0, ee_y(lat)

    main_xy = [project(lon, lat) for lon, lat in main_deg]
    x_min = min(p[0] for p in main_xy)
    y_min = min(p[1] for p in main_xy)
    width = max(p[0] for p in main_xy) - x_min
    height = max(p[1] for p in main_xy) - y_min

    def local(lon, lat):
        x, y = project(lon, lat)
        return x - x_min, y - y_min

    # The main ring, plus anything inside its box: holes and enclaves matter.
    edges = []
    for ring in rings:
        deg = main_deg if ring is main else grid_to_deg(ring)
        if ring is not main:
            rl = [p[0] for p in deg]
            rt = [p[1] for p in deg]
            if min(rl) < west or max(rl) > east or min(rt) < south or max(rt) > north:
                continue
        pts = [local(lon, lat) for lon, lat in deg]
        edges.extend((a[0], a[1], b[0], b[1]) for a, b in zip(pts, pts[1:] + pts[:1]))

    size = min(width, height)
    if size <= 0:
        return r3(lons[0]), r3(lats[0]), 0.0
    precision = max(width, height) / 40
    half = size / 2
    heap = []

    def push(x, y, h):
        d = signed_distance(x, y, edges)
        heapq.heappush(heap, (-(d + h * math.sqrt(2)), x, y, h, d))

    y = 0.0
    while y < height:
        x = 0.0
        while x < width:
            push(x + half, y + half, half)
            x += size
        y += size
    best = (width / 2, height / 2, signed_distance(width / 2, height / 2, edges))
    visited = 0
    while heap and visited < 2500:
        potential, x, y, h, d = heapq.heappop(heap)
        visited += 1
        if d > best[2]:
            best = (x, y, d)
        if -potential - best[2] <= precision:
            continue
        h /= 2
        for ox, oy in ((-h, -h), (h, -h), (-h, h), (h, h)):
            push(x + ox, y + oy, h)

    bx, by, bd = best
    lat = lat_of_ee_y(by + y_min)
    lon = centre + (bx + x_min) / (ee_factor(lat) / EE_F0)
    if hint:
        hx, hy = hint
        # Same longitude frame as the ring, then judge the hint by the same rule.
        while hx < west - 180:
            hx += 360
        while hx > east + 180:
            hx -= 360
        hd = signed_distance(*local(hx, hy), edges)
        if hd >= bd * 0.6:
            lon, lat, bd = hx, hy, hd
    return r3(lon), r3(lat), round(max(bd, 0) / UNITS_PER_KM, 1)


def slug(text):
    text = unicodedata.normalize('NFKD', text).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'[^a-z0-9]+', '-', text).strip('-')


def state_name(props, country_id, country_name, taken):
    name = props.get('name') or ''
    english = props.get('name_en') or ''
    english = re.sub(r'\s+(Prefecture|Voivodeship|Canton|State)$', '', english)
    english = re.sub(r'^Canton of\s+', '', english)
    if country_id == 'USA' or not english or english == country_name or english in taken:
        return name
    return english


def main():
    source, out_dir = sys.argv[1], sys.argv[2]
    countries_raw = json.load(open(source_file(source, 'ne_10m_admin_0_countries')))['features']
    states_raw = json.load(open(source_file(source, 'ne_10m_admin_1_states_provinces')))['features']

    # ---- load everything into one pool of rings
    topology = Topology()
    country_rings, country_area, country_props = defaultdict(list), Counter(), {}
    for feature in countries_raw:
        props = feature['properties']
        rings, area = prepare(feature['geometry'])
        code = props['ADM0_A3']
        country_props[code] = props
        target = MERGE_INTO.get(code, code)
        country_rings[target].extend(rings)
        country_area[target] += area

    state_units = defaultdict(list)
    for feature in states_raw:
        props = feature['properties']
        owner = props['adm0_a3']
        # Natural Earth's default view gives Crimea to Russia, though the ISO codes
        # on those same rows are Ukrainian. This follows the UN General Assembly.
        if props.get('iso_3166_2') in ('UA-43', 'UA-40'):
            owner = 'UKR'
        rings, area = prepare(feature['geometry'])
        state_units[owner].append({'props': props, 'rings': rings, 'area': area})

    for rings in country_rings.values():
        for ring in rings:
            topology.scan(ring)
    for units in state_units.values():
        for unit in units:
            for ring in unit['rings']:
                topology.scan(ring)
    print(f'{len(topology.neighbours):,} vertices, {len(topology.junctions):,} junctions')

    country_arcs = {code: [topology.split(r) for r in rings] for code, rings in country_rings.items()}
    for units in state_units.values():
        for unit in units:
            unit['arcs'] = [topology.split(r) for r in unit['rings']]
    print(f'{len(topology.arcs):,} arcs')

    # Crimea moves: both countries are rebuilt from their states.
    moved_km2 = sum(u['area'] for u in state_units['UKR'] if u['props'].get('iso_3166_2') in ('UA-43', 'UA-40'))
    for code in ('RUS', 'UKR'):
        country_arcs[code] = [ring for unit in state_units[code] for ring in unit['arcs']]
    country_area['RUS'] -= moved_km2
    country_area['UKR'] += moved_km2
    country_area['ATA'] = 14_000_000    # the clipped polar cap would otherwise go uncounted

    country_arcs = {code: dissolve(topology, rings) for code, rings in country_arcs.items()}

    # ---- group states
    simplified = Simplified(topology)
    world = []
    state_file = {}
    stats = Counter()
    for code, rings in sorted(country_arcs.items()):
        props = country_props[code]
        name = COUNTRY_NAMES.get(code) or props['ADMIN']
        if code in NOT_SELECTABLE:
            kind = 'land'
        elif code in ALSO_SOVEREIGN or (props['TYPE'] in ('Sovereign country', 'Country') and code not in NOT_SOVEREIGN):
            kind = 'country'
        else:
            kind = 'territory'
        levels = [shape(simplified, rings, t, size, False) for t, size in LEVELS[:2]]
        hi_rings = shape(simplified, rings, *LEVELS[2], True)
        lx, ly = props['LABEL_X'], props['LABEL_Y']
        if not hi_rings:
            if kind == 'land':
                continue
            # Smaller than the grid (Vatican City). It still needs to exist: the map
            # draws anything this small as a dot, so a token square is enough.
            x, y = round((lx - CUT) % 360 / GRID), round((90 - ly) / GRID)
            hi_rings = [[(x - 3, y - 3), (x + 3, y - 3), (x + 3, y + 3), (x - 3, y + 3)]]
        anchor_lon, anchor_lat, room = label_anchor(levels[0] or levels[1] or hi_rings, (lx, ly))
        for number, rings_at_level in enumerate(levels + [hi_rings]):
            stats[f'level{number}'] += sum(len(r) for r in rings_at_level)
        iso2 = props['ISO_A2_EH'] if props['ISO_A2_EH'] != '-99' else ''
        if code in ('IOA', 'CSI', 'ATC', 'KAB', 'SOL', 'CYN'):
            iso2 = {'IOA': 'CX'}.get(code, '')
        continent = CONTINENT_FIX.get(code) or props['CONTINENT']
        record = {
            'id': code, 'name': name, 'iso2': iso2, 'cont': continent, 'kind': kind,
            'area': round(country_area[code]), 'lx': anchor_lon, 'ly': anchor_lat, 'room': room,
            'bbox': bounds(hi_rings), 'focus': focus_box(code, hi_rings),
            'paths': [to_path(r) for r in levels] + [to_path(hi_rings)],
        }
        if kind == 'territory' and props['SOVEREIGNT'] not in (props['ADMIN'], name):
            sovereign = props['SOVEREIGNT']
            record['sov'] = {'United States of America': 'United States'}.get(sovereign, sovereign)
        world.append(record)

        # ---- this country's states
        units = state_units.get(code, [])
        if kind == 'land' or code in NO_STATES or country_area[code] < NO_STATES_UNDER_KM2 or len(units) < 2:
            continue
        renames = STATE_NAMES.get(code, {})
        merges = MERGE_STATES.get(code, {})
        field = GROUP_BY.get(code)
        taken = Counter((u['props'].get('name_en') or '') for u in units)
        repeated = {n for n, c in taken.items() if c > 1}
        groups = defaultdict(list)
        for unit in units:
            p = unit['props']
            if not p.get('name'):
                continue            # unnamed offshore fragments stay in the country fill only
            base = state_name(p, code, name, repeated)
            if field and p.get(field):
                base = p[field]
            base = merges.get(base, base)
            base = renames.get(base) or base
            groups[base].append(unit)
        if len(groups) < 2:
            continue
        entries = []
        for unit_name, members in sorted(groups.items(), key=lambda kv: slug(kv[0])):
            merged = dissolve(topology, [ring for m in members for ring in m['arcs']])
            s_rings = shape(simplified, merged, *LEVELS[2], True)
            if not s_rings:
                continue
            coarse = shape(simplified, merged, *LEVELS[1], True)
            stats['state_vertices'] += sum(len(r) for r in s_rings)
            anchor = max(members, key=lambda m: m['area'])['props']
            rough = shape(simplified, merged, *LEVELS[0], True) or coarse
            ax, ay, room = label_anchor(rough, (anchor['longitude'], anchor['latitude']))
            entries.append({'id': f"{code}-{slug(unit_name)}", 'name': unit_name, 'lx': ax, 'ly': ay,
                            'room': room, 'area': round(sum(m['area'] for m in members)),
                            'bbox': bounds(s_rings), 'paths': [to_path(coarse), to_path(s_rings)]})
        ids = Counter(e['id'] for e in entries)
        assert max(ids.values()) == 1, (code, ids.most_common(3))
        kinds = Counter((u['props'].get('type_en') or '').lower() for u in units)
        word = UNIT_OVERRIDE.get(code)
        if not word:
            word = 'Regions' if field else UNIT_WORDS.get(kinds.most_common(1)[0][0], 'Regions')
        state_file[code] = {'unit': word, 'list': entries}

    counted = [c for c in world if c['kind'] == 'country']
    assert len(counted) == 197, len(counted)
    print(f"{len(counted)} countries, {sum(c['kind'] == 'territory' for c in world)} territories, "
          f"{len(state_file)} countries with states, {sum(len(v['list']) for v in state_file.values())} states")
    print(dict(stats))

    os.makedirs(out_dir, exist_ok=True)
    payload = {'grid': GRID, 'cut': CUT, 'countries': world}
    write(os.path.join(out_dir, 'world.js'), 'TN_WORLD', payload)
    write(os.path.join(out_dir, 'states.js'), 'TN_STATES', state_file)


def source_file(folder, name):
    """Prefer the lake-cut version of a Natural Earth file."""
    lakes = os.path.join(folder, f'{name}_lakes.geojson')
    if os.path.exists(lakes):
        return lakes
    print(f'{name}_lakes.geojson not found: using {name}.geojson, so lakes will be drawn as land')
    return os.path.join(folder, f'{name}.geojson')


def write(path, variable, value):
    text = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    with open(path, 'w', encoding='utf-8') as handle:
        handle.write(f'window.{variable}={text};\n')
    print(f'{path}: {os.path.getsize(path) / 1e6:.2f} MB')


if __name__ == '__main__':
    main()
