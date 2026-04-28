// =====================================================
// Inclusive Tornado Tracking Map — map.js
// =====================================================



// =====================================================
// Severity Helpers
// =====================================================

/**
 * Derive a severity tier (1–4) from NWS alert properties.
 *
 * Tier 1 — Radar Indicated
 * Tier 2 — Observed by spotters / trained observers
 * Tier 3 — Radar Confirmed (explicit tornadoDetection=CONFIRMED)
 * Tier 4 — PDS (Particularly Dangerous Situation) or Tornado Emergency
 */
function deriveSeverityTier(props) {
  const detection = (
    (props.parameters && props.parameters.tornadoDetection && props.parameters.tornadoDetection[0]) || ''
  ).toUpperCase();

  const headline = (props.headline || '').toUpperCase();
  const desc = (props.description || '').toUpperCase();

  // PDS / Tornado Emergency → Tier 4
  if (
    headline.includes('PARTICULARLY DANGEROUS SITUATION') ||
    desc.includes('PARTICULARLY DANGEROUS SITUATION') ||
    headline.includes('TORNADO EMERGENCY') ||
    desc.includes('TORNADO EMERGENCY') ||
    detection.includes('EMERGENCY')
  ) {
    return 4;
  }

  // Confirmed tornado on the ground → Tier 3
  if (detection === 'CONFIRMED' || detection.includes('CONFIRMED')) {
    return 3;
  }

  // Spotter-observed / NWS-observed → Tier 2
  if (
    detection === 'OBSERVED' ||
    detection.includes('OBSERVED') ||
    (props.certainty || '').toUpperCase() === 'OBSERVED'
  ) {
    return 2;
  }

  // Default: Radar Indicated → Tier 1
  return 1;
}

function tierToPolygonColor(tier) {
  if (tier >= 4) return '#8B0000';
  if (tier === 3) return '#CC0000';
  if (tier === 2) return '#FF4500';
  return '#FF8C00';
}

function tierToLabel(tier) {
  if (tier >= 4) return 'PDS / Tornado Emergency';
  if (tier === 3) return 'Confirmed';
  if (tier === 2) return 'Observed';
  return 'Radar Indicated';
}

/**
 * Compute the centroid of a polygon ring (array of [lon, lat] pairs).
 */
function polygonCentroid(ring) {
  let sumLon = 0, sumLat = 0, n = ring.length;
  for (const pt of ring) {
    sumLon += pt[0];
    sumLat += pt[1];
  }
  return { lon: sumLon / n, lat: sumLat / n };
}


// =====================================================
// Parse GeoJSON into a flat list of warning objects
// =====================================================
function parseWarnings(geojson) {
  const warnings = [];

  for (const feature of geojson.features) {
    if (!feature.geometry) continue;

    const props = feature.properties || {};
    const tier = deriveSeverityTier(props);

    // Collect polygon rings (handles both Polygon and MultiPolygon)
    const geometryCoords = [];
    if (feature.geometry.type === 'Polygon') {
      geometryCoords.push(feature.geometry.coordinates[0]);
    } else if (feature.geometry.type === 'MultiPolygon') {
      for (const poly of feature.geometry.coordinates) {
        geometryCoords.push(poly[0]);
      }
    }

    for (const ring of geometryCoords) {
      const centroid = polygonCentroid(ring);

      warnings.push({
        id: props.id || feature.id || '',
        areaDesc: props.areaDesc || 'Unknown Area',
        sent: props.sent || '',
        onset: props.onset || props.effective || '',
        expires: props.expires || props.ends || '',
        event: props.event || 'Tornado Warning',
        severity: props.severity || 'Unknown',
        certainty: props.certainty || 'Unknown',
        urgency: props.urgency || 'Unknown',
        headline: props.headline || '',
        description: props.description || '',
        instruction: props.instruction || '',
        senderName: props.senderName || '',
        messageType: props.messageType || 'Alert',
        tier,
        centroid,
        ring,             // raw polygon ring for rendering
        geometry: feature.geometry,
      });
    }
  }

  // Sort by onset time ascending, then by tier descending (highest severity first)
  warnings.sort((a, b) => {
    const ta = new Date(a.onset).getTime() || 0;
    const tb = new Date(b.onset).getTime() || 0;
    if (ta !== tb) return ta - tb;
    return b.tier - a.tier;
  });

  return warnings;
}

