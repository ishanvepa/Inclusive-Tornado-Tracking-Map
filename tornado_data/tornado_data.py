import json
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests

BASE_URL = "https://api.weather.gov"

# NWS requires a custom User-Agent.
HEADERS = {
    "User-Agent": "(Inclusive-Tornado-Tracking-Map, ishanvepa171@gmail.com)",
    "Accept": "application/geo+json",
}


def fetch_tornado_alerts(
    active_only: bool = True,
    event: Optional[str] = "Tornado Warning",
    point: Optional[str] = None,
    area: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Fetch tornado alerts from api.weather.gov.

    Args:
        active_only: If True, use /alerts/active. If False, use /alerts
                     (historical + recent alerts, typically last 7 days).
        event: Alert event name, e.g. "Tornado Warning" or "Tornado Watch".
               Set to None to pull all alert types.
        point: Optional "lat,lon" string, e.g. "33.7490,-84.3880"
        area: Optional state/area code, e.g. "GA"

    Returns:
        Parsed GeoJSON response from NWS.
    """
    endpoint = f"{BASE_URL}/alerts/active" if active_only else f"{BASE_URL}/alerts"

    params: Dict[str, str] = {}
    if event:
        params["event"] = event
    if point:
        params["point"] = point
    if area:
        params["area"] = area

    response = requests.get(endpoint, headers=HEADERS, params=params, timeout=30)
    response.raise_for_status()
    return response.json()


def extract_features_with_geometry(alert_geojson: Dict[str, Any]) -> Dict[str, Any]:
    """
    Keep only alerts that have a valid geometry.
    Useful because some alerts like Tornado Watch may not include polygons.
    """
    features = alert_geojson.get("features", [])
    filtered_features: List[Dict[str, Any]] = []

    for feature in features:
        geometry = feature.get("geometry")
        if geometry:
            filtered_features.append(feature)

    return {
        "type": "FeatureCollection",
        "features": filtered_features,
    }


def save_geojson(data: Dict[str, Any], output_path: str) -> None:
    Path(output_path).write_text(json.dumps(data, indent=2), encoding="utf-8")


if __name__ == "__main__":
    # Example 1: active tornado warnings across the U.S.
    alerts = fetch_tornado_alerts(
        active_only=False,
        event="Tornado Warning",
    )
    tornado_warning_geojson = extract_features_with_geometry(alerts)
    save_geojson(tornado_warning_geojson, "active_tornado_warnings.geojson")
    print(
        f"Saved {len(tornado_warning_geojson['features'])} tornado warning polygons "
        f"to active_tornado_warnings.geojson"
    )

    # Example 2: active tornado alerts affecting a specific point
    # Atlanta example:
    point_alerts = fetch_tornado_alerts(
        active_only=False,
        event="Tornado Warning",
        point="33.7490,-84.3880",
    )
    point_geojson = extract_features_with_geometry(point_alerts)
    save_geojson(point_geojson, "point_tornado_warnings.geojson")
    print(
        f"Saved {len(point_geojson['features'])} point-based tornado warning polygons "
        f"to point_tornado_warnings.geojson"
    )

    # Example 3: tornado watches (often no polygon geometry)
    watch_alerts = fetch_tornado_alerts(
        active_only=True,
        event="Tornado Watch",
    )
    save_geojson(watch_alerts, "active_tornado_watches_raw.geojson")
    print(
        f"Saved raw tornado watch response with "
        f"{len(watch_alerts.get('features', []))} features "
        f"to active_tornado_watches_raw.geojson"
    )