// =====================================================
// Tornado Alert Sonification Engine using Tone.js
// =====================================================

// --- Audio graph (bus & FX) ---
const master  = new Tone.Gain().toDestination();
const mainLPF = new Tone.Filter({ type: 'lowpass',  frequency: 8000, Q: 0.7 }).connect(master);
const mainHPF = new Tone.Filter({ type: 'highpass', frequency: 50,   Q: 0.7 }).connect(mainLPF);
const panBus  = new Tone.Panner(0).connect(mainHPF);
const reverb  = new Tone.Reverb({ decay: 2.5, wet: 0.15 }).connect(panBus);

// --- Sonification state ---
const sonificationState = {
  isPlaying:       false,
  autoPlay:        true,
  sequenceLoop:    null,
  currentIndex:    0,
  previousTier:    null,  // Track previous tier for TTS
  // Sound layer toggles
  enableStrings:   true,   // Severity → Alert tone
  enableWoodwinds: true,   // Area size → Intensity
  enableBrass:     true,   // Tier → Warning motif (internal, mapped from strings)
  enableSpatial:   true,   // Position → Panning
  enableTTS:       true    // Text-to-speech severity announcements
};

// --- Helper: derive tier from a warning data object ---
// (the warning objects passed here have a .tier property set by map.js)
function getTier(dataPoint) {
  return (typeof dataPoint.tier === 'number') ? Math.max(1, Math.min(4, dataPoint.tier)) : 1;
}

// --- Spatial helpers (US bounding box) ---
function panFromLon(lon) {
  const min = -125, max = -65;
  const t = Math.max(0, Math.min(1, (lon - min) / (max - min)));
  return t * 2 - 1;  // -1 (left) to +1 (right)
}

function hpfFromLat(lat) {
  const min = 24, max = 50;
  const t = Math.max(0, Math.min(1, (lat - min) / (max - min)));
  return 50 + t * 800;
}

// --- Severity → pitch and density ---
function stringFreqFromTier(tier) {
  // Higher tier = lower, more ominous pitch
  const freqs = [220, 165, 110, 82.4];  // A3, E3, A2, E2
  return freqs[Math.min(tier - 1, 3)];
}

function woodwindNoteCount(area) {
  // area is in degree² units; typical small warning ≈ 0.01–0.5, large ≈ 1+
  const clamped = Math.max(0.001, Math.min(2, isFinite(area) ? area : 0.1));
  return Math.round(2 + (clamped / 2) * 12); // 2–14 notes
}

function woodwindGain(area) {
  const clamped = Math.max(0.001, Math.min(2, isFinite(area) ? area : 0.1));
  return 0.15 + (clamped / 2) * 0.55;
}

// Alert motifs per tier (semitone intervals from root)
const alertMotifs = {
  1: [0],
  2: [0, 5],
  3: [0, 3, 7],
  4: [0, 2, 3, 6, 10]
};

function brassVolume(tier) {
  return Math.min(1, 0.3 + (tier - 1) * 0.18);
}

// --- Text-to-speech for tier changes ---
function speakTier(tier) {
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance();
    const messages = {
      1: 'Radar Indicated Tornado Warning',
      2: 'Observed Tornado Warning',
      3: 'Confirmed Tornado Warning',
      4: 'Tornado Emergency — Particularly Dangerous Situation'
    };
    utterance.text   = messages[tier] || 'Tornado Warning';
    utterance.rate   = 1.8;
    utterance.pitch  = 1.0;
    utterance.volume = 1;
    window.speechSynthesis.speak(utterance);
  }
}

// --- Voice synthesis functions ---
function playStrings(tier, dur) {
  const baseFreq = stringFreqFromTier(tier);

  const env = new Tone.AmplitudeEnvelope({
    attack:  0.05,
    decay:   0.4,
    sustain: Math.min(0.9, 0.3 + (tier - 1) * 0.2),
    release: 0.3
  }).connect(panBus);

  const filt = new Tone.Filter({
    type: 'lowpass',
    frequency: 1200,
    Q: 0.4
  }).connect(env);

  const osc = new Tone.Oscillator({
    frequency: baseFreq,
    type: 'sawtooth'
  }).connect(filt);

  osc.start();
  env.triggerAttackRelease(dur * 0.95);

  // Extra dissonant growl for Tier 3 & 4
  if (tier >= 3) {
    const detuneSemis = 1.5;
    const freq2 = baseFreq * Math.pow(2, detuneSemis / 12);
    const env2 = new Tone.AmplitudeEnvelope({
      attack:  0.05,
      decay:   0.4,
      sustain: Math.min(0.8, 0.2 + (tier - 1) * 0.15),
      release: 0.25
    }).connect(panBus);

    const filt2 = new Tone.Filter({ type: 'lowpass', frequency: 1000, Q: 0.5 }).connect(env2);
    const osc2  = new Tone.Oscillator({ frequency: freq2, type: 'sawtooth' }).connect(filt2);
    osc2.start();
    env2.triggerAttackRelease(dur * 0.9);
    osc2.stop('+' + dur);
  }

  osc.stop('+' + dur);
}

