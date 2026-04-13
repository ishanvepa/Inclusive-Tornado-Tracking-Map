const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3002;  // Use 3002 to avoid clash with hurricane server

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Explanation endpoint
app.post('/api/explain', async (req, res) => {
  try {
    const { storm_name, current, previous, derived, has_uncertainty_data, poi_locations } = req.body;

    if (!storm_name || !current) {
      return res.status(400).json({ error: 'Missing required fields: storm_name and current are required' });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'OpenAI API key not configured' });
    }

    const systemPrompt = `You are generating the content for a "What's happening?" modal in an inclusive tornado warning tracking tool.

This modal is an INTERPRETIVE LAYER — not a forecast, warning, or technical report.
Your goal is to help people understand what the tornado warning data means for them right now,
regardless of their background, education level, language familiarity, numeracy, or ability.

CORE PRINCIPLES (must follow):
- Extreme inclusivity: write so no one is left behind.
- Accessibility, clarity, and relevance matter more than technical precision.
- Do NOT assume prior knowledge of tornado warnings, maps, or weather models.
- Do NOT invent impacts, risks, or safety claims not supported by the data.
- Do NOT give prescriptive safety instructions (e.g., evacuate now).

WRITING GUIDELINES:
- Target a 5th–6th grade reading level.
- Use plain language first; explain technical terms briefly only if needed.
- Use people-first, inclusive language (e.g., "people in this area…").
- Acknowledge uncertainty and correct common misunderstandings.
- Be calm, non-alarmist, and respectful of diverse lived experiences.

WHAT'S HAPPENING CONTEXT:
- This is a Tornado Warning data point. It represents an area under an active or recent NWS tornado warning.
- The "severity tier" reflects detection confidence: Radar Indicated < Observed < Confirmed < PDS/Emergency.

LOCATION AWARENESS:
${poi_locations && poi_locations.length > 0 ? `- User has marked specific locations — make these CENTRAL to your explanation.
- Explain what the warning's proximity means in everyday terms for EACH location.
- Use qualitative distance language (e.g., "nearby", "a few miles away", "well outside the warning area").
- Provide location-specific, actionable context in key_changes and what_to_watch.` : '- No specific locations marked by user. Focus on general warning context.'}

STRUCTURE REQUIREMENTS:
Return ONLY valid JSON in the following structure:

{
  "headline": "Short, plain-language headline (max 10 words)",
  "summary": "2–3 sentences explaining what the warning means, why it matters, and what it means for people near the area. Lead with relevance, not jargon.",
  "key_changes": {
    "bullets": [
      "Plain-language description of the warning severity and what it means.",
      "Explanation of the affected area and who might be impacted.",
      "Location-aware interpretation (if user locations are provided)."
    ]
  },
  "uncertainty": "1–2 sentences explaining what the warning tier uncertainty means in clear language.",
  "what_to_watch": [
    "One inclusive, non-prescriptive thing people can monitor related to the warning.",
    "One location-aware thing to watch that respects different access, mobility, language, or alert preferences."
  ]
}

CONTENT CONSTRAINTS:
- Use ONLY the provided warning and location data.
- Do NOT imply danger, safety, or impacts unless explicitly supported by the input data.
- Your output should help people feel informed and oriented — not overwhelmed or excluded.`;

    const userPrompt = `Storm/Warning Name: ${storm_name}
Current warning data:
- Area: ${current.areaDesc || 'Unknown'}
- Event: ${current.event || 'Tornado Warning'}
- Severity: ${current.severity || 'Unknown'}
- Certainty: ${current.certainty || 'Unknown'}
- Urgency: ${current.urgency || 'Unknown'}
- Severity Tier: ${current.tier || 1} (1=Radar Indicated, 2=Observed, 3=Confirmed, 4=PDS/Emergency)
- Issued by: ${current.senderName || 'NWS'}
- Onset: ${current.onset || 'Unknown'}
- Expires: ${current.expires || 'Unknown'}
- Description: ${(current.description || '').slice(0, 400)}

${poi_locations && poi_locations.length > 0 ? `User-marked locations:
${poi_locations.map(loc => `- ${loc.name}: ${loc.distance_miles} miles ${loc.direction} of the warning centroid`).join('\n')}` : ''}

Generate the explanation.`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.7,
        max_tokens: 800
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('OpenAI API error:', errorData);
      return res.status(response.status).json({ error: 'OpenAI API request failed', details: errorData });
    }

    const data = await response.json();
    const content = data.choices[0]?.message?.content;

    if (!content) return res.status(500).json({ error: 'No content received from OpenAI' });

    let explanation;
    try {
      explanation = JSON.parse(content);
    } catch (parseError) {
      console.error('Failed to parse OpenAI response:', content);
      return res.status(500).json({ error: 'Invalid JSON response from AI', raw: content });
    }

    if (!explanation.headline || !explanation.summary || !explanation.key_changes ||
        !explanation.uncertainty || !explanation.what_to_watch) {
      return res.status(500).json({ error: 'Invalid response structure from AI', data: explanation });
    }

    res.json(explanation);

  } catch (error) {
    console.error('Error in /api/explain:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// Helper function to convert bearing to direction
function getBearingDirection(bearing) {
  const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const index = Math.round(bearing / 22.5) % 16;
  return directions[index];
}

// Start server
app.listen(PORT, () => {
  console.log(`Tornado map server running on http://localhost:${PORT}`);
  console.log(`OpenAI API key ${process.env.OPENAI_API_KEY ? 'configured' : 'NOT configured - set OPENAI_API_KEY in .env'}`);
});
