var express = require("express");
var fetch = require("node-fetch");
var ffmpeg = require("fluent-ffmpeg");
var ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
var fs = require("fs");
var path = require("path");

ffmpeg.setFfmpegPath(ffmpegPath);

var app = express();
app.use(express.json({ limit: "50mb" }));

var OUTPUT_DIR = path.join(__dirname, "outputs");
var JOBS_DIR = path.join(__dirname, "jobs");

[OUTPUT_DIR, JOBS_DIR].forEach(function(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// --- Disk-based job persistence (survives Railway restarts) ---
function saveJob(jobId, data) {
  try {
    fs.writeFileSync(path.join(JOBS_DIR, jobId + ".json"), JSON.stringify(data));
  } catch (e) { console.log("saveJob error: " + e.message); }
}

function loadJob(jobId) {
  try {
    var f = path.join(JOBS_DIR, jobId + ".json");
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (e) { return null; }
}

// --- 20 curated kids cartoon clips from Mixkit (free, no API key) ---
var KIDS_CLIPS = [
  "https://assets.mixkit.co/videos/preview/mixkit-cartoon-hand-drawing-animation-2133-large.mp4",
  "https://assets.mixkit.co/videos/preview/mixkit-colorful-animation-of-a-planet-in-space-2139-large.mp4",
  "https://assets.mixkit.co/videos/preview/mixkit-animated-cartoon-rocket-in-space-2140-large.mp4",
  "https://assets.mixkit.co/videos/preview/mixkit-cute-cartoon-animal-characters-2141-large.mp4",
  "https://assets.mixkit.co/videos/preview/mixkit-colorful-clouds-sky-background-loop-2142-large.mp4",
  "https://assets.mixkit.co/videos/preview/mixkit-stars-and-planets-in-space-loop-2143-large.mp4",
  "https://assets.mixkit.co/videos/preview/mixkit-cartoon-forest-with-a-river-2144-large.mp4",
  "https://assets.mixkit.co/videos/preview/mixkit-cartoon-underwater-scene-2145-large.mp4",
  "https://assets.mixkit.co/videos/preview/mixkit-colorful-rainbow-background-loop-2146-large.mp4",
  "https://assets.mixkit.co/videos/preview/mixkit-animated-kids-background-2147-large.mp4",
  "https://assets.mixkit.co/videos/preview/mixkit-cartoon-boy-runs-happily-2148-large.mp4",
  "https://assets.mixkit.co/videos/preview/mixkit-animated-colorful-background-loop-2149-large.mp4",
  "https://assets.mixkit.co/videos/preview/mixkit-cartoon-girl-jumping-2150-large.mp4",
  "https://assets.mixkit.co/videos/preview/mixkit-cartoon-stars-falling-background-2151-large.mp4",
  "https://assets.mixkit.co/videos/preview/mixkit-cute-cartoon-bear-waving-2152-large.mp4",
  "https://assets.mixkit.co/videos/preview/mixkit-cartoon-sun-with-rays-loop-2153-large.mp4",
  "https://assets.mixkit.co/videos/preview/mixkit-kids-cartoon-background-loop-2154-large.mp4",
  "https://assets.mixkit.co/videos/preview/mixkit-colorful-cartoon-magic-background-2155-large.mp4",
  "https://assets.mixkit.co/videos/preview/mixkit-animated-cartoon-adventure-scene-2156-large.mp4",
  "https://assets.mixkit.co/videos/preview/mixkit-fun-cartoon-characters-playing-2157-large.mp4"
];

// Pick a random clip and verify it downloads — try up to 3 times
async function getWorkingClipUrl() {
  var tried = [];
  for (var i = 0; i < 3; i++) {
    var idx = Math.floor(Math.random() * KIDS_CLIPS.length);
    while (tried.indexOf(idx) !== -1) {
      idx = Math.floor(Math.random() * KIDS_CLIPS.length);
    }
    tried.push(idx);
    var url = KIDS_CLIPS[idx];
    try {
      console.log("Trying clip: " + url.substring(0, 80));
      var res = await fetch(url, { method: "HEAD", redirect: "follow" });
      if (res.ok) {
        console.log("Clip OK: " + url.substring(0, 80));
        return url;
      }
      console.log("Clip failed HEAD: " + res.status);
    } catch (e) {
      console.log("Clip HEAD error: " + e.message);
    }
  }
  // Final fallback — Pixabay if available
  return null;
}

async function getPixabayVideoUrl(theme) {
  var apiKey = process.env.PIXABAY_API_KEY;
  if (!apiKey) return null;
  var searchTerm = theme || "cartoon kids animation";
  var encoded = encodeURIComponent(searchTerm);
  var url = "https://pixabay.com/api/videos/?key=" + apiKey +
    "&q=" + encoded + "&video_type=animation&per_page=10&safesearch=true";
  try {
    var res = await fetch(url);
    if (!res.ok) return null;
    var data = await res.json();
    if (!data.hits || data.hits.length === 0) return null;
    var hit = data.hits[Math.floor(Math.random() * data.hits.length)];
    return (hit.videos.medium && hit.videos.medium.url) ||
           (hit.videos.small && hit.videos.small.url) || null;
  } catch (e) { return null; }
}

async function getFile(input, dest) {
  if (!input) throw new Error("Empty input for: " + dest);
  var inputStr = String(input).trim();

  if (inputStr.indexOf("http") !== 0) {
    var base64Data = inputStr
      .replace(/^data:audio\/mp3;base64,/, "")
      .replace(/^data:audio\/mpeg;base64,/, "")
      .replace(/^data:image\/jpeg;base64,/, "")
      .replace(/^data:image\/png;base64,/, "")
      .replace(/^data:video\/mp4;base64,/, "");
    try {
      fs.writeFileSync(dest, Buffer.from(base64Data, "base64"));
      console.log("Wrote base64: " + dest + " " + fs.statSync(dest).size + " bytes");
      return;
    } catch (e) { throw new Error("base64 decode failed: " + e.message); }
  }

  console.log("Downloading: " + inputStr.substring(0, 120));
  var res = await fetch(inputStr, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; KidsMerger/1.0)" },
    redirect: "follow"
  });
  if (!res.ok) throw new Error("Download failed: " + inputStr.substring(0, 80) + " status: " + res.status);

  return new Promise(function(resolve, reject) {
    var stream = fs.createWriteStream(dest);
    res.body.pipe(stream);
    stream.on("finish", function() {
      console.log("Downloaded: " + dest + " " + fs.statSync(dest).size + " bytes");
      resolve();
    });
    stream.on("error", reject);
  });
}

async function getAudioDuration(audioPath) {
  return new Promise(function(resolve) {
    ffmpeg.ffprobe(audioPath, function(err, metadata) {
      if (err || !metadata || !metadata.format || !metadata.format.duration) {
        console.log("Audio probe failed — defaulting 120s");
        resolve(120);
      } else {
        var dur = Math.ceil(metadata.format.duration) + 1;
        console.log("Audio duration: " + dur + "s");
        resolve(dur);
      }
    });
  });
}

async function loopVideoToLength(inputPath, outputPath, durationSecs) {
  console.log("Looping video to " + durationSecs + "s...");
  return new Promise(function(resolve, reject) {
    ffmpeg()
      .input(inputPath)
      .inputOptions(["-stream_loop -1"])
      .outputOptions([
        "-c:v libx264",
        "-t " + durationSecs,
        "-pix_fmt yuv420p",
        "-vf scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black",
        "-preset fast",
        "-crf 23",
        "-an"
      ])
      .output(outputPath)
      .on("end", function() {
        console.log("Loop done: " + fs.statSync(outputPath).size + " bytes");
        resolve();
      })
      .on("error", function(err) { reject(new Error("loopVideo: " + err.message)); })
      .run();
  });
}

// Add title text overlay + fun kids border to video
async function addTitleOverlay(inputPath, outputPath, titleText) {
  console.log("Adding title overlay: " + titleText);

  // Clean title — remove special chars that break FFmpeg drawtext
  var cleanTitle = titleText
    .replace(/['"\\:]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 50);

  // Split into two lines if long
  var words = cleanTitle.split(" ");
  var line1 = words.slice(0, Math.ceil(words.length / 2)).join(" ");
  var line2 = words.slice(Math.ceil(words.length / 2)).join(" ");

  // FFmpeg drawtext filter — big colorful title at top
  // Yellow text with black outline — classic kids style
  var drawtextLine1 = "drawtext=text='" + line1 + "'" +
    ":fontsize=54" +
    ":fontcolor=yellow" +
    ":bordercolor=black" +
    ":borderw=4" +
    ":x=(w-text_w)/2" +
    ":y=40" +
    ":alpha='if(lt(t,0.5),0,if(lt(t,1.5),t-0.5,1))'";

  var drawtextLine2 = line2 ? "drawtext=text='" + line2 + "'" +
    ":fontsize=54" +
    ":fontcolor=yellow" +
    ":bordercolor=black" +
    ":borderw=4" +
    ":x=(w-text_w)/2" +
    ":y=104" +
    ":alpha='if(lt(t,0.5),0,if(lt(t,1.5),t-0.5,1))'" : null;

  // Subtitle at bottom — white text
  var subtitle = "drawtext=text='A Kids Story Adventure'" +
    ":fontsize=32" +
    ":fontcolor=white" +
    ":bordercolor=black" +
    ":borderw=3" +
    ":x=(w-text_w)/2" +
    ":y=h-60" +
    ":alpha='if(lt(t,1),0,if(lt(t,2),t-1,1))'";

  var filterStr = drawtextLine2
    ? drawtextLine1 + "," + drawtextLine2 + "," + subtitle
    : drawtextLine1 + "," + subtitle;

  return new Promise(function(resolve, reject) {
    ffmpeg()
      .input(inputPath)
      .videoFilters(filterStr)
      .outputOptions([
        "-c:v libx264",
        "-c:a copy",
        "-preset fast",
        "-crf 22",
        "-pix_fmt yuv420p"
      ])
      .output(outputPath)
      .on("end", function() {
        console.log("Title overlay done: " + fs.statSync(outputPath).size + " bytes");
        resolve();
      })
      .on("error", function(err) {
        console.log("Title overlay failed (skipping): " + err.message);
        // If overlay fails just copy original — don't crash
        fs.copyFileSync(inputPath, outputPath);
        resolve();
      })
      .run();
  });
}

// Background processing
async function processVideo(jobId, voiceInput, videoInput, musicInput, storyTitle) {
  saveJob(jobId, { status: "processing", stage: "starting", started: Date.now() });

  var tmpDir = path.join(__dirname, "tmp_" + jobId);
  fs.mkdirSync(tmpDir, { recursive: true });

  var rawClipPath    = path.join(tmpDir, "raw_clip.mp4");
  var loopedPath     = path.join(tmpDir, "looped.mp4");
  var titledPath     = path.join(tmpDir, "titled.mp4");
  var voicePath      = path.join(tmpDir, "voice.mp3");
  var musicPath      = path.join(tmpDir, "music.mp3");
  var outputPath     = path.join(OUTPUT_DIR, "final_" + jobId + ".mp4");

  var serverUrl = process.env.RAILWAY_STATIC_URL || "kidscartoon-production.up.railway.app";
  if (serverUrl.indexOf("http") !== 0) serverUrl = "https://" + serverUrl;

  try {
    // 1 — Download voice
    console.log("[" + jobId + "] Step 1 — Voice...");
    saveJob(jobId, { status: "processing", stage: "downloading_voice" });
    await getFile(voiceInput, voicePath);
    if (fs.statSync(voicePath).size < 100) throw new Error("Voice too small");

    await new Promise(function(r) { setTimeout(r, 1000); });
    var audioDuration = await getAudioDuration(voicePath);
    if (audioDuration < 5) audioDuration = 120;
    console.log("[" + jobId + "] Duration: " + audioDuration + "s");

    // 2 — Get kids cartoon clip
    console.log("[" + jobId + "] Step 2 — Getting cartoon clip...");
    saveJob(jobId, { status: "processing", stage: "fetching_cartoon", duration_secs: audioDuration });

    // Try Mixkit first, then Pixabay as fallback
    var clipUrl = await getWorkingClipUrl();
    if (!clipUrl) {
      console.log("Mixkit failed — trying Pixabay...");
      clipUrl = await getPixabayVideoUrl("cartoon kids animation");
    }
    if (!clipUrl) throw new Error("Could not find any cartoon clip — all sources failed");

    console.log("[" + jobId + "] Downloading clip: " + clipUrl.substring(0, 80));
    await getFile(clipUrl, rawClipPath);
    if (fs.statSync(rawClipPath).size < 10000) throw new Error("Cartoon clip too small");

    // 3 — Loop clip to audio duration
    console.log("[" + jobId + "] Step 3 — Looping clip...");
    saveJob(jobId, { status: "processing", stage: "looping_video", duration_secs: audioDuration });
    await loopVideoToLength(rawClipPath, loopedPath, audioDuration);

    // 4 — Add title overlay
    console.log("[" + jobId + "] Step 4 — Adding title overlay...");
    saveJob(jobId, { status: "processing", stage: "adding_title", duration_secs: audioDuration });
    var titleText = storyTitle || "A Kids Adventure Story";
    await addTitleOverlay(loopedPath, titledPath, titleText);

    // 5 — Download music
    console.log("[" + jobId + "] Step 5 — Music...");
    saveJob(jobId, { status: "processing", stage: "downloading_music", duration_secs: audioDuration });
    var musicInput2 = musicInput || "https://files.freemusicarchive.org/storage-freemusicarchive-org/music/WFMU/Broke_For_Free/Directionless_EP/Broke_For_Free_-_01_-_Night_Owl.mp3";
    await getFile(musicInput2, musicPath);
    if (fs.statSync(musicPath).size < 100) throw new Error("Music too small");

    // 6 — FFmpeg final merge
    console.log("[" + jobId + "] Step 6 — Final merge...");
    saveJob(jobId, { status: "processing", stage: "merging", duration_secs: audioDuration });

    await new Promise(function(resolve, reject) {
      ffmpeg()
        .input(titledPath)
        .input(voicePath)
        .input(musicPath)
        .complexFilter([
          "[2:a]volume=0.18,afade=t=in:st=0:d=2[music]",
          "[1:a]volume=1.0[voice]",
          "[voice][music]amix=inputs=2:duration=first:dropout_transition=2[audio]"
        ])
        .outputOptions([
          "-map 0:v",
          "-map [audio]",
          "-c:v copy",
          "-c:a aac",
          "-b:a 192k",
          "-shortest",
          "-movflags faststart"
        ])
        .output(outputPath)
        .on("end", resolve)
        .on("error", function(err) { reject(new Error("FFmpeg merge: " + err.message)); })
        .run();
    });

    fs.rmSync(tmpDir, { recursive: true, force: true });

    var fileSizeMb = (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(1);
    var finalUrl = serverUrl + "/outputs/final_" + jobId + ".mp4";
    console.log("[" + jobId + "] Done — " + fileSizeMb + "MB — " + finalUrl);

    saveJob(jobId, {
      status: "done",
      final_video_url: finalUrl,
      file_size_mb: fileSizeMb,
      job_id: jobId,
      duration_secs: audioDuration,
      completed: Date.now()
    });

  } catch (err) {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    console.error("[" + jobId + "] FAILED: " + err.message);
    saveJob(jobId, { status: "failed", error: err.message, job_id: jobId });
  }
}

// --- Routes ---

app.get("/", function(req, res) {
  res.json({ status: "kids-merger running", version: "8.0" });
});

app.get("/test", function(req, res) {
  res.json({
    version: "8.0",
    pixabay_key: process.env.PIXABAY_API_KEY ? "SET" : "NOT SET",
    railway_url: process.env.RAILWAY_STATIC_URL || "NOT SET",
    port: process.env.PORT || "3000"
  });
});

app.get("/status/:jobId", function(req, res) {
  var job = loadJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found", status: "not_found" });
  res.json(job);
});

app.post("/merge", function(req, res) {
  var voiceInput = req.body.voice_url;
  var videoInput = req.body.video_url;
  var musicInput = req.body.music_url;
  var storyTitle = req.body.title || req.body.theme || "A Kids Adventure Story";

  console.log("--- Merge request v8.0 ---");
  console.log("voice_url:", voiceInput ? voiceInput.substring(0, 80) : "MISSING");
  console.log("title:", storyTitle);

  if (!voiceInput) {
    return res.status(400).json({ error: "Missing voice_url", status: "failed" });
  }

  var jobId = Date.now() + "_" + Math.random().toString(36).substr(2, 6);
  var serverUrl = process.env.RAILWAY_STATIC_URL || "kidscartoon-production.up.railway.app";
  if (serverUrl.indexOf("http") !== 0) serverUrl = "https://" + serverUrl;

  res.json({
    status: "processing",
    job_id: jobId,
    status_url: serverUrl + "/status/" + jobId,
    message: "Processing started. Check status_url in 5 minutes."
  });

  processVideo(jobId, voiceInput, videoInput, musicInput, storyTitle);
});

app.use("/outputs", express.static(OUTPUT_DIR));

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log("Kids merger v8.0 on port " + PORT);
});
