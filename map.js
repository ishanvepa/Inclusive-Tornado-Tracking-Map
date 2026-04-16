// =====================================================
// Inclusive Tornado Tracking Map — map.js
// =====================================================

// Custom symbol: pentagon (Tier 4 — PDS / Confirmed Emergency)
Highcharts.SVGRenderer.prototype.symbols.pentagon = function (x, y, w, h) {
  const centerX = x + w / 2;
  const centerY = y + h / 2;
  const scale = 1.25;
  const r = Math.min(w, h) / 2 * scale;
  const angle = Math.PI * 2 / 5;
  const path = [];

  for (let i = 0; i < 5; i++) {
    const theta = i * angle - Math.PI / 2;
    const px = centerX + r * Math.cos(theta);
    const py = centerY + r * Math.sin(theta);
    path.push(i === 0 ? 'M' : 'L', px, py);
  }
  path.push('Z');
  return path;
};

// =====================================================
// Severity Helpers
// =====================================================

/**
 * Derive a severity tier (1–4) from NWS alert properties.
 *
 * Tier 1 (circle, orange)   — Radar Indicated
 * Tier 2 (triangle, red)    — Observed by spotters / trained observers
 * Tier 3 (square, dark red) — Radar Confirmed (explicit tornadoDetection=CONFIRMED)
 * Tier 4 (pentagon, maroon) — PDS (Particularly Dangerous Situation) or Tornado Emergency
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

function tierToSymbol(tier) {
  if (tier >= 4) return 'pentagon';
  if (tier === 3) return 'square';
  if (tier === 2) return 'triangle';
  return 'circle';
}

function tierToColor(tier) {
  if (tier >= 4) return '#8B0000';  // maroon
  if (tier === 3) return '#CC0000';  // dark red
  if (tier === 2) return '#FF4500';  // orange-red
  return '#FFA500';                  // orange
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

/**
 * Approximate area of a polygon ring (in degree² units — only used for
 * relative comparison to drive sonification intensity).
 */
