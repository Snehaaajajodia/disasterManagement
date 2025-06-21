const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const app = express();
const port = 5000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const supabaseUrl = 'https://mekziqubwunobqhkqsxn.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1la3ppcXVid3Vub2JxaGtxc3huIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTA1MTM5MTksImV4cCI6MjA2NjA4OTkxOX0.vNPpDZR3Pt1-_4-yHWCxdHpya1MDMfWFHbum0BqI-IY';
const supabase = createClient(supabaseUrl, supabaseKey);

// In-memory storage
let disasters = [];
let helpOffers = [];

const GEMINI_API_KEY = 'AIzaSyCxNC98guIGwGY3STdAgMNw2eLmZhD6lEI';

// Twitter API integration (using v2 search API)
const TWITTER_BEARER_TOKEN = process.env.TWITTER_BEARER_TOKEN || '';
const fetchTweets = async (query) => {
  if (!TWITTER_BEARER_TOKEN) return [];
  try {
    const response = await axios.get('https://api.twitter.com/2/tweets/search/recent', {
      params: {
        query,
        max_results: 10,
        'tweet.fields': 'created_at,text,author_id',
      },
      headers: {
        'Authorization': `Bearer ${TWITTER_BEARER_TOKEN}`,
      },
    });
    return response.data.data || [];
  } catch (e) {
    console.log('Twitter API error:', e.message);
    return [];
  }
};