// =====================================================
// Group warnings by "event day + hour" for the filter
// =====================================================
function groupWarningsByTime(warnings) {
  const groups = new Map();
  for (let i = 0; i < warnings.length; i++) {
    const w = warnings[i];
    const d = new Date(w.onset);
    // Bucket by hour
    const key = isNaN(d.getTime())
      ? 'Unknown Time'
      : d.toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', hour12: true
      });
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }
  return groups;  // Map<string, number[]>
}

// =====================================================
// Main initialization
// =====================================================
(async () => {
  // Load GeoJSON
  const geojson = await fetch('tornado_data/active_tornado_warnings.geojson').then(r => r.json());
  const warnings = parseWarnings(geojson);
  const timeGroups = groupWarningsByTime(warnings);

  // Fetch US TopoJSON — used as an invisible anchor series so Highcharts has
  // a geographic reference frame for drag-to-pan. Without a mapData series,
  // Highcharts cannot translate mouse drag deltas into coordinate offsets.
  const usa = await fetch('https://code.highcharts.com/mapdata/countries/us/us-all.topo.json').then(r => r.json());


  // Dropdown state
  const timeDropdown = document.getElementById('time-dropdown');
  const timeDropdownItems = document.getElementById('time-dropdown-items');
  const timeToggle = document.getElementById('time-toggle');

  // Track which warnings are currently shown
  let currentGroupKey = null;   // null = show all
  let currentGroupIndices = warnings.map((_, i) => i);  // start with all

  // Start the view near actual warning data so polygons/markers are immediately visible.
  const initialMapCenter = (warnings.length > 0)
    ? [warnings[0].centroid.lon, warnings[0].centroid.lat]
    : [-98.5795, 39.8283]; // fallback: roughly center of contiguous US
  const initialMapZoom = (warnings.length > 0) ? 7 : 3.5;

  // =====================================================
  // Build the Highcharts map
  // =====================================================
  Highcharts.setOptions({
    mapNavigation: { enabled: true, enableButtons: false }
  });

  const chart = Highcharts.mapChart('map-container', {
    chart: {
      reflow: false,
      panning: { enabled: true, type: 'xy' },
    },
    mapView: {
      center: initialMapCenter,
      zoom: initialMapZoom,
    },
    title: { text: null },
    exporting: { enabled: false },
    legend: { enabled: false },
    mapNavigation: { enabled: true, enableButtons: false },
    tooltip: {
      useHTML: true,
      hideDelay: 0,
      style: { maxWidth: '300px' }
    },
    series: [
      // 0: Invisible anchor layer — provides the geographic reference frame
      // that Highcharts needs to convert mouse drag deltas into coordinate
      // offsets. Fully transparent; the OSM tile layer is what you see.
      {
        name: 'Base map',
        mapData: usa,
        nullColor: 'transparent',
        borderColor: 'transparent',
        borderWidth: 0,
        enableMouseTracking: false,
        showInLegend: false,
        accessibility: { enabled: false }
      },
      // 1: OpenStreetMap tiles (visible base layer)
      {
        type: 'tiledwebmap',
        name: 'Basemap Tiles',
        provider: { type: 'OpenStreetMap' },
        showInLegend: false,
        zIndex: -1
      },
      // 2: Warning polygons (map series)
      {
        id: 'warning-polygons',
        name: 'Warning Polygons',
        type: 'map',
        visible: false,
        zIndex: 2,
        enableMouseTracking: true,
        joinBy: null,
        color: 'rgba(255, 69, 0, 0.45)',
        borderColor: '#000000',
        borderWidth: 2.5,
        tooltip: {
          useHTML: true,
          hideDelay: 200,
          pointFormatter: function () {
            const w = this.custom && this.custom.warning;
            if (!w) return '';
            const onset = w.onset ? new Date(w.onset).toLocaleString() : '—';
            const expire = w.expires ? new Date(w.expires).toLocaleString() : '—';
            return `
              <b>${w.event}</b><br/>
              <b>Area:</b> ${w.areaDesc}<br/>
              <b>Severity:</b> ${tierToLabel(w.tier)}<br/>
              <b>Onset:</b> ${onset}<br/>
              <b>Expires:</b> ${expire}<br/>
              <b>Issued by:</b> ${w.senderName}
            `;
          }
        },
        data: []
      },
      // 3: User-added POI markers
      {
        id: 'user-locations',
        name: 'User Locations',
        type: 'mappoint',
        zIndex: 5,
        visible: true,
        tooltip: {
          useHTML: true,
          hideDelay: 500,
          pointFormatter: function () {
            return `<b>Lat:</b> ${this.lat.toFixed(4)}<br/><b>Lon:</b> ${this.lon.toFixed(4)}<br/>`;
          }
        },
        marker: { symbol: 'circle', fillColor: '#00008B', lineColor: '#00008B', lineWidth: 1, radius: 4 },
        data: []
      }
    ]
  });

  // =====================================================
  // Update series data based on selected group
  // =====================================================
  function buildPolygonData(indices) {
    // Pass the raw GeoJSON geometry directly so Highcharts re-projects it on
    // every render/zoom/pan. The old approach manually called proj.forward()
    // to build a static SVG path — those coordinates were only valid at one
    // specific zoom level and caused polygons to disappear or misalign after
    // any map movement.
    return indices.map((i) => {
      const w = warnings[i];
      const base = tierToPolygonColor(w.tier);

      const fill = Highcharts.color
        ? Highcharts.color(base).setOpacity(0.45).get('rgba')
        : 'rgba(255, 69, 0, 0.45)';

      return {
        name: w.areaDesc,
        geometry: w.geometry,   // let Highcharts handle projection
        color: fill,
        borderColor: '#000000',
        borderWidth: 2.5,
        custom: { warning: w }
      };
    }).filter(p => p.geometry != null);
  }

  function updateWarningSeries(indices) {
    const polygonSeries = chart.series.find(s => s.name === 'Warning Polygons');
    if (polygonSeries) polygonSeries.setData(buildPolygonData(indices), false);
    chart.redraw();
  }

  // =====================================================
  // Populate the filter dropdown
  // =====================================================
  // "Show All" item
  const allItem = document.createElement('div');
  allItem.setAttribute('role', 'option');
  allItem.setAttribute('tabindex', '0');
  allItem.classList.add('dropdown-item');
  allItem.dataset.key = '__all__';
  allItem.textContent = `All Warnings (${warnings.length})`;
  allItem.setAttribute('aria-label', `Show all ${warnings.length} tornado warnings`);
  allItem.addEventListener('click', () => {
    currentGroupKey = null;
    currentGroupIndices = warnings.map((_, i) => i);
    updateWarningSeries(currentGroupIndices);
    timeDropdown.style.display = 'none';
  });
  timeDropdownItems.appendChild(allItem);

  // One item per time bucket
  timeGroups.forEach((indices, key) => {
    const item = document.createElement('div');
    item.setAttribute('role', 'option');
    item.setAttribute('tabindex', '0');
    item.classList.add('dropdown-item');
    item.dataset.key = key;

    const maxTier = Math.max(...indices.map(i => warnings[i].tier));
    const tierBadge = `<span style="color:${tierToPolygonColor(maxTier)}">■</span> `;
    item.innerHTML = `${tierBadge}${key} <small style="opacity:0.65">(${indices.length})</small>`;
    item.setAttribute('aria-label', `Select time group ${key}, ${indices.length} warning(s)`);

    const handleSelect = () => {
      currentGroupKey = key;
      currentGroupIndices = indices;
      updateWarningSeries(currentGroupIndices);
      timeDropdown.style.display = 'none';
    };

    item.addEventListener('click', handleSelect);
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSelect(); }
    });

    timeDropdownItems.appendChild(item);
  });


  // =====================================================
  // Button/popup toggle setup
  // =====================================================
  function setupToggle(buttonId, popupId) {
    const button = document.getElementById(buttonId);
    const popup = document.getElementById(popupId);
    if (!button || !popup) return;

    const closeBtn = popup.querySelector('.close-popup');

    button.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = popup.style.display === 'block';

      document.querySelectorAll('.popup').forEach(p => p.style.display = 'none');
      document.querySelectorAll('.dropdown-menu').forEach(d => d.style.display = 'none');
      document.querySelectorAll('.header-button').forEach(btn => btn.classList.remove('active'));

      if (isVisible) {
        popup.style.display = 'none';
        button.classList.remove('active');
        button.blur();
      } else {
        popup.style.display = 'block';
        button.classList.add('active');
      }
    });

    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        popup.style.display = 'none';
        button.classList.remove('active');
        button.blur();
      });
    }
  }

  setupToggle('time-toggle', 'time-dropdown');
  setupToggle('about-button', 'about-popup');
  setupToggle('layers-button', 'layers-popup');
  setupToggle('poi-button', 'poi-popup');



  // =====================================================
  // Layer toggle logic
  // =====================================================
  document.querySelectorAll('.layer-checkbox').forEach(checkbox => {
    checkbox.addEventListener('change', e => {
      const layerName = e.target.dataset.layer;

      if (layerName === 'warnings') {
        const polySeries = chart.series.find(s => s.name === 'Warning Polygons');
        if (polySeries) polySeries.setVisible(e.target.checked, false);
      }


      chart.redraw();
      updatePopupPositions();
    });
  });



  function updatePopupPositions() {
    const visiblePopups = Array.from(document.querySelectorAll('.layer-popup')).filter(p => p.style.display === 'block');
    const popupHeight = 120;
    visiblePopups.forEach((popup, index) => {
      popup.style.bottom = `${10 + (popupHeight + 10) * index}px`;
    });
  }

  // =====================================================
  // POI — address geocoding
  // =====================================================
  const addedLocations = new Map();
  let locationIdCounter = 0;

  document.getElementById('current-location').addEventListener('click', async () => {
    const userLocation = await new Promise(resolve => {
      navigator.geolocation.getCurrentPosition(
        pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
        err => { console.error('Geolocation error:', err); resolve(null); }
      );
    });

    if (userLocation) {
      const id = locationIdCounter++;
      const userLocationsSeries = chart.series.find(s => s.name === 'User Locations');

      userLocationsSeries.addPoint({
        name: 'Your Location',
        lat: userLocation.lat,
        lon: userLocation.lon,
        custom: { id },
        marker: { enabled: true, radius: 0, states: { hover: { enabled: false } } },
        dataLabels: {
          enabled: true,
          useHTML: true,
          formatter: function () {
            return `<div style="font-family:'Inter',sans-serif;font-size:12px;color:white;display:flex;flex-direction:column;align-items:center;"><div class="pulse-marker"></div></div>`;
          },
          style: { textAlign: 'center' }
        },
        tooltip: { pointFormat: 'This is your current location' }
      }, true, false);

      const point = userLocationsSeries.points[userLocationsSeries.points.length - 1];
      addedLocations.set(id, { name: 'Your Location', point });
      renderLocationList();
    } else {
      alert('Unable to retrieve your location.');
    }
  });

  document.getElementById('add-location').addEventListener('click', async () => {
    const addressInput = document.getElementById('location-input');
    const messageDiv = document.getElementById('message');
    const address = addressInput.value.trim();

    if (!address) { messageDiv.innerText = 'Please enter a valid address.'; return; }

    try {
      const response = await fetch(
        `https://api.opencagedata.com/geocode/v1/json?q=${encodeURIComponent(address)}&key=7f3db94804634683a492123ae49bad8b`
      );
      const data = await response.json();

      if (data && data.results && data.results.length > 0) {
        const geometry = data.results[0].geometry;
        if (geometry && typeof geometry.lat === 'number' && typeof geometry.lng === 'number') {
          const lat = geometry.lat;
          const lng = geometry.lng;
          const id = locationIdCounter++;
          const userLocationsSeries = chart.series.find(s => s.name === 'User Locations');

          userLocationsSeries.addPoint({
            name: address,
            lat,
            lon: lng,
            custom: { id }
          }, true, false);

          const point = userLocationsSeries.points[userLocationsSeries.points.length - 1];
          addedLocations.set(id, { name: address, point });
          renderLocationList();
          addressInput.value = '';
        } else {
          messageDiv.innerText = 'Geocoding failed: coordinates missing.';
        }
      } else {
        messageDiv.innerText = 'Address not found. Please try again.';
      }
    } catch (error) {
      console.error('Geocoding error:', error);
      messageDiv.innerText = 'An error occurred while geocoding.';
    }
  });

  document.getElementById('location-input').addEventListener('input', () => {
    document.getElementById('message').innerText = '';
  });

  function renderLocationList() {
    const list = document.getElementById('location-list');
    if (!list) return;
    list.innerHTML = '';

    addedLocations.forEach((info, id) => {
      const li = document.createElement('li');
      const span = document.createElement('span');
      const removeBtn = document.createElement('button');

      li.classList.add('location-item');
      span.textContent = info.name;
      removeBtn.textContent = 'x';
      removeBtn.setAttribute('aria-label', `Remove ${info.name}`);
      removeBtn.classList.add('remove-location');

      removeBtn.addEventListener('click', () => {
        if (info.point && typeof info.point.remove === 'function') info.point.remove();
        addedLocations.delete(id);
        renderLocationList();
      });

      li.appendChild(span);
      li.appendChild(removeBtn);
      list.appendChild(li);
    });
  }

  // =====================================================
  // Map export
  // =====================================================
  $('#download_button').click(() => chart.exportChartLocal({ type: 'image/png', filename: 'tornado_map' }));

  // =====================================================
  // Resize handling
  // =====================================================
  function resizeChart() {
    const container = document.getElementById('map-container');
    chart.setSize(container.offsetWidth, container.offsetHeight, false);
  }
  window.addEventListener('resize', resizeChart);

  // =====================================================
  // Keyboard navigation of the map
  // =====================================================
  const mapContainer = document.getElementById('map-container');
  mapContainer.focus();

  mapContainer.addEventListener('keydown', (e) => {
    let [lon, lat] = chart.mapView.center;
    switch (e.key) {
      case 'ArrowUp': chart.mapView.moveCenter([lon, lat + 2], true); break;
      case 'ArrowDown': chart.mapView.moveCenter([lon, lat - 2], true); break;
      case 'ArrowLeft': chart.mapView.moveCenter([lon - 2, lat], true); break;
      case 'ArrowRight': chart.mapView.moveCenter([lon + 2, lat], true); break;
      default: return;
    }
    e.preventDefault();
  });

  // =====================================================
  // Zoom controls
  // =====================================================
  document.getElementById('zoom-in').addEventListener('click', () => chart.mapView.zoomBy(1));
  document.getElementById('zoom-out').addEventListener('click', () => chart.mapView.zoomBy(-1));

  // =====================================================
  // Auto-enable both layers after init
  // =====================================================
  setTimeout(() => {
    const warningsCb = document.querySelector('.layer-checkbox[data-layer="warnings"]');
    if (!warningsCb) return;

    warningsCb.checked = true;

    // Set data first before making visible
    updateWarningSeries(currentGroupIndices);

    const polySeries = chart.series.find(s => s.name === 'Warning Polygons');
    if (polySeries) polySeries.setVisible(true, false);

    updatePopupPositions();
    chart.redraw();
  }, 800);

  // =====================================================
  // Inline info buttons for layer definitions
  // =====================================================
  document.querySelectorAll('.info-button').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const layer = btn.dataset.info;

      let message = '';
      if (layer === 'warnings') {
        message = 'Warning Polygons show the exact geographic area placed under a Tornado Warning by the National Weather Service.';
      }

      if (!message) return;

      const existingPopup = document.getElementById('layer-info-popup');
      if (existingPopup) existingPopup.remove();

      const popup = document.createElement('div');
      popup.id = 'layer-info-popup';
      popup.textContent = message;
      Object.assign(popup.style, {
        position: 'absolute',
        background: '#1b1b1b',
        color: 'white',
        padding: '10px 12px',
        borderRadius: '8px',
        fontSize: '13px',
        maxWidth: '220px',
        lineHeight: '1.4',
        boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
        zIndex: '9999',
        transition: 'opacity 0.2s',
        opacity: '0'
      });

      const rect = btn.getBoundingClientRect();
      popup.style.left = `${rect.right + 8}px`;
      popup.style.top = `${rect.top - 4 + window.scrollY}px`;

      document.body.appendChild(popup);
      requestAnimationFrame(() => popup.style.opacity = '1');

      setTimeout(() => popup.remove(), 5000);
      document.addEventListener('click', (ev) => {
        if (!popup.contains(ev.target) && ev.target !== btn) popup.remove();
      }, { once: true });
    });
  });

  // =====================================================
  // Severity legend info popup
  // =====================================================
  const legendInfoButton = document.getElementById('markers-legend-info');
  if (legendInfoButton) {
    legendInfoButton.addEventListener('click', (e) => {
      e.stopPropagation();
      const existingPopup = document.getElementById('legend-info-popup');
      if (existingPopup) existingPopup.remove();

      const popup = document.createElement('div');
      popup.id = 'legend-info-popup';
      popup.innerHTML = `
  <b>Understanding Tornado Warning Severity</b><br/><br/>
  <div style="display:grid;grid-template-columns:34px 1fr;align-items:center;row-gap:6px;margin-left:-15px;">

    <div style="text-align:center;-webkit-text-stroke:0.3px white;color:#FFA500;font-size:20px;transform:scale(2.2);line-height:20px;">●</div>
    <div><b>Radar Indicated</b>: Rotation detected on radar. No confirmed tornado on the ground yet.</div>

    <div style="text-align:center;-webkit-text-stroke:0.6px white;color:#FF4500;font-size:22px;transform:scale(1.1);line-height:20px;">▲</div>
    <div><b>Observed</b>: Tornado reported by trained spotters, emergency managers, or law enforcement.</div>

    <div style="text-align:center;-webkit-text-stroke:0.3px white;color:#CC0000;font-size:21px;transform:scale(2.2);line-height:20px;">■</div>
    <div><b>Confirmed</b>: A tornado has been confirmed on the ground by NWS assessment.</div>

    <div style="text-align:center;-webkit-text-stroke:0.6px white;color:#8B0000;font-size:22px;transform:scale(1.1);line-height:20px;">⬟</div>
    <div><b>PDS / Emergency</b>: Particularly Dangerous Situation or Tornado Emergency. Extreme threat to life and property.</div>

  </div>
  <br/>
  <em>Note: A single warning polygon may be updated multiple times as conditions evolve.</em>
`;

      Object.assign(popup.style, {
        position: 'absolute',
        background: 'rgba(35,35,35,0.96)',
        border: '1.5px solid rgba(255,255,255,0.25)',
        backdropFilter: 'blur(10px)',
        boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
        borderRadius: '8px',
        padding: '14px 16px',
        fontSize: '13.5px',
        lineHeight: '1.5',
        color: 'white',
        maxWidth: '320px',
        zIndex: '9999',
        transition: 'opacity 0.2s ease',
        opacity: '0'
      });

      document.body.appendChild(popup);

      const legendBox = document.getElementById('popup-markers');
      const rect = legendBox.getBoundingClientRect();
      const popupHeight = popup.offsetHeight;
      const popupTop = Math.max(rect.top + window.scrollY - popupHeight - 20, 20);
      const popupLeft = rect.left + window.scrollX + rect.width / 2 - popup.offsetWidth / 2;

      popup.style.top = `${popupTop}px`;
      popup.style.left = `${popupLeft}px`;

      requestAnimationFrame(() => popup.style.opacity = '1');

      setTimeout(() => popup.remove(), 15000);
      document.addEventListener('click', (ev) => {
        if (!popup.contains(ev.target) && ev.target !== legendInfoButton) popup.remove();
      }, { once: true });
    });
  }

  // =====================================================
  // Windback info popup
  // =====================================================
  const windbackInfoButton = document.getElementById('windback-info-button');
  if (windbackInfoButton) {
    windbackInfoButton.addEventListener('click', (e) => {
      e.stopPropagation();
      const existingPopup = document.getElementById('windback-info-popup');
      if (existingPopup) existingPopup.remove();

      const popup = document.createElement('div');
      popup.id = 'windback-info-popup';
      popup.textContent = 'Filter warnings by issue time to see how the outbreak evolved hour by hour.';

      Object.assign(popup.style, {
        position: 'absolute',
        background: 'rgba(35, 35, 35, 0.92)',
        border: '1.5px solid rgba(255, 255, 255, 0.4)',
        backdropFilter: 'blur(10px) brightness(1.05)',
        boxShadow: '0 4px 14px rgba(0, 0, 0, 0.6), 0 0 8px rgba(255, 255, 255, 0.08)',
        color: 'white',
        padding: '10px 12px',
        borderRadius: '8px',
        fontSize: '13px',
        maxWidth: '240px',
        lineHeight: '1.45',
        zIndex: '10001',
        transition: 'opacity 0.2s ease',
        opacity: '0'
      });

      const rect = windbackInfoButton.getBoundingClientRect();
      popup.style.left = `${rect.right + 8}px`;
      popup.style.top = `${rect.top - 4 + window.scrollY}px`;

      document.body.appendChild(popup);
      requestAnimationFrame(() => popup.style.opacity = '1');

      setTimeout(() => popup.remove(), 5000);
      document.addEventListener('click', (ev) => {
        if (!popup.contains(ev.target) && ev.target !== windbackInfoButton) popup.remove();
      }, { once: true });
    });
  }

})();