function polygonArea(ring) {
  let area = 0;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    area += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return Math.abs(area) / 2;
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
      const area = polygonArea(ring);

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
        area,
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
      zoom: initialMapZoom
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
      // 0: choropleth base map (US states)
      {
        name: 'Base map',
        nullColor: '#acb',
        legendSymbolColor: '#acb',
        borderColor: '#888',
        mapData: usa
      },
      // 1: OpenStreetMap tiles
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
      // 3: Centroid markers (mappoint series)
      {
        id: 'warning-markers',
        name: 'Severity Markers',
        type: 'mappoint',
        visible: false,
        zIndex: 3,
        dataLabels: { enabled: false },
        tooltip: {
          useHTML: true,
          hideDelay: 0,
          pointFormatter: function () {
            const w = this.custom && this.custom.warning;
            if (!w) return '';
            const onset = w.onset ? new Date(w.onset).toLocaleString() : '—';
            const expire = w.expires ? new Date(w.expires).toLocaleString() : '—';
            return `
              <b>${w.event}</b><br/>
              <b>Area:</b> ${w.areaDesc}<br/>
              <b>Severity:</b> <span style="color:${tierToColor(w.tier)}">■</span> ${tierToLabel(w.tier)}<br/>
              <b>Onset:</b> ${onset}<br/>
              <b>Expires:</b> ${expire}<br/>
              <b>Issued by:</b> ${w.senderName}<br/>
              ${w.instruction ? `<br/><em style="font-size:11px;">${w.instruction.replace(/\n/g, '<br/>')}</em>` : ''}
            `;
          }
        },
        data: []
      },
      // 4: User-added POI markers
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
    // Build explicit projected SVG paths. This avoids version-to-version
    // differences in how Highcharts projects GeoJSON polygons.
    const proj = chart?.mapView?.projection;

    const project = (lon, lat) => {
      if (proj && typeof proj.forward === 'function') {
        const out = proj.forward([lon, lat]);
        if (Array.isArray(out) && out.length >= 2) return out;
        if (out && typeof out.x === 'number' && typeof out.y === 'number') return [out.x, out.y];
      }
      // Fallback: treat lon/lat as x/y (may not align with tiles, but keeps something on-screen)
      return [lon, lat];
    };

    const ringToPath = (ring) => {
      if (!Array.isArray(ring) || ring.length < 3) return null;

      const closed = ring.slice();
      const a = closed[0];
      const b = closed[closed.length - 1];
      if (!b || a[0] !== b[0] || a[1] !== b[1]) closed.push(a);

      const path = [];
      for (let i = 0; i < closed.length; i++) {
        const pt = closed[i];
        if (!pt || pt.length < 2) continue;
        const [x, y] = project(pt[0], pt[1]);
        path.push(i === 0 ? 'M' : 'L', x, y);
      }
      path.push('Z');
      return path;
    };

    return indices.map((i) => {
      const w = warnings[i];
      const base = tierToPolygonColor(w.tier);

      const fill = (Highcharts.color)
        ? Highcharts.color(base).setOpacity(0.45).get('rgba')
        : 'rgba(255, 69, 0, 0.45)';

      return {
        name: w.areaDesc,
        path: ringToPath(w.ring),
        color: fill,
        borderColor: '#000000',
        borderWidth: 2.5,
        custom: { warning: w }
      };
    }).filter(p => Array.isArray(p.path) && p.path.length > 0);
  }

  function buildMarkerData(indices) {
    return indices.map(i => {
      const w = warnings[i];
      const { lon, lat } = w.centroid;
      return {
        lon,
        lat,
        name: w.areaDesc,
        marker: {
          symbol: tierToSymbol(w.tier),
          fillColor: tierToColor(w.tier),
          lineColor: '#000',
          lineWidth: 1,
          radius: 10
        },
        custom: { warning: w }
      };
    });
  }

  function updateWarningSeries(indices) {
    const polygonSeries = chart.series.find(s => s.name === 'Warning Polygons');
    const markerSeries = chart.series.find(s => s.name === 'Severity Markers');

    if (polygonSeries) polygonSeries.setData(buildPolygonData(indices), false);
    if (markerSeries) markerSeries.setData(buildMarkerData(indices), false);
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
  allItem.addEventListener('click', async () => {
    currentGroupKey = null;
    currentGroupIndices = warnings.map((_, i) => i);
    updateWarningSeries(currentGroupIndices);
    timeDropdown.style.display = 'none';

    if (window.Sonification && window.Sonification.getAutoPlay() && warnings.length > 0) {
      const bestWarning = warnings.reduce((a, b) => b.tier > a.tier ? b : a, warnings[0]);
      await window.Sonification.playPoint(bestWarning, 0.8);
    }
    updateExplain(null);
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
    const tierBadge = `<span style="color:${tierToColor(maxTier)}">■</span> `;
    item.innerHTML = `${tierBadge}${key} <small style="opacity:0.65">(${indices.length})</small>`;
    item.setAttribute('aria-label', `Select time group ${key}, ${indices.length} warning(s)`);

    const handleSelect = async () => {
      currentGroupKey = key;
      currentGroupIndices = indices;
      updateWarningSeries(currentGroupIndices);
      timeDropdown.style.display = 'none';

      if (window.Sonification && window.Sonification.getAutoPlay() && indices.length > 0) {
        // Play the highest-tier warning in this group
        const bestIdx = indices.reduce((a, b) => warnings[b].tier > warnings[a].tier ? b : a, indices[0]);
        await window.Sonification.playPoint(warnings[bestIdx], 0.8);
      }

      if (indices.length > 0) {
        const w = warnings[indices[0]];
        updateExplain(w, indices);
      }
    };

    item.addEventListener('click', handleSelect);
    item.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); await handleSelect(); }
    });

    timeDropdownItems.appendChild(item);
  });

  // =====================================================
  // Explain module integration
  // =====================================================
  function updateExplain(warning, groupIndices) {
    if (!window.Explain) return;
    if (!warning) {
      window.Explain.toggle();
      return;
    }
    const userData = getUserLocations();
    const explainData = {
      current: warning,
      previous: null,
      allPoints: groupIndices ? groupIndices.map(i => warnings[i]) : warnings,
      currentIndex: 0,
      stormName: `Tornado Warning — ${warning.areaDesc}`,
      userLocations: userData
    };
    window.Explain.update(explainData);
  }

  function getUserLocations() {
    const series = chart.series.find(s => s.name === 'User Locations');
    if (!series) return [];
    return series.points.map(p => ({ name: p.name || 'Unknown Location', lat: p.lat, lon: p.lon }));
  }

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
  setupToggle('sonification-button', 'sonification-popup');

  // What's happening button
  const whatsHappeningButton = document.getElementById('whats-happening-button');
  const explainPopup = document.getElementById('explain-popup');

  if (whatsHappeningButton && explainPopup) {
    whatsHappeningButton.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = explainPopup.style.display === 'block';

      document.querySelectorAll('.popup').forEach(p => p.style.display = 'none');
      document.querySelectorAll('.dropdown-menu').forEach(d => d.style.display = 'none');
      document.querySelectorAll('.header-button').forEach(btn => btn.classList.remove('active'));

      if (!isVisible) {
        explainPopup.style.display = 'block';
        whatsHappeningButton.classList.add('active');
        if (window.Explain) window.Explain.toggle();
      } else {
        whatsHappeningButton.blur();
      }
    });

    const explainCloseBtn = explainPopup.querySelector('.close-popup');
    if (explainCloseBtn) {
      explainCloseBtn.addEventListener('click', () => {
        explainPopup.style.display = 'none';
        whatsHappeningButton.classList.remove('active');
        whatsHappeningButton.blur();
      });
    }
  }

  // =====================================================
  // Sonification controls
  // =====================================================
  const autoSonifyCheckbox = document.getElementById('auto-sonify');
  const playCurrentBtn = document.getElementById('play-current-point');
  const playSequenceBtn = document.getElementById('play-sequence');
  const toggleStrings = document.getElementById('toggle-strings');
  const toggleWoodwinds = document.getElementById('toggle-woodwinds');
  const toggleSpatial = document.getElementById('toggle-spatial');
  const toggleTTS = document.getElementById('toggle-tts');

  if (autoSonifyCheckbox) autoSonifyCheckbox.addEventListener('change', function () { window.Sonification.setAutoPlay(this.checked); });
  if (toggleStrings) toggleStrings.addEventListener('change', function () { window.Sonification.setStringsEnabled(this.checked); });
  if (toggleWoodwinds) toggleWoodwinds.addEventListener('change', function () { window.Sonification.setWoodwindsEnabled(this.checked); });
  if (toggleSpatial) toggleSpatial.addEventListener('change', function () { window.Sonification.setSpatialEnabled(this.checked); });
  if (toggleTTS) toggleTTS.addEventListener('change', function () { window.Sonification.setTTSEnabled(this.checked); });

  if (playCurrentBtn) {
    playCurrentBtn.addEventListener('click', async () => {
      if (currentGroupIndices.length > 0) {
        const bestIdx = currentGroupIndices.reduce((a, b) =>
          warnings[b].tier > warnings[a].tier ? b : a, currentGroupIndices[0]);
        await window.Sonification.playPoint(warnings[bestIdx], 0.8);
      }
    });
  }

  if (playSequenceBtn) {
    playSequenceBtn.addEventListener('click', async function () {
      if (window.Sonification.isPlaying()) {
        window.Sonification.stop();
        this.textContent = '▶ Play All Warnings';
      } else {
        this.textContent = '⏹ Stop Sequence';
        const seq = currentGroupIndices.map(i => warnings[i]);
        await window.Sonification.playSequence(seq, 800, () => {
          playSequenceBtn.textContent = '▶ Play All Warnings';
        });
      }
    });
  }

  // Sonification info modal
  const infoButton = document.getElementById('sonification-info-button');
  const infoModal = document.getElementById('sonification-info-modal');
  const closeInfoBtn = document.getElementById('close-sonification-info');

  if (infoButton && infoModal && closeInfoBtn) {
    infoButton.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      infoModal.style.display = 'block';
    });
    closeInfoBtn.addEventListener('click', () => {
      infoModal.style.display = 'none';
      infoButton.focus();
    });
    document.addEventListener('click', (e) => {
      if (infoModal.style.display === 'block' &&
        !infoModal.contains(e.target) &&
        e.target !== infoButton &&
        !infoButton.contains(e.target)) {
        infoModal.style.display = 'none';
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && infoModal.style.display === 'block') {
        infoModal.style.display = 'none';
        infoButton.focus();
      }
    });
  }

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

      if (layerName === 'markers') {
        const markerSeries = chart.series.find(s => s.name === 'Severity Markers');
        const legend = document.getElementById('popup-markers');
        const legendCb = document.querySelector('.legend-subcheckbox[data-target="markers"]');
        const subOption = document.querySelector('.legend-suboption[data-parent="markers"]');

        if (markerSeries) markerSeries.setVisible(e.target.checked, false);

        if (e.target.checked) {
          if (legendCb) legendCb.checked = true;
          if (legend) legend.style.display = 'block';
          if (subOption) subOption.style.display = 'block';
        } else {
          if (legendCb) legendCb.checked = false;
          if (legend) legend.style.display = 'none';
          if (subOption) subOption.style.display = 'none';
        }
      }

      chart.redraw();
      updatePopupPositions();
    });
  });

  document.querySelectorAll('.legend-subcheckbox').forEach(subbox => {
    subbox.addEventListener('change', e => {
      const target = e.target.dataset.target;
      const popup = document.getElementById(`popup-${target}`);
      if (popup) popup.style.display = e.target.checked ? 'block' : 'none';
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
    const markersCb = document.querySelector('.layer-checkbox[data-layer="markers"]');
    if (!warningsCb || !markersCb) return;

    warningsCb.checked = true;
    markersCb.checked = true;

    // Set data first before making visible
    updateWarningSeries(currentGroupIndices);

    const polySeries = chart.series.find(s => s.name === 'Warning Polygons');
    const markerSeries = chart.series.find(s => s.name === 'Severity Markers');
    if (polySeries) polySeries.setVisible(true, false);
    if (markerSeries) markerSeries.setVisible(true, false);

    const legendCb = document.querySelector('.legend-subcheckbox[data-target="markers"]');
    const subOption = document.querySelector('.legend-suboption[data-parent="markers"]');
    const legendPopup = document.getElementById('popup-markers');
    if (legendCb) legendCb.checked = true;
    if (subOption) subOption.style.display = 'block';
    if (legendPopup) legendPopup.style.display = 'block';

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
      } else if (layer === 'markers') {
        message = 'Severity Markers are placed at the centroid of each warning polygon. Their shape encodes severity: circle = Radar Indicated, triangle = Observed, square = Confirmed, pentagon = PDS/Emergency.';
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
