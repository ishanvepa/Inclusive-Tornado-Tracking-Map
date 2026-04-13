// Explanation Modal Module
const Explain = (() => {
  // Cache to store explanations by timestamp
  const cache = new Map();
  
  // Current state
  let currentTimestamp = null;
  let isOpen = false;
  
  // DOM elements (initialized in init)
  let modal = null;
  let modalContent = null;
  let closeButton = null;
  let regenerateButton = null;
  
  // API configuration
  const API_BASE_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:3001'
    : '';  // Use relative URL in production

  /**
   * Initialize the explanation module
   */
  function init() {
    modal = document.getElementById('explain-popup');
    modalContent = document.getElementById('explain-content');
    closeButton = modal?.querySelector('.close-popup');
    regenerateButton = document.getElementById('explain-regenerate');
    
    if (!modal || !modalContent) {
      console.error('Explain modal elements not found');
      return;
    }
    
    // Set up accessibility attributes
    modalContent.setAttribute('aria-live', 'polite');
    modalContent.setAttribute('aria-atomic', 'true');
    
    // Close button handler
    if (closeButton) {
      closeButton.addEventListener('click', close);
    }
    
    // Regenerate button handler
    if (regenerateButton) {
      regenerateButton.addEventListener('click', () => {
        if (currentTimestamp) {
          // Clear cache for current timestamp and regenerate
          cache.delete(currentTimestamp);
          update(window.lastExplainData, true);
        }
      });
    }
    
    // Close on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen) {
        close();
      }
    });
    
    console.log('Explain module initialized');
  }
  
  /**
   * Calculate distance between two lat/lon points in miles using Haversine formula
   */
  function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 3958.8; // Earth's radius in miles
    const toRad = deg => deg * Math.PI / 180;
    
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }
  
  /**
   * Get direction name from bearing
   */
  function getDirectionFromBearing(bearing) {
    const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    const index = Math.round(bearing / 22.5) % 16;
    return directions[index];
  }
  
  /**
   * Calculate bearing between two lat/lon points
   */
  function calculateBearing(lat1, lon1, lat2, lon2) {
    const toRad = deg => deg * Math.PI / 180;
    const toDeg = rad => rad * 180 / Math.PI;
    
    const dLon = toRad(lon2 - lon1);
    const y = Math.sin(dLon) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
              Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
    
    let bearing = toDeg(Math.atan2(y, x));
    bearing = (bearing + 360) % 360;
    
    return bearing;
  }
  
  /**
   * Update the explanation for a selected storm point
   * @param {Object} data - Storm data
   * @param {Object} data.current - Current point data
   * @param {Object} data.previous - Previous point data (or null)
   * @param {Array} data.allPoints - All storm points
   * @param {number} data.currentIndex - Index of current point
   * @param {string} data.stormName - Name of the storm
   * @param {boolean} forceRegenerate - Force API call even if cached
   */
  async function update(data, forceRegenerate = false) {
    if (!modal || !modalContent) {
      console.error('Modal not initialized');
      return;
    }
    
    // Store data for regeneration
    window.lastExplainData = data;
    
    const { current, previous, allPoints, currentIndex, stormName, userLocations } = data;
    
    currentTimestamp = current.time;
    
    // Open modal
    open();
    
    // Check cache first
    if (!forceRegenerate && cache.has(currentTimestamp)) {
      renderExplanation(cache.get(currentTimestamp));
      return;
    }
    
    // Show loading state
    showLoading();
    
    try {
      // Calculate derived data
      const derived = {};
      
      if (previous) {
        derived.delta_vmax = current.vmax - previous.vmax;
        derived.delta_mslp = current.mslp - previous.mslp;
        derived.bearing_deg = calculateBearing(
          previous.lat, previous.lon,
          current.lat, current.lon
        );
      }
      
      if (allPoints && allPoints.length > 0) {
        derived.lifecycle_pct = currentIndex / (allPoints.length - 1);
      }
      
      // Calculate distances and bearings to user locations
      const poi_locations = [];
      if (userLocations && userLocations.length > 0) {
        userLocations.forEach(loc => {
          const distance = calculateDistance(current.lat, current.lon, loc.lat, loc.lon);
          const bearing = calculateBearing(current.lat, current.lon, loc.lat, loc.lon);
          const direction = getDirectionFromBearing(bearing);
          
          poi_locations.push({
            name: loc.name,
            distance_miles: Math.round(distance),
            direction: direction
          });
        });
      }
      
      // Check if we have uncertainty data (we don't by default)
      const has_uncertainty_data = false;
      
      // Build API payload
      const payload = {
        storm_name: stormName || 'Hurricane',
        current: {
          time: current.time,
          lat: current.lat,
          lon: current.lon,
          vmax: current.vmax,
          mslp: current.mslp,
          category: current.category
        },
        previous: previous ? {
          time: previous.time,
          lat: previous.lat,
          lon: previous.lon,
          vmax: previous.vmax,
          mslp: previous.mslp,
          category: previous.category
        } : null,
        derived,
        has_uncertainty_data,
        poi_locations: poi_locations
      };
      
      // Call API
      const response = await fetch(`${API_BASE_URL}/api/explain`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `API request failed with status ${response.status}`);
      }
      
      const explanation = await response.json();
      
      // Validate response structure
      if (!explanation.headline || !explanation.summary || !explanation.key_changes ||
          !explanation.uncertainty || !explanation.what_to_watch) {
        throw new Error('Invalid response structure from API');
      }
      
      // Cache the result
      cache.set(currentTimestamp, explanation);
      
      // Render the explanation
      renderExplanation(explanation);
      
    } catch (error) {
      console.error('Error fetching explanation:', error);
      showError(error.message);
    }
  }
  
  /**
   * Show loading spinner
   */
  function showLoading() {
    modalContent.setAttribute('aria-busy', 'true');
    modalContent.innerHTML = `
      <div class="explain-loading" role="status" aria-live="polite" aria-label="Generating explanation">
        <div class="spinner" aria-hidden="true"></div>
        <p>Generating explanation…</p>
      </div>
    `;
    
    if (regenerateButton) {
      regenerateButton.disabled = true;
    }
  }
  
  /**
   * Render the explanation in the modal
   */
  function renderExplanation(explanation) {
    modalContent.setAttribute('aria-busy', 'false');
    
    // Escape HTML to prevent XSS
    const escapeHtml = (text) => {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    };
    
    const html = `
      <div class="explain-section explain-headline">
        <h3>${escapeHtml(explanation.headline)}</h3>
      </div>
      
      <div class="explain-section">
        <p class="explain-summary">${escapeHtml(explanation.summary)}</p>
      </div>
      
      <div class="explain-section">
        <h4>Key Changes</h4>
        <ul class="explain-bullets">
          ${explanation.key_changes.bullets.map(bullet => 
            `<li>${escapeHtml(bullet)}</li>`
          ).join('')}
        </ul>
      </div>
      
      <div class="explain-section">
        <h4>Uncertainty</h4>
        <p>${escapeHtml(explanation.uncertainty)}</p>
      </div>
      
      <div class="explain-section">
        <h4>What to Watch Next</h4>
        <ul class="explain-bullets">
          ${explanation.what_to_watch.map(item => 
            `<li>${escapeHtml(item)}</li>`
          ).join('')}
        </ul>
      </div>
    `;
    
    modalContent.innerHTML = html;
    
    if (regenerateButton) {
      regenerateButton.disabled = false;
    }
  }
  
  /**
   * Show error message
   */
  function showError(message) {
    modalContent.setAttribute('aria-busy', 'false');
    modalContent.innerHTML = `
      <div class="explain-error" role="alert" aria-live="assertive">
        <p><strong>Error:</strong> ${message}</p>
        <button id="explain-retry" class="explain-retry-button">Retry</button>
      </div>
    `;
    
    // Add retry handler
    const retryButton = document.getElementById('explain-retry');
    if (retryButton) {
      retryButton.addEventListener('click', () => {
        if (window.lastExplainData) {
          update(window.lastExplainData, true);
        }
      });
    }
    
    if (regenerateButton) {
      regenerateButton.disabled = false;
    }
  }
  
  /**
   * Open the modal
   */
  function open() {
    if (modal) {
      modal.style.display = 'block';
      isOpen = true;
      // Trap focus in modal for accessibility
      modal.focus();
    }
  }
  
  /**
   * Close the modal
   */
  function close() {
    if (modal) {
      modal.style.display = 'none';
      isOpen = false;
    }
  }
  
  /**
   * Toggle modal visibility
   */
  function toggle() {
    if (isOpen) {
      close();
    } else if (window.lastExplainData) {
      update(window.lastExplainData);
    } else {
      // No timestamp selected yet, show helpful message
      open();
      showPlaceholder();
    }
  }
  
  /**
   * Show placeholder message when no timestamp is selected
   */
  function showPlaceholder() {
    modalContent.setAttribute('aria-busy', 'false');
    modalContent.innerHTML = `
      <div class="explain-placeholder" role="status" aria-live="polite">
        <p><strong>No timestamp selected</strong></p>
        <p>Please select a timestamp from the <strong>Windback Feature</strong> to see an AI-generated explanation of what's happening at that moment in the storm.</p>
        <p style="margin-top: 16px; font-size: 13px; color: rgba(255, 255, 255, 0.7);">💡 Tip: Click the down arrow (▼) button to open the windback feature and choose a time point.</p>
      </div>
    `;
    
    if (regenerateButton) {
      regenerateButton.disabled = true;
    }
  }
  
  // Public API
  return {
    init,
    update,
    open,
    close,
    toggle
  };
})();

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => Explain.init());
} else {
  Explain.init();
}

// Make it globally accessible
window.Explain = Explain;