function playWoodwinds(area, dur) {
  if (!isFinite(area)) return;

  const notes = woodwindNoteCount(area);
  const g     = woodwindGain(area);
  const synth = new Tone.Synth({
    oscillator: { type: 'triangle' },
    envelope:   { attack: 0.01, decay: 0.08, sustain: 0.1, release: 0.05 }
  }).connect(new Tone.Gain(g).connect(reverb));

  const scale  = [0, 2, 4, 7, 9];
  const baseHz = 660;

  for (let i = 0; i < notes; i++) {
    const t    = (i / notes) * (dur * 0.9);
    const idx  = Math.floor((i * 1.7) % scale.length);
    const freq = baseHz * Math.pow(2, scale[idx] / 12);
    synth.triggerAttackRelease(freq, 0.06, '+' + t);
  }

  setTimeout(() => synth.dispose(), dur * 1000 + 50);
}

function playBrass(tier, dur) {
  const motif = alertMotifs[tier] || alertMotifs[1];
  const vol   = brassVolume(tier);

  const gain = new Tone.Gain(vol).connect(panBus);
  const filt = new Tone.Filter({ type: 'lowpass', frequency: 1800, Q: 0.6 }).connect(gain);
  const synth = new Tone.Synth({
    oscillator: { type: tier >= 3 ? 'square' : 'sawtooth' },
    envelope:   { attack: 0.01, decay: 0.12, sustain: 0.0, release: 0.08 }
  }).connect(filt);

  const baseHz  = 220;
  const stepDur = Math.max(0.06, Math.min(0.18, dur / Math.max(1, motif.length + 1)));

  for (let i = 0; i < motif.length; i++) {
    synth.triggerAttackRelease(
      baseHz * Math.pow(2, motif[i] / 12),
      stepDur * 0.9,
      '+' + (i * stepDur)
    );
  }

  setTimeout(() => synth.dispose(), dur * 1000 + 50);
}

// --- Main performance function ---
async function performPoint(dataPoint, duration = 0.8) {
  await Tone.start();

  const tier = getTier(dataPoint);
  const dur  = duration;

  // Apply spatial positioning
  if (sonificationState.enableSpatial) {
    const lon = dataPoint.centroid ? dataPoint.centroid.lon : (dataPoint.lon || -96);
    const lat = dataPoint.centroid ? dataPoint.centroid.lat : (dataPoint.lat || 38);
    panBus.pan.rampTo(panFromLon(lon), 0.08);
    mainHPF.frequency.rampTo(hpfFromLat(lat), 0.1);
  } else {
    panBus.pan.rampTo(0, 0.08);
    mainHPF.frequency.rampTo(50, 0.1);
  }

  // TTS on tier change
  if (sonificationState.enableTTS) {
    if (sonificationState.previousTier === null || tier !== sonificationState.previousTier) {
      speakTier(tier);
    }
    sonificationState.previousTier = tier;
  }

  // Sound layers
  if (sonificationState.enableStrings) {
    playStrings(tier, dur);
  }

  const area = isFinite(dataPoint.area) ? dataPoint.area : 0.1;
  if (sonificationState.enableWoodwinds) {
    playWoodwinds(area, dur);
  }
  if (sonificationState.enableBrass) {
    playBrass(tier, dur);
  }
}

// --- Public API ---
window.Sonification = {
  playPoint: async function (dataPoint, duration = 0.8) {
    await performPoint(dataPoint, duration);
  },

  playSequence: async function (dataPoints, intervalMs = 800, onComplete = null) {
    await Tone.start();
    sonificationState.isPlaying     = true;
    sonificationState.currentIndex  = 0;

    const play = async () => {
      if (!sonificationState.isPlaying || sonificationState.currentIndex >= dataPoints.length) {
        sonificationState.isPlaying    = false;
        sonificationState.currentIndex = 0;
        if (onComplete) onComplete();
        return;
      }
      const point = dataPoints[sonificationState.currentIndex];
      await performPoint(point, intervalMs / 1000);
      sonificationState.currentIndex++;
      sonificationState.sequenceLoop = setTimeout(play, intervalMs);
    };

    play();
  },

  stop: function () {
    sonificationState.isPlaying    = false;
    sonificationState.currentIndex = 0;
    sonificationState.previousTier = null;
    if (sonificationState.sequenceLoop) {
      clearTimeout(sonificationState.sequenceLoop);
      sonificationState.sequenceLoop = null;
    }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  },

  getAutoPlay:  function ()        { return sonificationState.autoPlay; },
  setAutoPlay:  function (enabled) { sonificationState.autoPlay = enabled; },
  isPlaying:    function ()        { return sonificationState.isPlaying; },

  setStringsEnabled:   function (enabled) { sonificationState.enableStrings   = enabled; },
  setWoodwindsEnabled: function (enabled) { sonificationState.enableWoodwinds = enabled; },
  setBrassEnabled:     function (enabled) { sonificationState.enableBrass     = enabled; },
  setSpatialEnabled:   function (enabled) { sonificationState.enableSpatial   = enabled; },
  setTTSEnabled:       function (enabled) {
    sonificationState.enableTTS = enabled;
    if (!enabled && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  },

  getLayerStates: function () {
    return {
      strings:   sonificationState.enableStrings,
      woodwinds: sonificationState.enableWoodwinds,
      brass:     sonificationState.enableBrass,
      spatial:   sonificationState.enableSpatial,
      tts:       sonificationState.enableTTS
    };
  }
};