// Helper: Geocode location to lat/lng using Google Maps Geocoding API
async function geocodeLocation(location) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(location)}&key=${GEMINI_API_KEY}`;
  const res = await axios.get(url);
  if (res.data.results && res.data.results[0]) {
    const { lat, lng } = res.data.results[0].geometry.location;
    return { lat, lng };
  }
  return { lat: null, lng: null };
}

// Helper: Use Gemini to verify if two disasters are the same event
async function verifyWithGemini(newDisaster, existingDisaster) {
  // For demo, use a simple prompt to Gemini
  const prompt = `Are these two disaster events the same?\nEvent 1: ${JSON.stringify(newDisaster)}\nEvent 2: ${JSON.stringify(existingDisaster)}\nAnswer only 'yes' or 'no'.`;
  try {
    const response = await axios.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=' + GEMINI_API_KEY,
      {
        contents: [{ parts: [{ text: prompt }] }]
      }
    );
    const text = response.data.candidates[0].content.parts[0].text.trim().toLowerCase();
    return text.startsWith('yes');
  } catch (e) {
    return false;
  }
}

// Helper: Use Gemini to verify if a disaster is real (description and image)
async function verifyDisasterReal(disaster) {
  let prompt = `Is this a real disaster event?\nType: ${disaster.type}\nLocation: ${disaster.location}, ${disaster.state}, ${disaster.country}\nDescription: ${disaster.description}`;
  if (disaster.images && disaster.images.length > 0) {
    prompt += `\nImage (base64): ${disaster.images[0].slice(0, 100)}...`;
  }
  try {
    const response = await axios.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=' + GEMINI_API_KEY,
      {
        contents: [{ parts: [{ text: prompt }] }]
      }
    );
    const text = response.data.candidates[0].content.parts[0].text.trim().toLowerCase();
    console.log('Gemini real event verification:', text);
    return text.startsWith('yes');
  } catch (e) {
    console.log('Gemini error:', e.message);
    return false;
  }
}

// Get all disasters
app.get('/api/disasters', async (req, res) => {
  const { data, error } = await supabase.from('disasters').select('*').order('timestamp', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Report a disaster
app.post('/api/disasters', async (req, res) => {
  const { name, type, country, state, location, description, image } = req.body;
  const timestamp = new Date().toISOString();
  const { lat, lng } = await geocodeLocation(`${location}, ${state}, ${country}`);
  const images = image ? [image] : [];
  const reportCount = 1;

  // Twitter validation: search for recent tweets about the event
  const twitterQuery = `${type} ${location} ${state} ${country}`;
  const tweets = await fetchTweets(twitterQuery);
  const tweetsSummary = tweets.length > 0 ? `Found ${tweets.length} recent tweets about this event.` : 'No recent tweets found.';
  const twitterVerified = tweets.length > 0;
  if (tweets.length > 0) {
    console.log('Relevant tweets:', tweets.map(t => t.text));
  }

  // Check for similar event (fetch all disasters from Supabase)
  const { data: allDisasters } = await supabase.from('disasters').select('*');
  let matched = null;
  for (let d of allDisasters || []) {
    const isSame = await verifyWithGemini(
      { name, type, country, state, location, description },
      d
    );
    if (isSame) {
      matched = d;
      break;
    }
  }

  // Use Gemini to verify if this is a real event, include tweet summary
  const geminiVerified = await verifyDisasterReal({ name, type, country, state, location, description, images, tweetsSummary });
  const verificationStatus = (geminiVerified && twitterVerified) ? 'verified' : 'pending';
  if (!geminiVerified) {
    return res.status(400).json({ error: 'Gemini could not verify this as a real disaster event.' });
  }

  if (matched) {
    // Update the matched disaster in Supabase
    const updatedImages = matched.images ? [...matched.images, ...images] : images;
    const updateObj = {
      reportCount: (matched.reportCount || 1) + 1,
      timestamp,
      images: updatedImages,
      geminiVerified,
      twitterVerified,
      verificationStatus,
      tweetsSummary
    };
    console.log('Updating disaster:', updateObj);
    const { data: updated, error } = await supabase
      .from('disasters')
      .update(updateObj)
      .eq('id', matched.id)
      .select();
    console.log('Supabase update:', updated, error);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(updated[0]);
  }

  // New event: insert into Supabase
  const disaster = {
    name, type, country, state, location, description,
    lat, lng,
    images,
    timestamp,
    reportCount,
    geminiVerified,
    twitterVerified,
    verificationStatus,
    tweetsSummary
  };
  console.log('Inserting disaster:', disaster);
  const { data: inserted, error } = await supabase
    .from('disasters')
    .insert([disaster])
    .select();
  console.log('Supabase insert:', inserted, error);
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(inserted[0]);
});

// Get all help offers
app.get('/api/help', async (req, res) => {
  const { data, error } = await supabase.from('help_offers').select('*').order('id', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Offer help
app.post('/api/help', async (req, res) => {
  const help = { ...req.body, id: Date.now() };
  const { data, error } = await supabase.from('help_offers').insert([help]).select();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data[0]);
});

// Search help offers using Gemini
app.post('/api/help/search', async (req, res) => {
  const { query } = req.body;
  // Use Gemini to filter help offers for the query location
  const prompt = `Given the following help offers, which are relevant for someone searching for help in '${query}'?\nHelp offers: ${JSON.stringify(helpOffers)}\nReturn a JSON array of relevant offers.`;
  // New: Ask Gemini for government helpline numbers for the location
  const helplinePrompt = `What are the official government disaster helpline numbers and emergency contacts for '${query}' in India? Reply in JSON format: {\"helplines\": [ {\"agency\": string, \"number\": string, \"description\": string } ] }`;
  try {
    // Get help offers
    const offersResponse = await axios.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=' + GEMINI_API_KEY,
      {
        contents: [{ parts: [{ text: prompt }] }]
      }
    );
    const offersText = offersResponse.data.candidates[0].content.parts[0].text.trim();
    let offers = [];
    try {
      offers = JSON.parse(offersText);
    } catch {
      offers = [];
    }
    // Get helplines
    const helplineResponse = await axios.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=' + GEMINI_API_KEY,
      {
        contents: [{ parts: [{ text: helplinePrompt }] }]
      }
    );
    let helplines = [];
    try {
      const helplineJson = JSON.parse(helplineResponse.data.candidates[0].content.parts[0].text.trim());
      helplines = helplineJson.helplines || [];
    } catch {
      helplines = [];
    }
    res.json({ offers, helplines });
  } catch (e) {
    res.status(500).json({ error: 'Gemini error: ' + e.message });
  }
});

app.listen(port, () => {
  console.log(`Backend server running on http://localhost:${port}`);
}); 