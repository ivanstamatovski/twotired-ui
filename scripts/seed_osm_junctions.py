#!/usr/bin/env python3
"""Seed/refresh the osm_junctions cache from Overpass.

generate-route (v2.97+) tags motorway exit numbers by looking up the nearest
highway=motorway_junction node (ref = exit number). To keep public Overpass OFF
the request hot path, those nodes are cached in Supabase's osm_junctions table
and the edge fn queries that. This script (re)populates the cache.

Run occasionally (junctions rarely change):
    python3 scripts/seed_osm_junctions.py

Needs ~/.supabase_pat (Supabase Management API token). Covers the GH graph bbox.
"""
import json, os, sys, time, urllib.parse, urllib.request

PROJECT_REF = "ujvfwzcjgxupvtiwllhw"
UA = "twotired-routing/1.0 (ivan@easyaerial.com)"
# GH graph coverage bbox (from /gh/info), as Overpass south,west,north,east.
BBOX = (37.82893, -80.588779, 47.487968, -66.124527)
OVERPASS = "https://overpass-api.de/api/interpreter"
CHUNK = 1500


def pat():
    with open(os.path.expanduser("~/.supabase_pat")) as f:
        return f.read().strip()


def sql(query, token):
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{PROJECT_REF}/database/query",
        data=json.dumps({"query": query}).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "User-Agent": UA},
    )
    return json.load(urllib.request.urlopen(req, timeout=120))


def fetch_junctions():
    s, w, n, e = BBOX
    q = f"[out:json][timeout:180];node[highway=motorway_junction][ref]({s},{w},{n},{e});out;"
    req = urllib.request.Request(
        OVERPASS, data=("data=" + urllib.parse.quote(q)).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA},
    )
    data = json.load(urllib.request.urlopen(req, timeout=200))
    out = []
    for el in data.get("elements", []):
        if el.get("type") != "node" or "lat" not in el:
            continue
        ref = (el.get("tags", {}) or {}).get("ref")
        if not ref:
            continue
        out.append((el["id"], el["lat"], el["lon"], ref, (el.get("tags", {}) or {}).get("name")))
    return out


def esc(v):
    return "null" if v is None else "'" + str(v).replace("'", "''") + "'"


def main():
    token = pat()
    print("Fetching motorway_junction nodes from Overpass…")
    rows = fetch_junctions()
    print(f"  {len(rows)} nodes with a ref")
    if not rows:
        sys.exit("no rows — aborting (left existing cache untouched)")
    total = 0
    for i in range(0, len(rows), CHUNK):
        chunk = rows[i:i + CHUNK]
        values = ",".join(
            f"({osm_id},{lat},{lng},{esc(ref)},{esc(name)})" for (osm_id, lat, lng, ref, name) in chunk
        )
        sql(
            "insert into osm_junctions (osm_id,lat,lng,ref,name) values " + values +
            " on conflict (osm_id) do update set lat=excluded.lat, lng=excluded.lng,"
            " ref=excluded.ref, name=excluded.name, updated_at=now();",
            token,
        )
        total += len(chunk)
        print(f"  upserted {total}/{len(rows)}")
        time.sleep(0.2)
    n = sql("select count(*) as n from osm_junctions;", token)[0]["n"]
    print(f"Done. osm_junctions now holds {n} rows.")


if __name__ == "__main__":
    main()
