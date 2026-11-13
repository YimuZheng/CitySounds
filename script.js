// Official NYPD Calls for Service (Year to Date), NYC Open Data.
// No API key or extra JavaScript library required.
const API = "https://data.cityofnewyork.us/resource/n2zq-pubd.json";
const BOROUGHS = ["MANHATTAN", "BROOKLYN", "QUEENS", "BRONX", "STATEN ISLAND"];

const boroughInput = document.getElementById("borough");
const dateInput = document.getElementById("date");
const eventCount = document.getElementById("eventCount");
const tempo = document.getElementById("tempo");
const playButton = document.getElementById("playButton");
const playText = document.getElementById("playText");
const playIcon = document.getElementById("playIcon");
const statusText = document.getElementById("status");
const beatRing = document.getElementById("beatRing");

let counts = null;               // Count for each borough on the selected date
let audioContext = null;
let timer = null;
let beatAnimation = null;
let beatNumber = 0;
let playing = false;
let requestNumber = 0;
const dateCache = new Map();     // Avoid fetching the same day twice

function setStatus(message, error = false) {
  statusText.textContent = message;
  statusText.classList.toggle("error", error);
}

// Make an API request and read its JSON response.
async function getJSON(params) {
  const url = `${API}?${new URLSearchParams(params)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(response.status === 429 ? "Too many requests. Try again shortly." : `API error ${response.status}`);
  }
  return response.json();
}

function nextDate(dateString, days) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Fixed mapping across dates and boroughs. The higher range is deliberately
// more sensitive so 3,000 and 4,000 events sound noticeably different.
function countToBPM(count) {
  if (count <= 0) return 0;
  if (count <= 3000) return Math.round(60 + 50 * count / 3000);
  return Math.round(Math.min(210, 110 + 40 * (count - 3000) / 1000));
}

// Request one day's five borough totals in ONE query.
async function fetchCounts(date) {
  const tomorrow = nextDate(date, 1);
  const where =
    `create_date >= '${date}T00:00:00' AND ` +
    `create_date < '${tomorrow}T00:00:00' AND ` +
    "disp_ts IS NOT NULL AND cad_evnt_id IS NOT NULL AND " +
    `boro_nm IN (${BOROUGHS.map(b => `'${b}'`).join(",")})`;

  const rows = await getJSON({
    "$select": "boro_nm, count(distinct cad_evnt_id) AS events",
    "$where": where,
    "$group": "boro_nm",
    "$limit": "10"
  });

  if (!Array.isArray(rows)) throw new Error("Unexpected API response");
  if (rows.length === 0) return null; // No published records for this date

  const result = Object.fromEntries(BOROUGHS.map(b => [b, 0]));
  for (const row of rows) {
    if (BOROUGHS.includes(row.boro_nm)) {
      const count = Number(row.events);
      if (!Number.isFinite(count) || count < 0) throw new Error("Unexpected count in API response");
      result[row.boro_nm] = count;
    }
  }
  return result;
}

function showSelectedBorough() {
  if (counts === null) {
    eventCount.textContent = "—";
    tempo.textContent = "—";
    playButton.disabled = true;
    stopBeat();
    return;
  }

  const count = counts[boroughInput.value];
  const bpm = countToBPM(count);
  eventCount.textContent = count.toLocaleString("en-US");
  tempo.textContent = String(bpm);
  playButton.disabled = bpm === 0;

  if (playing) startBeat(); // Refresh the rhythm when borough changes
}

async function loadDate() {
  const date = dateInput.value;
  if (!date) return;
  const currentRequest = ++requestNumber;
  stopBeat();
  counts = null;
  showSelectedBorough();
  setStatus("Loading dispatch records…");

  try {
    const result = dateCache.has(date) ? dateCache.get(date) : await fetchCounts(date);
    if (currentRequest !== requestNumber) return; // Ignore an older, slower request
    dateCache.set(date, result);
    counts = result;
    showSelectedBorough();
    if (result === null) {
      setStatus("No published dispatch records for this date.");
    } else {
      setStatus("Recorded NYPD dispatch events · Daily total");
    }
  } catch (error) {
    if (currentRequest !== requestNumber) return;
    setStatus(error.message || "Unable to load data. Try another date.", true);
  }
}

// Get the available date range from the official dataset.
async function initialize() {
  try {
    const rows = await getJSON({
      "$select": "min(create_date) AS earliest, max(create_date) AS latest"
    });
    const earliest = rows?.[0]?.earliest?.slice(0, 10);
    const latest = rows?.[0]?.latest?.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(earliest) || !/^\d{4}-\d{2}-\d{2}$/.test(latest)) {
      throw new Error("No date range returned");
    }

    dateInput.min = earliest;
    dateInput.max = latest;
    // Avoid a potentially incomplete final date in the latest publication.
    const prior = nextDate(latest, -1);
    dateInput.value = prior >= earliest ? prior : latest;
  } catch (error) {
    // 2026-01-01 is confirmed in the public source; users can still test the app.
    dateInput.min = "2026-01-01";
    dateInput.value = "2026-01-01";
    setStatus("Date range unavailable; using Jan 1, 2026.", true);
  }

  boroughInput.disabled = false;
  dateInput.disabled = false;
  await loadDate();
}

// One synthetic kick, used for both regular beats and softer extra hits.
// Web Audio can schedule a hit slightly in the future with accurate timing.
function playKick(when, level = 0.65, duration = 0.23, pulse = true) {
  if (!audioContext) return;
  const oscillator = audioContext.createOscillator();
  const volume = audioContext.createGain();

  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(150, when);
  oscillator.frequency.exponentialRampToValueAtTime(48, when + duration * 0.6);

  volume.gain.setValueAtTime(0.001, when);
  volume.gain.exponentialRampToValueAtTime(level, when + 0.006);
  volume.gain.exponentialRampToValueAtTime(0.001, when + duration);

  oscillator.connect(volume);
  volume.connect(audioContext.destination);
  oscillator.start(when);
  oscillator.stop(when + duration + 0.01);
  oscillator.onended = () => { oscillator.disconnect(); volume.disconnect(); };

  if (pulse) {
    beatRing.classList.remove("hit");
    void beatRing.offsetWidth; // Restart the small visual pulse
    beatRing.classList.add("hit");
    clearTimeout(beatAnimation);
    beatAnimation = setTimeout(() => beatRing.classList.remove("hit"), 110);
  }
}

function playRhythmBeat() {
  if (!audioContext || !counts) return;
  const count = counts[boroughInput.value];
  const bpm = countToBPM(count);
  if (bpm === 0) return;

  const now = audioContext.currentTime;
  playKick(now);

  const extraHit = (count >= 5000 && beatNumber % 4 !== 2) ||
    (count >= 3500 && beatNumber % 2 === 1) ||
    (count >= 2200 && beatNumber % 4 === 3);

  if (extraHit) {
    // A quieter, shorter "dum" halfway to the next main beat.
    playKick(now + 30 / bpm, 0.23, 0.12, false);
  }
  beatNumber++;
}

function stopBeat() {
  if (timer !== null) clearInterval(timer);
  timer = null;
  beatNumber = 0;
  playing = false;
  playText.textContent = "Play beat";
  playIcon.textContent = "▶";
  beatRing.classList.remove("hit");
  clearTimeout(beatAnimation);
}

async function startBeat() {
  const bpm = counts ? countToBPM(counts[boroughInput.value]) : 0;
  stopBeat();
  if (bpm === 0) return;

  try {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    await audioContext.resume();
    playing = true;
    playText.textContent = "Stop beat";
    playIcon.textContent = "■";
    playRhythmBeat();
    timer = setInterval(playRhythmBeat, 60000 / bpm);
  } catch (error) {
    stopBeat();
    setStatus("Audio is unavailable in this browser.", true);
  }
}

boroughInput.addEventListener("change", showSelectedBorough);
dateInput.addEventListener("change", loadDate);
playButton.addEventListener("click", () => {
  if (playing) stopBeat();
  else startBeat();
});

initialize();
